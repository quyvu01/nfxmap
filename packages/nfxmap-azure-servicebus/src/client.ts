import { randomUUID } from 'node:crypto';
import type {
    ServiceBusClient,
    ServiceBusReceivedMessage,
    ServiceBusSender,
    ServiceBusSessionReceiver,
} from '@azure/service-bus';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ErrorLogger,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    PendingReplies,
    type RequestClient,
    WireMessages,
} from 'nfxmap';
import {
    bodyOf,
    checkTimeout,
    correlationIdOf,
    errorCode,
    isMissingEntity,
    isSent,
    SESSION_LOCK_RENEWAL_MS,
} from './messages.js';
import { ServiceBusNames } from './names.js';

export interface ServiceBusRequestClientOptions {
    /** The prefix of the queue names (FxMap's `TopicPrefix`), none by default. */
    readonly topicPrefix?: string;
    /** How long a request may wait for its reply, in milliseconds (default 30 seconds, FxMap's DefaultRequestTimeout). */
    readonly timeoutMs?: number;
    /** Where the lost reply sessions are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Sends requests over Azure Service Bus (FxMap's OpenAzureServiceBusClient and `AddAzureServiceBus`): each request goes
 * to the request queue of its key ({@link ServiceBusNames}) with a correlation id, the reply queue of the key as
 * `replyTo`, the session id of this client, and the headers of the mapping call as application properties, but the W3C
 * trace context, which FxMap sends as bytes. The owner replies on the reply queue in the same session, which this
 * client holds: the clients of a key share its reply queue, each reading its own session.
 *
 * A key whose queues do not exist (no service owns it) fails at once. The owner creates the queues. The
 * `ServiceBusClient` belongs to the caller; {@link close} closes only the senders and receivers of this client.
 *
 * ```ts
 * const client = new ServiceBusRequestClient(new ServiceBusClient(connectionString));
 * ```
 */
export class ServiceBusRequestClient implements RequestClient {
    readonly transport = 'azureservicebus';
    readonly timeoutMs: number;
    readonly topicPrefix: string | null;
    /** The session this client reads its replies in. */
    readonly sessionId = randomUUID();
    private readonly logger: ErrorLogger;
    private readonly pending = new PendingReplies();
    private readonly senders = new Map<string, ServiceBusSender>();
    private readonly replySessions = new Map<string, Promise<ServiceBusSessionReceiver>>();
    private closed = false;

    constructor(private readonly client: ServiceBusClient, options: ServiceBusRequestClientOptions = {}) {
        if (client === null || client === undefined) throw new TypeError('The Service Bus client is required.');
        this.timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        this.topicPrefix = options.topicPrefix || null;
        this.logger = options.logger ?? console;
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        this.ensureOpen();
        const replyQueue = ServiceBusNames.replyQueue(key, this.topicPrefix);
        const correlationId = randomUUID();
        const applicationProperties: Record<string, string> = {};
        for (const [name, value] of Object.entries(context.headers))
            if (value !== null && value !== undefined && isSent(name)) applicationProperties[name] = value;
        const reply = this.pending.register(correlationId, key, this.timeoutMs);
        let sent = false;
        try {
            await this.sender(ServiceBusNames.requestQueue(key, this.topicPrefix)).sendMessages({
                body: WireMessages.writeRequest(request),
                correlationId,
                replyTo: replyQueue,
                sessionId: this.sessionId,
                applicationProperties,
            });
            sent = true;
        } catch (error) {
            this.pending.fail(correlationId, isMissingEntity(error) ? new NoHandlerForDistributedKeyError(key)
                : new Error(`The request for ${key} could not be sent to Service Bus.`, { cause: error }));
        }
        // Read after the request is sent: a key without queues fails on the send, and the reply waits in the session
        if (sent) this.listen(replyQueue).catch(error => this.pending.fail(correlationId,
            new Error(`The replies of ${key} could not be received from ${replyQueue}.`, { cause: error })));
        return WireMessages.readResult(await reply);
    }

    /** How many requests wait for their reply. */
    get pendingRequests(): number {
        return this.pending.size;
    }

    /** Fails the requests that still wait, releases the sessions and closes the senders. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pending.failAll(new Error('The Service Bus request client is closed.'));
        const sessions = [...this.replySessions.values()];
        this.replySessions.clear();
        const senders = [...this.senders.values()];
        this.senders.clear();
        await Promise.all([
            ...sessions.map(session => session.then(receiver => receiver.close(), () => undefined)),
            ...senders.map(sender => sender.close()),
        ].map(closing => closing.catch(error => this.logger.error('A Service Bus link did not close.', error))));
    }

    private ensureOpen(): void {
        if (this.closed) throw new Error('The Service Bus request client is closed.');
    }

    private sender(queue: string): ServiceBusSender {
        let sender = this.senders.get(queue);
        if (sender === undefined) {
            sender = this.client.createSender(queue);
            this.senders.set(queue, sender);
        }
        return sender;
    }

    // Reads the session of this client on the reply queue, once; again after the session was lost
    private listen(replyQueue: string): Promise<ServiceBusSessionReceiver> {
        let session = this.replySessions.get(replyQueue);
        if (session === undefined) {
            session = this.acceptReplySession(replyQueue);
            this.replySessions.set(replyQueue, session);
            const accepting = session;
            session.catch(() => {
                if (this.replySessions.get(replyQueue) === accepting) this.replySessions.delete(replyQueue);
            });
        }
        return session;
    }

    private async acceptReplySession(replyQueue: string): Promise<ServiceBusSessionReceiver> {
        const receiver = await this.client.acceptSession(replyQueue, this.sessionId, {
            maxAutoLockRenewalDurationInMs: SESSION_LOCK_RENEWAL_MS,
            skipParsingBodyAsJson: true,
        });
        if (this.closed) {
            await receiver.close().catch(() => undefined);
            throw new Error('The Service Bus request client is closed.');
        }
        receiver.subscribe({
            processMessage: async (message: ServiceBusReceivedMessage) => {
                this.pending.complete(correlationIdOf(message.correlationId), bodyOf(message.body));
                await receiver.completeMessage(message);
            },
            processError: async ({ error }) => {
                if (this.closed) return;
                const code = errorCode(error);
                // The session is gone: it is accepted again on the next request
                if (code === 'SessionLockLost' || code === 'MessagingEntityNotFound' || receiver.isClosed) {
                    this.logger.error(`The replies of ${replyQueue} could not be received; the session is accepted `
                        + 'again on the next request.', error);
                    void this.dropReplySession(replyQueue, receiver);
                }
            },
        }, { autoCompleteMessages: false });
        return receiver;
    }

    private async dropReplySession(replyQueue: string, receiver: ServiceBusSessionReceiver): Promise<void> {
        const current = this.replySessions.get(replyQueue);
        if (current !== undefined && await current.catch(() => null) === receiver) this.replySessions.delete(replyQueue);
        await receiver.close().catch(() => undefined);
    }
}
