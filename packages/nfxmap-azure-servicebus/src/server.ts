import type {
    ServiceBusClient,
    ServiceBusReceivedMessage,
    ServiceBusSender,
    ServiceBusSessionReceiver,
} from '@azure/service-bus';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ErrorLogger,
    type QueryHandler,
    type RequestServer,
    WireResponder,
} from 'nfxmap';
import {
    bodyOf,
    checkTimeout,
    correlationIdOf,
    errorCode,
    isMissingEntity,
    serviceBusHeaders,
    SESSION_LOCK_RENEWAL_MS,
} from './messages.js';
import { ServiceBusNames } from './names.js';

/** FxMap's default `MaxConcurrentSessions`. */
export const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;
/** How long a session without requests stays with a reader before it takes another. */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 1_000;
// How long a reader waits after an unexpected failure before it takes a session again
const PAUSE_MS = 1_000;

/** What the server needs of a `ServiceBusAdministrationClient`: creating the queues that do not exist. */
export interface ServiceBusQueueAdministration {
    queueExists(queueName: string): Promise<boolean>;
    createQueue(queueName: string, options: { requiresSession: boolean }): Promise<unknown>;
}

export interface ServiceBusServerOptions {
    /**
     * Creates the queues that do not exist when the server starts (a `ServiceBusAdministrationClient`); without it they
     * must exist, as on the Service Bus emulator, which declares them in its configuration.
     */
    readonly administration?: ServiceBusQueueAdministration;
    /** The prefix of the queue names (FxMap's `TopicPrefix`), none by default. */
    readonly topicPrefix?: string;
    /** How long a handler may take before the request fails, in milliseconds (default 30 seconds). */
    readonly timeoutMs?: number;
    /** How many sessions (clients) are answered at once on each request queue (default 8, as in FxMap). */
    readonly maxConcurrentSessions?: number;
    /** How long a session without requests stays with a reader before it takes another, in milliseconds (default 1 s). */
    readonly sessionIdleTimeoutMs?: number;
    /** Where the failed requests, replies and sessions are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Answers the requests for the keys this service owns over Azure Service Bus (FxMap's AzureServiceBusServer): for each
 * key it creates the request and reply queues ({@link ServiceBusNames}, both requiring sessions) when an
 * administration client is given and they do not exist, then reads the request queue in `maxConcurrentSessions`
 * sessions at once, one request at a time in each, as FxMap's session processor does. Each request is answered with a
 * `Result` on the queue of its `replyTo`, with its correlation id and session id, then completed.
 *
 * The server stops, and {@link whenStopped} rejects, when a request queue does not exist (it was deleted); {@link start}
 * creates it again with an administration client.
 *
 * ```ts
 * const server = new ServiceBusServer(new ServiceBusClient(connectionString), [new InMemoryQueryHandler(new UserConfig(), users)],
 *     { administration: new ServiceBusAdministrationClient(connectionString) });
 * await server.start();
 * ```
 */
export class ServiceBusServer implements RequestServer {
    readonly topicPrefix: string | null;
    readonly maxConcurrentSessions: number;
    readonly sessionIdleTimeoutMs: number;
    private readonly administration: ServiceBusQueueAdministration | null;
    private readonly responder: WireResponder;
    private readonly logger: ErrorLogger;
    private run: Run | null = null;
    private starting: Promise<void> | null = null;
    private stopped: Promise<void> = Promise.resolve();

    /**
     * @param handlers the handlers of the keys this service owns
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(private readonly client: ServiceBusClient, handlers: Iterable<QueryHandler>,
                options: ServiceBusServerOptions = {}) {
        if (client === null || client === undefined) throw new TypeError('The Service Bus client is required.');
        this.topicPrefix = options.topicPrefix || null;
        this.maxConcurrentSessions = positive(options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
            'maxConcurrentSessions');
        this.sessionIdleTimeoutMs = checkTimeout(options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS);
        this.administration = options.administration ?? null;
        this.logger = options.logger ?? console;
        this.responder = new WireResponder(handlers, checkTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
            this.logger);
    }

    /** The keys this server answers for. */
    get keys(): string[] {
        return this.responder.keys;
    }

    /** The request queue this server reads for each key. */
    get requestQueues(): Map<string, string> {
        return new Map(this.keys.map(key => [key, ServiceBusNames.requestQueue(key, this.topicPrefix)]));
    }

    /**
     * Creates the missing queues (with an administration client) and starts reading the request queues; does nothing
     * when the server already runs or has no key.
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

    /** The current run: it ends when the server is closed, or fails when a request queue does not exist. */
    whenStopped(): Promise<void> {
        return this.stopped;
    }

    /**
     * Stops reading the request queues and closes the senders; the requests being answered still get their reply. The
     * queues stay.
     */
    async close(): Promise<void> {
        await this.starting?.catch(() => undefined);
        const run = this.run;
        if (run === null) return;
        this.run = null;
        await run.stop();
        run.end();
    }

