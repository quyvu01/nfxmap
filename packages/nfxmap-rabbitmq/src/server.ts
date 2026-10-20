import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DotNetKeyNames,
    type ErrorLogger,
    type QueryHandler,
    type RequestServer,
    WireResponder,
} from 'nfxmap';
import type { AmqpChannel, AmqpConnection, AmqpMessage } from './amqp.js';
import { fromAmqpHeaders, RabbitMqNames } from './names.js';

/** FxMap's `ChannelPoolSize`. */
export const DEFAULT_CHANNEL_POOL_SIZE = 5;
/** FxMap's `MaxConcurrentProcessing`: the unacknowledged requests of each channel. */
export const DEFAULT_MAX_CONCURRENT_PROCESSING = 128;

export interface RabbitMqServerOptions {
    /** How long a handler may take before the request fails, in milliseconds (default 30 seconds). */
    readonly timeoutMs?: number;
    /** How many channels consume the queue (default 5, FxMap's `ChannelPoolSize`). */
    readonly channelPoolSize?: number;
    /** How many requests each channel answers at once (default 128, FxMap's `SetMaxConcurrentProcessing`). */
    readonly maxConcurrentProcessing?: number;
    /** Where the failed requests and replies are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Answers the requests for the keys this service owns over RabbitMQ (FxMap's RabbitMqServer): it declares the queue of
 * the service (`fxmap-rpc-queue-<application name>`) and a direct exchange per key, bound to it, then consumes the
 * queue on `channelPoolSize` channels. Each request is answered with a `Result` on its reply queue, with its
 * correlation id, then acknowledged.
 *
 * The server stops, and {@link whenStopped} rejects, when RabbitMQ cancels its consumers (its queue was deleted) or
 * closes a consumer channel (an error, or the connection closed); {@link start} declares the queue again.
 *
 * The application name must differ between services: two services with the same name share one queue, and each gets
 * the requests of the other.
 *
 * ```ts
 * const server = new RabbitMqServer(connection, 'user-service', [new InMemoryQueryHandler(new UserConfig(), users)]);
 * await server.start();
 * ```
 */
export class RabbitMqServer implements RequestServer {
    /** The queue this server consumes. */
    readonly queue: string;
    readonly channelPoolSize: number;
    readonly maxConcurrentProcessing: number;
    private readonly responder: WireResponder;
    private readonly logger: ErrorLogger;
    private run: Run | null = null;
    private starting: Promise<void> | null = null;
    private stopped: Promise<void> = Promise.resolve();

    /**
     * @param applicationName the name of the service, which names its queue (FxMap uses the entry assembly's name)
     * @param handlers        the handlers of the keys this service owns
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(private readonly connection: AmqpConnection, applicationName: string, handlers: Iterable<QueryHandler>,
                options: RabbitMqServerOptions = {}) {
        if (connection === null || connection === undefined) throw new TypeError('The RabbitMQ connection is required.');
        this.queue = RabbitMqNames.queue(applicationName);
        this.channelPoolSize = positive(options.channelPoolSize ?? DEFAULT_CHANNEL_POOL_SIZE, 'channelPoolSize');
        this.maxConcurrentProcessing = positive(options.maxConcurrentProcessing ?? DEFAULT_MAX_CONCURRENT_PROCESSING,
            'maxConcurrentProcessing');
        this.logger = options.logger ?? console;
        this.responder = new WireResponder(handlers, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, this.logger);
    }

    /** The keys this server answers for. */
    get keys(): string[] {
        return this.responder.keys;
    }

    /** The exchanges this server binds to its queue, by key. */
    get exchanges(): Map<string, string> {
        return new Map(this.keys.map(key => [key, RabbitMqNames.exchange(key)]));
    }

