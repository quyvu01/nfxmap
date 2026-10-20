import { randomUUID } from 'node:crypto';
import { type Admin, Kafka, type KafkaMessage, logLevel } from 'kafkajs';
import {
    createDistributedMapper,
    EntityConfigureOf,
    InMemoryQueryHandler,
    type ItemsResponse,
    MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    ProfileOf,
    type QueryHandler,
    ReceivedFaultError,
    RequestTimedOutError,
} from 'nfxmap';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    KafkaNames,
    KafkaRequestClient,
    type KafkaRequestClientOptions,
    KafkaServer,
    type KafkaServerOptions,
} from '../src/index.js';

/** The brokers of the integration tests: `KAFKA_BROKERS` (`host:port,...`); the tests are skipped when it is not set. */
const KAFKA_BROKERS = process.env.KAFKA_BROKERS;

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('UserOf');
        this.exposedName('email', 'UserEmail');
    }
}

class OrderDto {
    userName: string | null = null;
    userEmail: string | null = null;

    constructor(readonly userId: number) {}
}

class OrderDtoProfile extends ProfileOf<OrderDto> {
    constructor() {
        super(OrderDto);
    }

    protected configure() {
        this.useDistributedKey('UserOf')
            .of('userId')
            .for('userName')
            .for('userEmail', 'UserEmail');
    }
}

const users = () => new InMemoryQueryHandler(new UserConfig(),
    [new User(1, 'Alice', 'alice@example.com'), new User(2, 'Bob', 'bob@example.com')]);

const silentLogger = { error: () => undefined };
const USER_TOPIC = 'fxmap-request-topic-userof';
const SILENT_TOPIC = 'fxmap-request-topic-silentof';

