import {
    ChangeMessageVisibilityBatchCommand,
    CreateQueueCommand,
    GetQueueUrlCommand,
    type Message,
    SendMessageCommand,
    type SQSClient,
} from '@aws-sdk/client-sqs';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DotNetKeyNames,
    type ErrorLogger,
    type QueryHandler,
    type RequestServer,
    WireResponder,
} from 'nfxmap';
import { SqsNames } from './names.js';
import {
    attribute,
    checkTimeout,
    checkWaitTime,
    DEFAULT_WAIT_TIME_SECONDS,
    deleteAll,
    isAbort,
    isQueueDoesNotExist,
    pause,
    receive,
    sqsHeaders,
    stringAttribute,
} from './sqs.js';

/** FxMap's `MaxConcurrentProcessing`. */
export const DEFAULT_MAX_CONCURRENT_PROCESSING = 128;

export interface SqsServerOptions {
    /** How long a handler may take before the request fails, in milliseconds (default 30 seconds). */
    readonly timeoutMs?: number;
    /** How long a poll waits for messages, in seconds (0 to 20, 20 by default). */
    readonly waitTimeSeconds?: number;
    /** How many requests are answered at once (default 128, FxMap's `MaxConcurrentProcessing`). */
    readonly maxConcurrentProcessing?: number;
    /** Where the failed requests, polls and replies are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Answers the requests for the keys this service owns over Amazon SQS (FxMap's SqsServer): it creates the queue of
 * each key ({@link SqsNames.queue}) when it does not exist, and polls each one (long polling, 10 messages at a time).
 * The received messages are deleted at once, as FxMap does, and answered with a `Result` on the queue of their
 * `ReplyTo` attribute, with their `CorrelationId`; at most `maxConcurrentProcessing` requests are answered at once.
 * The instances of a service share the queues, so each request reaches one of them.
 *
 * The server stops, and {@link whenStopped} rejects, when one of its queues is deleted; {@link start} creates it again.
 *
 * ```ts
 * const server = new SqsServer(new SQSClient({}), [new InMemoryQueryHandler(new UserConfig(), users)]);
 * await server.start();
 * ```
 */
export class SqsServer implements RequestServer {
    readonly waitTimeSeconds: number;
    readonly maxConcurrentProcessing: number;
    private readonly responder: WireResponder;
    private readonly logger: ErrorLogger;
    private readonly slots: Slots;
    private run: Run | null = null;
    private starting: Promise<void> | null = null;
    private stopped: Promise<void> = Promise.resolve();
    private urls = new Map<string, string>();

    /**
     * @param handlers the handlers of the keys this service owns
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(private readonly sqs: SQSClient, handlers: Iterable<QueryHandler>, options: SqsServerOptions = {}) {
        if (sqs === null || sqs === undefined) throw new TypeError('The SQS client is required.');
        this.waitTimeSeconds = checkWaitTime(options.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS);
        const maxConcurrentProcessing = options.maxConcurrentProcessing ?? DEFAULT_MAX_CONCURRENT_PROCESSING;
        if (!Number.isInteger(maxConcurrentProcessing) || maxConcurrentProcessing < 1)
            throw new RangeError('maxConcurrentProcessing must be a whole number, at least 1.');
        this.maxConcurrentProcessing = maxConcurrentProcessing;
        this.slots = new Slots(maxConcurrentProcessing);
        this.logger = options.logger ?? console;
        this.responder = new WireResponder(handlers, checkTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
            this.logger);
    }

    /** The keys this server answers for. */
    get keys(): string[] {
        return this.responder.keys;
    }

    /** The URLs of the queues this server polls, by key; empty until it starts. */
    get queueUrls(): Map<string, string> {
        return new Map(this.urls);
    }

    /**
     * Creates the queues that do not exist and starts polling them; does nothing when the server already runs or has
     * no key.
     *
     * @throws Error when SQS refuses to find or create a queue
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

    /** The current run: it ends when the server is closed, or fails when one of its queues was deleted. */
    whenStopped(): Promise<void> {
        return this.stopped;
    }

    /** Stops polling; the requests being answered still get their reply. The queues stay. */
    async close(): Promise<void> {
        await this.starting?.catch(() => undefined);
        const run = this.run;
        if (run === null) return;
        this.run = null;
        run.polling.abort();
        await Promise.allSettled(run.polls);
        await Promise.allSettled([...run.answering]);
        run.end();
    }

