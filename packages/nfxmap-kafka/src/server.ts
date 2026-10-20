import type { Consumer, Kafka, KafkaMessage, Producer } from 'kafkajs';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ErrorLogger,
    type QueryHandler,
    type RequestServer,
    WireResponder,
} from 'nfxmap';
import { KafkaMessages, KafkaNames } from './names.js';
import { createTopics } from './topics.js';

/** FxMap's `MaxConcurrentProcessing`. */
export const DEFAULT_MAX_CONCURRENT_PROCESSING = 128;

export interface KafkaServerOptions {
    /** How long a handler may take before the request fails, in milliseconds (default 30 seconds). */
    readonly timeoutMs?: number;
    /**
     * The partitions of each request topic this server creates (default 1, FxMap's `RequestTopicPartitions`); a topic
     * that exists is not changed. More partitions let more instances share the requests.
     */
    readonly partitions?: number;
    /** The replication factor of the topics this server creates (default 1, as in FxMap). */
    readonly replicationFactor?: number;
    /** How many requests of a batch are answered at once (default 128, FxMap's `SetMaxConcurrentProcessing`). */
    readonly maxConcurrentProcessing?: number;
    /** Where the failed requests and replies are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

interface Run {
    readonly consumer: Consumer;
    readonly producer: Producer;
    closing: boolean;
    readonly end: () => void;
    readonly fail: (error: unknown) => void;
}

/**
 * Answers the requests for the keys this service owns over Kafka (FxMap's KafkaServer): it creates the request topic
 * of each key ({@link KafkaNames}) and reads them in the consumer group `fxmap-rpc-server-group`, as FxMap does, so the
 * instances of a service share the partitions. Each request is answered with a `Result` on its reply topic, keyed by
 * its correlation id; the offset of a request is committed once it is answered, whether it succeeded or failed.
 *
 * The server stops, and {@link whenStopped} rejects, when its consumer crashes for good (kafkajs restarts it after the
 * errors it can retry); {@link start} starts it again.
 *
 * ```ts
 * const server = new KafkaServer(kafka, [new InMemoryQueryHandler(new UserConfig(), users)]);
 * await server.start();
 * ```
 */
export class KafkaServer implements RequestServer {
    readonly partitions: number;
    readonly replicationFactor: number;
    readonly maxConcurrentProcessing: number;
    private readonly responder: WireResponder;
    private readonly logger: ErrorLogger;
    private readonly keysByTopic = new Map<string, string>();
    private run: Run | null = null;
    private starting: Promise<void> | null = null;
    private stopped: Promise<void> = Promise.resolve();

    /**
     * @param handlers the handlers of the keys this service owns
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(private readonly kafka: Kafka, handlers: Iterable<QueryHandler>, options: KafkaServerOptions = {}) {
        if (kafka === null || kafka === undefined) throw new TypeError('The Kafka client is required.');
        this.partitions = positive(options.partitions ?? 1, 'partitions');
        this.replicationFactor = positive(options.replicationFactor ?? 1, 'replicationFactor');
        this.maxConcurrentProcessing = positive(options.maxConcurrentProcessing ?? DEFAULT_MAX_CONCURRENT_PROCESSING,
            'maxConcurrentProcessing');
        this.logger = options.logger ?? console;
        this.responder = new WireResponder(handlers, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, this.logger);
        for (const key of this.responder.keys) this.keysByTopic.set(KafkaNames.requestTopic(key), key);
    }

    /** The keys this server answers for. */
    get keys(): string[] {
        return this.responder.keys;
    }

    /** The request topics this server reads, by key. */
    get topics(): Map<string, string> {
        return new Map([...this.keysByTopic].map(([topic, key]) => [key, topic]));
    }

    /**
     * Creates the request topics and starts reading them; does nothing when the server already runs or has no key.
     *
     * @throws Error when the brokers cannot be reached or refuse a topic
     */
    start(): Promise<void> {
        if (this.run !== null || this.keysByTopic.size === 0) return Promise.resolve();
        this.starting ??= this.open().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }

    isRunning(): boolean {
        return this.run !== null;
    }

    /** The current run: it ends when the server is closed, or fails when its consumer crashes for good. */
    whenStopped(): Promise<void> {
        return this.stopped;
    }

    /** Stops reading; the requests of the current batch are answered first. The topics stay. */
    async close(): Promise<void> {
        await this.starting?.catch(() => undefined);
        const run = this.run;
        if (run === null) return;
        this.run = null;
        run.closing = true;
        await disconnect(run);
        run.end();
    }

    private async open(): Promise<void> {
        const topics = [...this.keysByTopic.keys()];
        await createTopics(this.kafka, topics, this.partitions, this.replicationFactor);

        let end!: () => void;
        let fail!: (error: unknown) => void;
        const stopped = new Promise<void>((resolve, reject) => {
            end = resolve;
            fail = reject;
        });
        // The end of a run that nobody waits for is not an unhandled rejection
        stopped.catch(() => undefined);
        const run: Run = {
            consumer: this.kafka.consumer({ groupId: KafkaNames.SERVER_GROUP_ID, allowAutoTopicCreation: false }),
            producer: this.kafka.producer({ allowAutoTopicCreation: false }),
            closing: false,
            end,
            fail: (error: unknown) => {
                if (run.closing) return;
                run.closing = true;
                if (this.run === run) this.run = null;
                this.logger.error('The FxMap Kafka server stopped.', error);
                void disconnect(run).then(() => fail(error));
            },
        };
        try {
            await run.producer.connect();
            await run.consumer.connect();
            await run.consumer.subscribe({ topics, fromBeginning: true });
            run.consumer.on(run.consumer.events.CRASH, event => {
                if (!event.payload.restart) run.fail(event.payload.error);
            });
            await run.consumer.run({
                eachBatchAutoResolve: false,
                eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary, isRunning, isStale }) => {
                    const key = this.keysByTopic.get(batch.topic) ?? null;
                    for (let start = 0; start < batch.messages.length; start += this.maxConcurrentProcessing) {
                        if (!isRunning() || isStale()) return;
                        const chunk = batch.messages.slice(start, start + this.maxConcurrentProcessing);
                        await Promise.all(chunk.map(message => this.answer(run.producer, batch.topic, key, message)));
                        // Answered, whether each request succeeded or failed: committed, as in FxMap
                        resolveOffset(chunk[chunk.length - 1].offset);
                        await commitOffsetsIfNecessary();
                        await heartbeat();
                    }
                },
            });
        } catch (error) {
            run.closing = true;
            await disconnect(run);
            throw error;
        }
        this.run = run;
        this.stopped = stopped;
    }

    private async answer(producer: Producer, topic: string, key: string | null, message: KafkaMessage): Promise<void> {
        if (message.value === null) return;
        let received;
        try {
            received = KafkaMessages.readRequest(message.value);
        } catch (error) {
            this.logger.error(`A request on ${topic} is not FxMap's: dropped.`, error);
            return;
        }
        if (received.replyTo === null || received.replyTo.trim().length === 0) {
            this.logger.error(`A request on ${topic} has no ReplyTo: dropped.`);
            return;
        }
        try {
            const reply = await this.responder.answer(key, received.request, KafkaMessages.fromKafkaHeaders(message.headers));
            await producer.send({ topic: received.replyTo, messages: [{ key: message.key, value: reply }] });
        } catch (error) {
            this.logger.error(`The reply for ${key} was not sent.`, error);
        }
    }
}

async function disconnect(run: Run): Promise<void> {
    await Promise.allSettled([run.consumer.disconnect(), run.producer.disconnect()]);
}

function positive(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a whole number, at least 1.`);
    return value;
}