/** The client and the server against a real Kafka broker, and the messages they exchange with FxMap's. */
describe.skipIf(!KAFKA_BROKERS)('Kafka transport', { timeout: 60_000 }, () => {
    const kafka = new Kafka({ clientId: 'nfxmap-test', brokers: KAFKA_BROKERS?.split(',') ?? [], logLevel: logLevel.NOTHING });
    let admin: Admin;
    const closeables: (() => unknown)[] = [];

    beforeAll(async () => {
        admin = kafka.admin();
        await admin.connect();
    });

    afterAll(async () => {
        await admin.disconnect();
    });

    beforeEach(async () => {
        // Each test starts without the requests of the others
        const existing = await admin.listTopics();
        const topics = [USER_TOPIC, SILENT_TOPIC].filter(topic => existing.includes(topic));
        if (topics.length > 0) await admin.deleteTopics({ topics });
        await waitFor(async () => !(await admin.listTopics()).some(topic => topics.includes(topic)));
    });

    afterEach(async () => {
        for (const close of closeables.splice(0).reverse()) await close();
    });

    async function serve(handlers: QueryHandler[], options: KafkaServerOptions = {}): Promise<KafkaServer> {
        const server = new KafkaServer(kafka, handlers, { logger: silentLogger, ...options });
        await server.start();
        closeables.push(() => server.close());
        return server;
    }

    function client(options: KafkaRequestClientOptions = {}): KafkaRequestClient {
        const created = new KafkaRequestClient(kafka, 'OrderService', { timeoutMs: 30_000, ...options });
        closeables.push(() => created.close());
        return created;
    }

    async function createTopic(topic: string): Promise<void> {
        await admin.createTopics({ waitForLeaders: true, topics: [{ topic, numPartitions: 1 }] });
    }

    /** The first message of a topic, read by a consumer of its own. */
    async function nextMessage(topic: string): Promise<KafkaMessage> {
        const consumer = kafka.consumer({ groupId: `test-${randomUUID()}` });
        closeables.push(() => consumer.disconnect());
        await consumer.connect();
        await consumer.subscribe({ topics: [topic], fromBeginning: true });
        return new Promise(resolve => {
            void consumer.run({ eachMessage: async ({ message }) => resolve(message) });
        });
    }

    async function producer() {
        const created = kafka.producer();
        closeables.push(() => created.disconnect());
        await created.connect();
        return created;
    }

    const request = (requestClient: KafkaRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        requestClient.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    it('maps a DTO through Kafka', async () => {
        await serve([users()]);
        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: client(),
            throwIfException: true,
        });
        const dtos = [new OrderDto(1), new OrderDto(2), new OrderDto(3)];

        await mapper.map(dtos);

        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob', null]);
        expect(dtos.map(d => d.userEmail)).toEqual(['alice@example.com', 'bob@example.com', null]);
    });

    it('carries the headers, and answers many requests', async () => {
        const seen: MapContext[] = [];
        const recording: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async (_: MapRequest, context: MapContext) => {
                seen.push(context);
                return { items: [], errors: [] };
            },
        };
        await serve([recording], { maxConcurrentProcessing: 2 });
        const requestClient = client();

        await Promise.all(Array.from({ length: 5 }, () => request(requestClient, 'UserOf', { authorization: 'Bearer x' }, null)));

        expect(seen).toHaveLength(5);
        expect(seen[0].headers).toEqual({ authorization: 'Bearer x' });
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('brings an owner failure back as a received fault', async () => {
        const failing = new InMemoryQueryHandler(new UserConfig(), () => {
            throw new Error('database down');
        });
        await serve([failing]);

        const failure = request(client(), 'UserOf', {}, 'Name');

        await expect(failure).rejects.toBeInstanceOf(ReceivedFaultError);
        await expect(failure).rejects.toThrow('database down');
    });

    it('fails at once for a key without request topic', async () => {
        await expect(request(client(), 'NobodyOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
    });

    it('times out when the reply does not come', async () => {
        await createTopic(SILENT_TOPIC);
        const requestClient = client({ timeoutMs: 1000 });

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('fails the waiting requests when it is closed', async () => {
        await createTopic(SILENT_TOPIC);
        const requestClient = client();
        const sent = nextMessage(SILENT_TOPIC);
        const waiting = request(requestClient, 'SilentOf', {}, 'Name');
        const failure = expect(waiting).rejects.toThrow('closed');
        await sent;

        await requestClient.close();

        await failure;
        await expect(request(requestClient, 'UserOf', {}, 'Name')).rejects.toThrow('closed');
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        await createTopic(USER_TOPIC);
        const received = nextMessage(USER_TOPIC);
        const replies = await producer();
        // What FxMap's KafkaServer does: read the wrapped request, reply on its ReplyTo with the same key
        const answered = received.then(message => {
            const { ReplyTo } = JSON.parse(message.value!.toString());
            return replies.send({
                topic: ReplyTo,
                messages: [{
                    key: message.key,
                    value: '{"IsSuccess":true,"Data":{"Items":[{"Id":"1","Values":[{"Expression":"UserEmail",'
                        + '"Value":"\\"alice@example.com\\""}]}],"Errors":[]},"Fault":null}',
                }],
            });
        });
        const requestClient = client();

        const response = await request(requestClient, 'UserOf', { tenant: 'a' }, 'UserEmail');

        await answered;
        const message = await received;
        expect(JSON.parse(message.value!.toString())).toEqual({
            Message: { SelectorIds: ['1', '2'], Expressions: ['UserEmail'] },
            ReplyTo: requestClient.replyTopic,
        });
        expect(message.key!.toString()).toMatch(/^[0-9a-f-]{36}$/);
        expect(message.headers?.tenant?.toString()).toBe('a');
        expect(response.items).toEqual([{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }]);
    });

    it('answers what an FxMap client sends', async () => {
        await serve([users()]);
        // What FxMap's KafkaClient sends: the wrapped request, keyed by its correlation id
        const replyTopic = KafkaNames.newResponseTopic('dotnet');
        await createTopic(replyTopic);
        const reply = nextMessage(replyTopic);

        await (await producer()).send({
            topic: USER_TOPIC,
            messages: [{
                key: 'c-1',
                value: JSON.stringify({ Message: { SelectorIds: ['2'], Expressions: [null, 'UserEmail'] }, ReplyTo: replyTopic }),
            }],
        });

        const message = await reply;
        expect(message.key!.toString()).toBe('c-1');
        expect(JSON.parse(message.value!.toString())).toEqual({
            IsSuccess: true,
            Data: {
                Items: [{
                    Id: '2',
                    Values: [{ Expression: null, Value: '"Bob"' }, { Expression: 'UserEmail', Value: '"bob@example.com"' }],
                }],
                Errors: [],
            },
            Fault: null,
        });
        await admin.deleteTopics({ topics: [replyTopic] });
    });

    it('can start and close repeatedly', async () => {
        const server = await serve([users()]);
        await server.start();
        let ended = false;
        const run = server.whenStopped().then(() => {
            ended = true;
        });
        await server.close();
        await server.close();
        await run;

        expect(ended).toBe(true);
        expect(server.isRunning()).toBe(false);
        await server.start();
        expect(server.isRunning()).toBe(true);
        const response = await request(client(), 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    });
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100 && !(await condition()); i++) await new Promise(resolve => setTimeout(resolve, 100));
}