    private async open(): Promise<void> {
        for (const key of this.keys) {
            await this.createIfMissing(ServiceBusNames.requestQueue(key, this.topicPrefix));
            await this.createIfMissing(ServiceBusNames.replyQueue(key, this.topicPrefix));
        }
        let end!: () => void;
        let fail!: (error: unknown) => void;
        const stopped = new Promise<void>((resolve, reject) => {
            end = resolve;
            fail = reject;
        });
        // The end of a run that nobody waits for is not an unhandled rejection
        stopped.catch(() => undefined);
        const run = new Run(this.client, this.logger, end, error => {
            if (this.run !== run) return;
            this.run = null;
            this.logger.error('The FxMap Service Bus server stopped.', error);
            void run.stop().then(() => fail(error));
        });
        this.run = run;
        this.stopped = stopped;
        for (const [key, queue] of this.requestQueues)
            for (let i = 0; i < this.maxConcurrentSessions; i++) run.readers.push(this.read(run, key, queue));
    }

    private async createIfMissing(queue: string): Promise<void> {
        if (this.administration === null) return;
        try {
            if (!(await this.administration.queueExists(queue)))
                await this.administration.createQueue(queue, { requiresSession: true });
        } catch (error) {
            // FxMap goes on too: the queue may exist without the rights to manage it
            this.logger.error(`The queue ${queue} could not be created.`, error);
        }
    }

    // One reader: takes the next session of the queue, answers its requests one at a time until it is idle, then
    // releases it for another reader
    private async read(run: Run, key: string, queue: string): Promise<void> {
        while (run.active) {
            let receiver: ServiceBusSessionReceiver;
            try {
                receiver = await this.client.acceptNextSession(queue, {
                    maxAutoLockRenewalDurationInMs: SESSION_LOCK_RENEWAL_MS,
                    skipParsingBodyAsJson: true,
                });
            } catch (error) {
                if (!run.active) return;
                // No session has a request: wait for the next one
                if (errorCode(error) === 'ServiceTimeout' || errorCode(error) === 'SessionCannotBeLocked') continue;
                if (isMissingEntity(error)) return run.fail(error);
                this.logger.error(`No session of ${queue} could be taken.`, error);
                await run.pause(PAUSE_MS);
                continue;
            }
            run.receivers.add(receiver);
            try {
                while (run.active) {
                    const [message] = await receiver.receiveMessages(1, { maxWaitTimeInMs: this.sessionIdleTimeoutMs });
                    if (message === undefined) break;
                    await run.track(this.answer(run, key, receiver, message));
                }
            } catch (error) {
                if (!run.active) return;
                if (isMissingEntity(error)) return run.fail(error);
                this.logger.error(`The session ${receiver.sessionId} of ${queue} was lost.`, error);
            } finally {
                run.receivers.delete(receiver);
                await receiver.close().catch(() => undefined);
            }
        }
    }

    private async answer(run: Run, key: string, receiver: ServiceBusSessionReceiver,
                         request: ServiceBusReceivedMessage): Promise<void> {
        try {
            const reply = await this.responder.answer(key, bodyOf(request.body),
                serviceBusHeaders(request.applicationProperties));
            if (request.replyTo)
                await run.sender(request.replyTo).sendMessages({
                    body: reply,
                    correlationId: correlationIdOf(request.correlationId) ?? undefined,
                    sessionId: request.sessionId,
                });
        } catch (error) {
            this.logger.error(`The reply for ${key} could not be sent.`, error);
        }
        try {
            await receiver.completeMessage(request);
        } catch (error) {
            this.logger.error(`The request for ${key} could not be completed.`, error);
        }
    }
}

/** One start of the server: its readers, the sessions they hold, the replies being sent. */
class Run {
    readonly readers: Promise<void>[] = [];
    readonly receivers = new Set<ServiceBusSessionReceiver>();
    readonly senders = new Map<string, ServiceBusSender>();
    private readonly answering = new Set<Promise<void>>();
    private readonly stopping = new AbortController();
    private stopped: Promise<void> | null = null;

    constructor(private readonly client: ServiceBusClient, private readonly logger: ErrorLogger,
                readonly end: () => void, readonly fail: (error: unknown) => void) {
    }

    get active(): boolean {
        return !this.stopping.signal.aborted;
    }

    get signal(): AbortSignal {
        return this.stopping.signal;
    }

    sender(queue: string): ServiceBusSender {
        let sender = this.senders.get(queue);
        if (sender === undefined) {
            sender = this.client.createSender(queue);
            this.senders.set(queue, sender);
        }
        return sender;
    }

    track(answering: Promise<void>): Promise<void> {
        this.answering.add(answering);
        return answering.finally(() => this.answering.delete(answering));
    }

    pause(ms: number): Promise<void> {
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(done, ms);
            this.signal.addEventListener('abort', done, { once: true });
        });
    }

    // The requests being answered get their reply; the sessions are released. A reader still waiting for a session
    // closes it as soon as it gets one.
    stop(): Promise<void> {
        this.stopped ??= (async () => {
            this.stopping.abort();
            await Promise.allSettled([...this.answering]);
            await Promise.allSettled([...this.receivers].map(receiver => receiver.close()));
            await Promise.allSettled([...this.senders.values()].map(sender => sender.close().catch(error =>
                this.logger.error('A Service Bus sender did not close.', error))));
        })();
        return this.stopped;
    }
}

function positive(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number, at least 1.`);
    return value;
}
