import { randomUUID } from 'node:crypto';
import type { Consumer, Kafka, Producer } from 'kafkajs';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    PendingReplies,
    type RequestClient,
    WireMessages,
} from 'nfxmap';
import { KafkaMessages, KafkaNames } from './names.js';
import { createTopics, topicExists } from './topics.js';

export interface KafkaRequestClientOptions {
    /** How long a request may wait for its reply, in milliseconds (default 30 seconds, FxMap's DefaultRequestTimeout). */
    readonly timeoutMs?: number;
    /** The replication factor of the reply topic (default 1, as in FxMap). */
    readonly replicationFactor?: number;
}

interface Started {
    readonly producer: Producer;
    readonly consumer: Consumer;
}

/**
 * Sends requests over Kafka (FxMap's KafkaClient and `AddKafka`): each request goes to the request topic of its key
 * ({@link KafkaNames}), keyed by a correlation id, wrapped with the reply topic of this client
 * (`fxmap-response-topic-<application>-<uuid>`, one partition, created on the first request); the owner replies there
 * with the same key. A key whose request topic does not exist (no service created it) fails at once.
 *
 * The {@link Kafka} client belongs to the caller; {@link close} disconnects the producer and the consumer of this
 * client.
 *
 * ```ts
 * const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] });
 * const client = new KafkaRequestClient(kafka, 'order-service');
 * ```
 */
export class KafkaRequestClient implements RequestClient {
    readonly transport = 'kafka';
    /** The topic this client receives its replies on. */
    readonly replyTopic: string;
    readonly timeoutMs: number;
    readonly replicationFactor: number;
    private readonly pending = new PendingReplies();
    private readonly knownTopics = new Set<string>();
    private started: Promise<Started> | null = null;
    private closed = false;

    /** @param applicationName the name of the service, in the name of its reply topic */
    constructor(private readonly kafka: Kafka, applicationName: string, options: KafkaRequestClientOptions = {}) {
        if (kafka === null || kafka === undefined) throw new TypeError('The Kafka client is required.');
        this.replyTopic = KafkaNames.newResponseTopic(applicationName);
        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
        this.timeoutMs = timeoutMs;
        this.replicationFactor = options.replicationFactor ?? 1;
        if (!Number.isInteger(this.replicationFactor) || this.replicationFactor < 1)
            throw new RangeError('The replication factor must be a whole number, at least 1.');
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        this.ensureOpen();
        const topic = KafkaNames.requestTopic(key);
        if (!this.knownTopics.has(topic)) {
            if (!(await topicExists(this.kafka, topic))) throw new NoHandlerForDistributedKeyError(key);
            this.knownTopics.add(topic);
        }
        const { producer } = await this.start();
        this.ensureOpen();

        const correlationId = randomUUID();
        const reply = this.pending.register(correlationId, key, this.timeoutMs);
        producer.send({
            topic,
            messages: [{
                key: correlationId,
                value: KafkaMessages.writeRequest(request, this.replyTopic),
                headers: KafkaMessages.toKafkaHeaders(context.headers),
            }],
        }).catch(error => this.pending.fail(correlationId,
            new Error(`The request for ${key} could not be sent to Kafka.`, { cause: error })));
        return WireMessages.readResult(await reply);
    }

    /** How many requests wait for their reply. */
    get pendingRequests(): number {
        return this.pending.size;
    }

    /** Stops reading replies, disconnects the producer and fails the requests that still wait. The reply topic stays. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pending.failAll(new Error('The Kafka request client is closed.'));
        const started = this.started;
        this.started = null;
        if (started !== null) await started.then(stop, () => undefined);
    }

    private ensureOpen(): void {
        if (this.closed) throw new Error('The Kafka request client is closed.');
    }

    // The reply topic, its consumer and the producer, on the first request
    private start(): Promise<Started> {
        this.started ??= this.open().catch(error => {
            this.started = null;
            throw error;
        });
        return this.started;
    }

    private async open(): Promise<Started> {
        await createTopics(this.kafka, [this.replyTopic], 1, this.replicationFactor);
        // A group of its own: the topic is this client's alone. Read from the start, so a reply that comes before the
        // partition is assigned is not lost
        const consumer = this.kafka.consumer({ groupId: `${KafkaNames.CLIENT_GROUP_PREFIX}-${randomUUID().replaceAll('-', '')}` });
        const producer = this.kafka.producer({ allowAutoTopicCreation: false });
        try {
            await consumer.connect();
            await consumer.subscribe({ topics: [this.replyTopic], fromBeginning: true });
            consumer.on(consumer.events.CRASH, event => {
                if (event.payload.restart) return;
                // The consumer stopped for good: the requests that wait get no reply, the next request starts again
                this.pending.failAll(new Error(`The Kafka replies of ${this.replyTopic} cannot be read.`,
                    { cause: event.payload.error }));
                const current = this.started;
                this.started = null;
                void current?.then(stop, () => undefined);
            });
            await consumer.run({
                eachMessage: async ({ message }) => {
                    if (message.key !== null && message.value !== null)
                        this.pending.complete(message.key.toString(), message.value);
                },
            });
            await producer.connect();
        } catch (error) {
            await stop({ producer, consumer });
            throw error;
        }
        return { producer, consumer };
    }
}

async function stop({ producer, consumer }: Started): Promise<void> {
    await Promise.allSettled([consumer.disconnect(), producer.disconnect()]);
}