    private async open(): Promise<void> {
        const urls = new Map<string, string>();
        for (const key of this.keys) urls.set(key, await this.queueUrl(SqsNames.queue(key)));
        this.urls = urls;

        let end!: () => void;
        let fail!: (error: unknown) => void;
        const stopped = new Promise<void>((resolve, reject) => {
            end = resolve;
            fail = reject;
        });
        // The end of a run that nobody waits for is not an unhandled rejection
        stopped.catch(() => undefined);
        const run: Run = { polling: new AbortController(), polls: [], answering: new Set(), end, fail: () => undefined };
        run.fail = (error: unknown) => {
            if (this.run !== run) return;
            this.run = null;
            run.polling.abort();
            this.logger.error('The FxMap SQS server stopped.', error);
            fail(error);
        };
        this.run = run;
        this.stopped = stopped;
        for (const [key, url] of urls) run.polls.push(this.poll(run, key, url));
    }

    private async queueUrl(name: string): Promise<string> {
        try {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
            if (QueueUrl) return QueueUrl;
        } catch (error) {
            if (!isQueueDoesNotExist(error)) throw error;
        }
        const { QueueUrl } = await this.sqs.send(new CreateQueueCommand({
            QueueName: name,
            Attributes: { VisibilityTimeout: '30', ReceiveMessageWaitTimeSeconds: '20' },
        }));
        if (!QueueUrl) throw new Error(`SQS created the queue ${name} without a URL.`);
        return QueueUrl;
    }

    private async poll(run: Run, key: string, url: string): Promise<void> {
        const signal = run.polling.signal;
        while (!signal.aborted) {
            try {
                const messages = await receive(this.sqs, url, this.waitTimeSeconds, signal);
                if (messages.length === 0) continue;
                if (signal.aborted) {
                    // Closed while polling: the messages go back to the queue at once, for another server
                    await this.release(url, messages);
                    return;
                }
                await deleteAll(this.sqs, url, messages);
                for (const message of messages) {
                    await this.slots.acquire();
                    const answering = this.answer(key, message).finally(() => {
                        this.slots.release();
                        run.answering.delete(answering);
                    });
                    run.answering.add(answering);
                }
            } catch (error) {
                if (isAbort(error, signal)) return;
                if (isQueueDoesNotExist(error)) {
                    // Polling again cannot help: a restart creates the queue again
                    run.fail(error);
                    return;
                }
                this.logger.error(`The queue ${url} could not be polled.`, error);
                await pause(signal);
            }
        }
    }

    private async answer(queueKey: string, message: Message): Promise<void> {
        // FxMap finds the key by the Type attribute, the assembly-qualified name of the key
        const key = DotNetKeyNames.fromAssemblyQualifiedName(attribute(message, SqsNames.TYPE)) ?? queueKey;
        const replyTo = attribute(message, SqsNames.REPLY_TO);
        const correlationId = attribute(message, SqsNames.CORRELATION_ID) ?? 'Unknown';
        try {
            const reply = await this.responder.answer(key, Buffer.from(message.Body ?? '', 'utf8'), sqsHeaders(message));
            if (!replyTo) return;
            await this.sqs.send(new SendMessageCommand({
                QueueUrl: replyTo,
                MessageBody: reply.toString('utf8'),
                MessageAttributes: { [SqsNames.CORRELATION_ID]: stringAttribute(correlationId) },
            }));
        } catch (error) {
            this.logger.error(`The reply for ${key} could not be sent.`, error);
        }
    }

    private async release(url: string, messages: readonly Message[]): Promise<void> {
        try {
            await this.sqs.send(new ChangeMessageVisibilityBatchCommand({
                QueueUrl: url,
                Entries: messages.map((message, index) => ({
                    Id: String(index),
                    ReceiptHandle: message.ReceiptHandle,
                    VisibilityTimeout: 0,
                })),
            }));
        } catch (error) {
            this.logger.error(`Messages of ${url} stay hidden until their timeout.`, error);
        }
    }
}

interface Run {
    readonly polling: AbortController;
    readonly polls: Promise<void>[];
    readonly answering: Set<Promise<void>>;
    readonly end: () => void;
    fail: (error: unknown) => void;
}

/** A counting semaphore: the requests answered at once. */
class Slots {
    private readonly waiting: (() => void)[] = [];

    constructor(private free: number) {
    }

    acquire(): Promise<void> {
        if (this.free > 0) {
            this.free--;
            return Promise.resolve();
        }
        return new Promise(resolve => this.waiting.push(resolve));
    }

    release(): void {
        const next = this.waiting.shift();
        if (next !== undefined) next();
        else this.free++;
    }
}
