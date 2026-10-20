import type { Msg, MsgHdrs, NatsConnection, Subscription } from '@nats-io/nats-core';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ErrorLogger,
    type Headers,
    type QueryHandler,
    type RequestServer,
    WireResponder,
} from 'nfxmap';
import { NatsSubjects } from './subjects.js';

/** FxMap's `MaxConcurrentProcessing`. */
export const DEFAULT_MAX_CONCURRENT_PROCESSING = 128;

export interface NatsServerOptions {
    /** The prefix of the subjects (FxMap's `TopicPrefix`); none by default. */
    readonly topicPrefix?: string;
    /** How long a handler may take before the request fails, in milliseconds (default 30 seconds). */
    readonly timeoutMs?: number;
    /** How many requests are answered at once (default 128, FxMap's `SetMaxConcurrentProcessing`). */
    readonly maxConcurrentProcessing?: number;
    /** Where the failed requests and replies are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Answers the requests for the keys this service owns over NATS (FxMap's NatsServer): it subscribes to the subject of
 * each key ({@link NatsSubjects}) and replies with a `Result` on the inbox of each request. At most
 * `maxConcurrentProcessing` requests are answered at once; the others wait in the subscription. As in FxMap, the
 * subscriptions have no queue group: every instance of the service answers, and the requester takes the first reply.
 *
 * ```ts
 * const server = new NatsServer(connection, [new InMemoryQueryHandler(new UserConfig(), users)]);
 * await server.start();
 * ```
 */
export class NatsServer implements RequestServer {
    readonly topicPrefix: string | undefined;
    private readonly responder: WireResponder;
    private readonly slots: Semaphore;
    private readonly logger: ErrorLogger;
    private run: Run | null = null;
    private stopped: Promise<void> = Promise.resolve();

    /**
     * @param handlers the handlers of the keys this service owns
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(private readonly connection: NatsConnection, handlers: Iterable<QueryHandler>,
                options: NatsServerOptions = {}) {
        if (connection === null || connection === undefined) throw new TypeError('The NATS connection is required.');
        const maxConcurrentProcessing = options.maxConcurrentProcessing ?? DEFAULT_MAX_CONCURRENT_PROCESSING;
        if (!Number.isInteger(maxConcurrentProcessing) || maxConcurrentProcessing < 1)
            throw new RangeError('maxConcurrentProcessing must be a whole number, at least 1.');
        this.logger = options.logger ?? console;
        this.responder = new WireResponder(handlers, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, this.logger);
        this.topicPrefix = options.topicPrefix;
        this.slots = new Semaphore(maxConcurrentProcessing);
    }

    /** The keys this server answers for. */
    get keys(): string[] {
        return this.responder.keys;
    }

    /** The subjects this server listens on, by key. */
    get subjects(): Map<string, string> {
        return new Map(this.keys.map(key => [key, NatsSubjects.of(key, this.topicPrefix)]));
    }

    /**
     * Subscribes to the subjects; does nothing when the server already runs.
     *
     * @throws Error when the connection is closed
     */
    async start(): Promise<void> {
        if (this.run !== null) return;
        const subscriptions: Subscription[] = [];
        try {
            for (const subject of this.subjects.values()) subscriptions.push(this.connection.subscribe(subject));
        } catch (error) {
            for (const subscription of subscriptions) subscription.unsubscribe();
            throw error;
        }
        const run: Run = { subscriptions, closing: false };
        this.run = run;
        const keys = [...this.subjects.keys()];
        this.stopped = Promise.all(subscriptions.map((subscription, i) => this.receive(keys[i], subscription)))
            .then(() => {
                if (!run.closing) throw new Error('The NATS subscriptions ended: the connection closed.');
            })
            .finally(() => {
                if (this.run === run) this.run = null;
            });
        // The end of a run that nobody waits for is not an unhandled rejection
        this.stopped.catch(() => undefined);
    }

    isRunning(): boolean {
        return this.run !== null;
    }

    /** The current run; it ends when the server is closed, or when the connection closes (nats.js reconnects by itself). */
    whenStopped(): Promise<void> {
        return this.stopped;
    }

    /** Unsubscribes; the requests being answered still get their reply. */
    async close(): Promise<void> {
        const run = this.run;
        if (run === null) return;
        run.closing = true;
        for (const subscription of run.subscriptions) {
            try {
                subscription.unsubscribe();
            } catch (error) {
                this.logger.error('A NATS subscription did not close.', error);
            }
        }
        this.run = null;
        await this.stopped.catch(() => undefined);
    }

    private async receive(key: string, subscription: Subscription): Promise<void> {
        for await (const message of subscription) {
            if (!message.reply) continue;
            // Backpressure: the loop waits for a slot, so the pending messages stay in the subscription
            await this.slots.acquire();
            void this.answer(key, message).finally(() => this.slots.release());
        }
    }

    private async answer(key: string, message: Msg): Promise<void> {
        let reply: Uint8Array;
        try {
            reply = await this.responder.answer(key, message.data, natsServerHeaders(message.headers));
        } catch (error) {
            this.logger.error(`The request for ${key} could not be answered.`, error);
            return;
        }
        try {
            this.connection.publish(message.reply!, reply);
        } catch (error) {
            this.logger.error(`The reply for ${key} could not be sent.`, error);
        }
    }
}

/** The first value of each NATS header. */
export function natsServerHeaders(headers: MsgHdrs | undefined): Headers {
    const result: Record<string, string> = {};
    if (headers === undefined) return result;
    for (const name of headers.keys()) {
        const value = headers.get(name);
        if (value !== undefined && value !== null) result[name] = value;
    }
    return result;
}

interface Run {
    readonly subscriptions: Subscription[];
    closing: boolean;
}

class Semaphore {
    private readonly waiting: (() => void)[] = [];

    constructor(private available: number) {
    }

    acquire(): Promise<void> {
        if (this.available > 0) {
            this.available--;
            return Promise.resolve();
        }
        return new Promise(resolve => this.waiting.push(resolve));
    }

    release(): void {
        const next = this.waiting.shift();
        if (next !== undefined) next();
        else this.available++;
    }
}