    /**
     * Declares the queue and the exchanges, and starts consuming; does nothing when the server already runs or has no
     * key.
     *
     * @throws Error when RabbitMQ refuses a declaration, or the connection is closed
     */
    start(): Promise<void> {
        if (this.run !== null || this.keys.length === 0) return Promise.resolve();
        this.starting ??= this.open().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    isRunning(): boolean {
        return this.run !== null;
    }

    /**
     * The current run: it ends when the server is closed, or fails when RabbitMQ cancels a consumer or closes a
     * consumer channel.
     */
    whenStopped(): Promise<void> {
        return this.stopped;
    }

    /** Stops consuming; the requests being answered still get their reply. The queue and the exchanges stay. */
    async close(): Promise<void> {
        await this.starting?.catch(() => undefined);
        const run = this.run;
        if (run === null) return;
        this.run = null;
        run.closing = true;
        // Cancelled first, so that no new request comes while the ones being answered finish
        await Promise.all(run.consumers.map(({ channel, consumerTag }) =>
            channel.cancel(consumerTag).catch(() => undefined)));
        await Promise.allSettled([...run.answering]);
        await closeAll(run.consumers.map(consumer => consumer.channel), this.logger);
        run.end();
    }

    private async open(): Promise<void> {
        const declare = await this.connection.createChannel();
        declare.on('error', () => undefined);
        try {
            // Not durable, as FxMap declares them: a declaration that differs from FxMap's would be refused
            await declare.assertQueue(this.queue, { durable: false, exclusive: false, autoDelete: false });
            for (const exchange of this.exchanges.values()) {
                await declare.assertExchange(exchange, 'direct', { durable: false, autoDelete: false });
                await declare.bindQueue(this.queue, exchange, RabbitMqNames.ROUTING_KEY);
            }
        } finally {
            await declare.close().catch(() => undefined);
        }

        let end!: () => void;
        let fail!: (error: unknown) => void;
        const stopped = new Promise<void>((resolve, reject) => {
            end = resolve;
            fail = reject;
        });
        // The end of a run that nobody waits for is not an unhandled rejection
        stopped.catch(() => undefined);
        const run: Run = { consumers: [], answering: new Set(), closing: false, end, fail: () => undefined };
        run.fail = (error: unknown) => {
            if (run.closing) return;
            run.closing = true;
            if (this.run === run) this.run = null;
            this.logger.error(`The FxMap RabbitMQ server of ${this.queue} stopped.`, error);
            void closeAll(run.consumers.map(consumer => consumer.channel), this.logger).then(() => fail(error));
        };

        try {
            for (let i = 0; i < this.channelPoolSize; i++) {
                const channel = await this.connection.createChannel();
                channel.on('error', (error: unknown) => run.fail(error));
                channel.on('close', () => run.fail(new Error(`A RabbitMQ consumer channel of ${this.queue} closed.`)));
                run.consumers.push({ channel, consumerTag: '' });
                const consumer = run.consumers[run.consumers.length - 1];
                await channel.prefetch(this.maxConcurrentProcessing);
                const { consumerTag } = await channel.consume(this.queue, message => {
                    if (message === null)
                        run.fail(new Error(`RabbitMQ cancelled the consumer of ${this.queue} (was the queue deleted?).`));
                    else this.receive(run, channel, message);
                }, { noAck: false });
                consumer.consumerTag = consumerTag;
            }
        } catch (error) {
            run.closing = true;
            await closeAll(run.consumers.map(consumer => consumer.channel), this.logger);
            throw error;
        }
        this.run = run;
        this.stopped = stopped;
    }

    private receive(run: Run, channel: AmqpChannel, message: AmqpMessage): void {
        const { properties } = message;
        // FxMap finds the key by the type of the message, the assembly-qualified name of the key
        const key = DotNetKeyNames.fromAssemblyQualifiedName(properties.type)
            ?? RabbitMqNames.keyOfExchange(message.fields.exchange);
        const answering = this.responder.answer(key, message.content, fromAmqpHeaders(properties.headers))
            .then(reply => {
                if (properties.replyTo)
                    channel.publish('', properties.replyTo, reply, { correlationId: properties.correlationId });
                channel.ack(message);
            })
            .catch(error => this.logger.error(`The reply for ${key} could not be sent.`, error))
            .finally(() => run.answering.delete(answering));
        run.answering.add(answering);
    }
}

interface Run {
    readonly consumers: { readonly channel: AmqpChannel; consumerTag: string }[];
    readonly answering: Set<Promise<void>>;
    closing: boolean;
    readonly end: () => void;
    fail: (error: unknown) => void;
}

async function closeAll(channels: readonly AmqpChannel[], logger: ErrorLogger): Promise<void> {
    for (const channel of channels) {
        try {
            await channel.close();
        } catch (error) {
            // Already closed, by the broker or with its connection
            if (!/closed/i.test(error instanceof Error ? error.message : String(error)))
                logger.error('A RabbitMQ consumer channel did not close.', error);
        }
    }
}

function positive(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number, at least 1.`);
    return value;
}
