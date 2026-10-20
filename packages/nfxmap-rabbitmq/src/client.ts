import { randomUUID } from 'node:crypto';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DotNetKeyNames,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    PendingReplies,
    type RequestClient,
    WireMessages,
} from 'nfxmap';
import { type AmqpChannel, type AmqpConnection, type AmqpMessage, isNotFound } from './amqp.js';
import { RabbitMqNames, toAmqpHeaders } from './names.js';

export interface RabbitMqRequestClientOptions {
    /** How long a request may wait for its reply, in milliseconds (default 30 seconds, FxMap's DefaultRequestTimeout). */
    readonly timeoutMs?: number;
}

/**
 * Sends requests over RabbitMQ (FxMap's RabbitMqRequestClient and `AddRabbitMq`): each request is published to the
 * exchange of its key ({@link RabbitMqNames}) with a correlation id, the reply queue of this client, the
 * assembly-qualified name of the key as type, and the headers of the mapping call; the owner replies on the reply
 * queue, `fxmap-reply-<uuid>`, exclusive to this client.
 *
 * A key whose exchange does not exist (no service declared it), or whose exchange routes to no queue, fails at once.
 * The connection belongs to the caller; {@link close} closes only the channels of the client.
 *
 * ```ts
 * const connection = await connect('amqp://localhost');
 * const client = new RabbitMqRequestClient(connection);
 * ```
 */
export class RabbitMqRequestClient implements RequestClient {
    readonly transport = 'rabbitmq';
    readonly timeoutMs: number;
    private readonly pending = new PendingReplies();
    private readonly knownExchanges = new Set<string>();
    // Named here, not by the broker, as FxMap does: the name stays the same when the reply channel is opened again
    private readonly replyQueue = `${RabbitMqNames.REPLY_QUEUE_PREFIX}-${randomUUID().replaceAll('-', '')}`;
    private replyChannel: Promise<AmqpChannel> | null = null;
    private replyGeneration = 0;
    private publishChannel: Promise<AmqpChannel> | null = null;
    private closed = false;

    constructor(private readonly connection: AmqpConnection, options: RabbitMqRequestClientOptions = {}) {
        if (connection === null || connection === undefined) throw new TypeError('The RabbitMQ connection is required.');
        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
        this.timeoutMs = timeoutMs;
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        this.ensureOpen();
        const exchange = RabbitMqNames.exchange(key);
        if (!(await this.exchangeExists(exchange))) throw new NoHandlerForDistributedKeyError(key);
        await this.replies();
        const publisher = await this.publisher();
        this.ensureOpen();

        const correlationId = randomUUID();
        const reply = this.pending.register(correlationId, key, this.timeoutMs);
        try {
            publisher.publish(exchange, RabbitMqNames.ROUTING_KEY, WireMessages.writeRequest(request), {
                correlationId,
                replyTo: this.replyQueue,
                type: DotNetKeyNames.assemblyQualifiedName(key),
                headers: toAmqpHeaders(context.headers),
                mandatory: true,
            });
        } catch (error) {
            this.pending.fail(correlationId, new Error(`The request for ${key} could not be published to RabbitMQ.`,
                { cause: error }));
        }
        return WireMessages.readResult(await reply);
    }

    /** How many requests wait for their reply. */
    get pendingRequests(): number {
        return this.pending.size;
    }

    /** Closes the channels of the client and fails the requests that still wait. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pending.failAll(new Error('The RabbitMQ request client is closed.'));
        const channels = [this.publishChannel, this.replyChannel];
        this.publishChannel = null;
        this.replyChannel = null;
        for (const channel of channels) {
            if (channel === null) continue;
            try {
                await (await channel).close();
            } catch {
                // The channel or the connection may be closed already
            }
        }
    }

    private ensureOpen(): void {
        if (this.closed) throw new Error('The RabbitMQ request client is closed.');
    }

    // A passive declare on a channel of its own: the broker closes the channel when the exchange does not exist
    private async exchangeExists(exchange: string): Promise<boolean> {
        if (this.knownExchanges.has(exchange)) return true;
        const channel = await this.connection.createChannel();
        let open = true;
        channel.on('error', () => undefined);
        channel.on('close', () => {
            open = false;
        });
        try {
            await channel.checkExchange(exchange);
            this.knownExchanges.add(exchange);
            return true;
        } catch (error) {
            if (isNotFound(error)) return false;
            throw error;
        } finally {
            if (open) await channel.close().catch(() => undefined);
        }
    }

    private replies(): Promise<AmqpChannel> {
        if (this.replyChannel === null) {
            const generation = ++this.replyGeneration;
            this.replyChannel = this.openReplyChannel(generation);
        }
        return this.replyChannel;
    }

    private async openReplyChannel(generation: number): Promise<AmqpChannel> {
        let channel: AmqpChannel | undefined;
        try {
            channel = await this.connection.createChannel();
            const opened = channel;
            opened.on('error', () => undefined);
            // The exclusive queue goes with its channel: the replies that were not received are lost
            opened.on('close', () => this.replyChannelLost(generation, 'The RabbitMQ reply channel closed.'));
            await opened.assertQueue(this.replyQueue, { durable: false, exclusive: true, autoDelete: true });
            await opened.consume(this.replyQueue, message => {
                if (message !== null) this.receive(opened, message);
                else {
                    // The broker cancelled the consumer (the queue was deleted): the channel receives no more replies
                    this.replyChannelLost(generation, 'RabbitMQ cancelled the consumer of the reply queue.');
                    void opened.close().catch(() => undefined);
                }
            }, { noAck: false });
            return opened;
        } catch (error) {
            if (generation === this.replyGeneration) this.replyChannel = null;
            await channel?.close().catch(() => undefined);
            throw error;
        }
    }

    private replyChannelLost(generation: number, reason: string): void {
        if (generation !== this.replyGeneration || this.replyChannel === null) return;
        this.replyChannel = null;
        this.pending.failAll(new Error(reason));
    }

    private receive(channel: AmqpChannel, message: AmqpMessage): void {
        // The content is a Buffer of its own: the caller may read it later
        this.pending.complete(message.properties.correlationId, message.content);
        try {
            channel.ack(message);
        } catch {
            // The channel closed: the reply was received all the same
        }
    }

    private publisher(): Promise<AmqpChannel> {
        this.publishChannel ??= this.openPublishChannel();
        return this.publishChannel;
    }

    private async openPublishChannel(): Promise<AmqpChannel> {
        let channel: AmqpChannel;
        try {
            channel = await this.connection.createChannel();
        } catch (error) {
            this.publishChannel = null;
            throw error;
        }
        channel.on('error', () => undefined);
        const opened = channel;
        channel.on('close', () => {
            if (this.publishChannel !== null) void this.publishChannel.then(current => {
                if (current === opened) this.publishChannel = null;
            }, () => undefined);
        });
        // A request that no queue receives comes back: it fails at once instead of timing out
        channel.on('return', (returned: AmqpMessage) => {
            const exchange = returned.fields.exchange;
            this.pending.fail(returned.properties.correlationId,
                new NoHandlerForDistributedKeyError(RabbitMqNames.keyOfExchange(exchange) ?? exchange));
        });
        return channel;
    }
}
