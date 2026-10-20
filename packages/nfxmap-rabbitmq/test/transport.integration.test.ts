import { randomUUID } from 'node:crypto';
import { type Channel, type ChannelModel, connect, type ConsumeMessage } from 'amqplib';
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
    RetryPolicy,
} from 'nfxmap';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    RabbitMqNames,
    RabbitMqRequestClient,
    type RabbitMqRequestClientOptions,
    RabbitMqServer,
    type RabbitMqServerOptions,
} from '../src/index.js';

/** The broker of the integration tests: `RABBITMQ_URL`; the tests are skipped when it is not set. */
const RABBITMQ_URL = process.env.RABBITMQ_URL;

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
const QUEUE = 'fxmap-rpc-queue-userservice';
const USER_EXCHANGE = 'FxMap-:UserOf';
const SILENT_EXCHANGE = 'FxMap-:SilentOf';
const ASSEMBLY_QUALIFIED_USER_OF =
    'UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null';

/** The client and the server against a real RabbitMQ broker, and the messages they exchange with FxMap's. */
describe.skipIf(!RABBITMQ_URL)('RabbitMQ transport', () => {
    let connection: ChannelModel;
    const closeables: (() => unknown)[] = [];

    beforeEach(async () => {
        connection = await connect(RABBITMQ_URL!);
        // Each test starts without the exchanges and the queue of the others
        const channel = await connection.createChannel();
        for (const exchange of [USER_EXCHANGE, SILENT_EXCHANGE]) await channel.deleteExchange(exchange);
        await channel.deleteQueue(QUEUE);
        await channel.close();
    });

    afterEach(async () => {
        for (const close of closeables.splice(0).reverse()) await close();
        await connection.close().catch(() => undefined);
    });

    async function serve(handlers: QueryHandler[], options: RabbitMqServerOptions = {}): Promise<RabbitMqServer> {
        const server = new RabbitMqServer(connection, 'UserService', handlers, { logger: silentLogger, ...options });
        await server.start();
        closeables.push(() => server.close());
        return server;
    }

    function client(options: RabbitMqRequestClientOptions = {}): RabbitMqRequestClient {
        const created = new RabbitMqRequestClient(connection, { timeoutMs: 10_000, ...options });
        closeables.push(() => created.close());
        return created;
    }

    async function channel(): Promise<Channel> {
        const created = await connection.createChannel();
        closeables.push(() => created.close().catch(() => undefined));
        return created;
    }

    const request = (requestClient: RabbitMqRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        requestClient.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    it('maps a DTO through RabbitMQ', async () => {
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

    it('carries the headers', async () => {
        let seen: MapContext | undefined;
        const recording: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async (_: MapRequest, context: MapContext) => {
                seen = context;
                return { items: [], errors: [] };
            },
        };
        await serve([recording]);

        await request(client(), 'UserOf', { authorization: 'Bearer x' }, null);

        expect(seen?.headers).toEqual({ authorization: 'Bearer x' });
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

    it('fails at once for a key without exchange', async () => {
        await expect(request(client(), 'NobodyOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
    });

    it('fails at once for a key whose exchange has no queue', async () => {
        await (await channel()).assertExchange(SILENT_EXCHANGE, 'direct', { durable: false });
        const requestClient = client();

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('times out when the reply does not come', async () => {
        // A queue bound to the exchange, that nobody answers
        const admin = await channel();
        await admin.assertExchange(SILENT_EXCHANGE, 'direct', { durable: false });
        const { queue } = await admin.assertQueue('', { exclusive: true });
        await admin.bindQueue(queue, SILENT_EXCHANGE, RabbitMqNames.ROUTING_KEY);
        const requestClient = client({ timeoutMs: 300 });

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('fails the waiting requests when it is closed', async () => {
        const admin = await channel();
        await admin.assertExchange(SILENT_EXCHANGE, 'direct', { durable: false });
        const { queue } = await admin.assertQueue('', { exclusive: true });
        await admin.bindQueue(queue, SILENT_EXCHANGE, RabbitMqNames.ROUTING_KEY);
        const requestClient = client();
        const waiting = request(requestClient, 'SilentOf', {}, 'Name');
        const failure = expect(waiting).rejects.toThrow('closed');
        const received = await nextMessage(admin, queue);
        expect(received.properties.correlationId).toBeTruthy();

        await requestClient.close();

        await failure;
        await expect(request(requestClient, 'UserOf', {}, 'Name')).rejects.toThrow('closed');
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        // What FxMap's RabbitMqServer declares, consumes and replies
        const owner = await channel();
        await owner.assertQueue(QUEUE, { durable: false, exclusive: false, autoDelete: false });
        await owner.assertExchange(USER_EXCHANGE, 'direct', { durable: false });
        await owner.bindQueue(QUEUE, USER_EXCHANGE, 'fxmap-rpc-rounting-key');
        let received: ConsumeMessage | undefined;
        await owner.consume(QUEUE, message => {
            received = message!;
            owner.publish('', message!.properties.replyTo, Buffer.from('{"IsSuccess":true,"Data":{"Items":[{"Id":"1",'
                + '"Values":[{"Expression":"UserEmail","Value":"\\"alice@example.com\\""}]}],"Errors":[]},"Fault":null}'),
            { correlationId: message!.properties.correlationId });
            owner.ack(message!);
        });

        const response = await request(client(), 'UserOf', { tenant: 'a' }, 'UserEmail');

        expect(JSON.parse(received!.content.toString())).toEqual({ SelectorIds: ['1', '2'], Expressions: ['UserEmail'] });
        expect(received!.properties.type).toBe(ASSEMBLY_QUALIFIED_USER_OF);
        expect(received!.properties.replyTo).toMatch(/^fxmap-reply-[0-9a-f]{32}$/);
        expect(received!.properties.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(String(received!.properties.headers?.tenant)).toBe('a');
        expect(response.items).toEqual([{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }]);
    });

    it('answers what an FxMap client sends', async () => {
        await serve([users()]);
        // What FxMap's RabbitMqRequestClient sends: a DistributedMapRequest to the exchange of the key
        const requester = await channel();
        const replyQueue = `fxmap-reply-${randomUUID().replaceAll('-', '')}`;
        await requester.assertQueue(replyQueue, { durable: false, exclusive: true, autoDelete: true });
        const reply = nextMessage(requester, replyQueue);

        requester.publish(USER_EXCHANGE, 'fxmap-rpc-rounting-key',
            Buffer.from('{"SelectorIds":["2"],"Expressions":[null,"UserEmail"]}'),
            { correlationId: 'c-1', replyTo: replyQueue, type: ASSEMBLY_QUALIFIED_USER_OF, mandatory: true });

        const message = await reply;
        expect(message.properties.correlationId).toBe('c-1');
        expect(JSON.parse(message.content.toString())).toEqual({
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
    });

    it('finds the key by the exchange when the message has no type', async () => {
        await serve([users()]);
        const requester = await channel();
        const { queue } = await requester.assertQueue('', { exclusive: true });
        const reply = nextMessage(requester, queue);

        requester.publish(USER_EXCHANGE, RabbitMqNames.ROUTING_KEY, Buffer.from('{"SelectorIds":["1"],"Expressions":[null]}'),
            { correlationId: 'c-2', replyTo: queue });

        expect(JSON.parse((await reply).content.toString()).Data.Items).toEqual([
            { Id: '1', Values: [{ Expression: null, Value: '"Alice"' }] },
        ]);
    });

    it('answers at most maxConcurrentProcessing requests at once on each channel', async () => {
        let running = 0;
        let most = 0;
        const slow: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async () => {
                most = Math.max(most, ++running);
                await new Promise(resolve => setTimeout(resolve, 50));
                running--;
                return { items: [], errors: [] };
            },
        };
        await serve([slow], { channelPoolSize: 1, maxConcurrentProcessing: 2 });
        const requestClient = client();

        await Promise.all(Array.from({ length: 6 }, () => request(requestClient, 'UserOf', {}, null)));

        expect(most).toBe(2);
    });

    it('answers the requests it received before it is closed', async () => {
        let release!: () => void;
        const released = new Promise<void>(resolve => {
            release = resolve;
        });
        let started!: () => void;
        const handling = new Promise<void>(resolve => {
            started = resolve;
        });
        const blocked: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async () => {
                started();
                await released;
                return { items: [{ id: '1', values: [] }], errors: [] };
            },
        };
        const server = await serve([blocked]);
        const response = request(client(), 'UserOf', {}, null);
        await handling;

        const closing = server.close();
        release();
        await closing;

        expect((await response).items).toEqual([{ id: '1', values: [] }]);
        expect(server.isRunning()).toBe(false);
    });

    it('can start and close repeatedly', async () => {
        const server = await serve([users()]);
        await server.start();
        await server.close();
        await server.close();

        expect(server.isRunning()).toBe(false);
        await server.start();
        const response = await request(client(), 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    });

    it('retries a request until a server answers', async () => {
        let retries = 0;
        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: client(),
            // Nobody answers the first attempt; the server is up for the second
            retryPolicy: RetryPolicy.retries(3).delay(100).onRetry(async () => {
                if (++retries === 1) await serve([users()]);
            }),
            throwIfException: true,
        });
        const dtos = [new OrderDto(1), new OrderDto(2)];

        await mapper.map(dtos);

        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob']);
        expect(retries).toBe(1);
    });

    it('ends the run when the server is closed', async () => {
        const server = await serve([users()]);
        let ended = false;
        const run = server.whenStopped().then(() => {
            ended = true;
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(ended).toBe(false);

        await server.close();

        await run;
        expect(ended).toBe(true);
    });

    it('fails the run when its queue is deleted, and starts again', async () => {
        const server = await serve([users()]);

        await (await channel()).deleteQueue(QUEUE);

        // The broker cancels the consumers
        await expect(server.whenStopped()).rejects.toThrow('cancelled the consumer');
        expect(server.isRunning()).toBe(false);
        await server.start();
        const response = await request(client(), 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    });

    it('fails the run when the connection closes under it', async () => {
        const server = await serve([users()]);

        await connection.close();

        await expect(server.whenStopped()).rejects.toThrow();
        expect(server.isRunning()).toBe(false);
        await expect(server.start()).rejects.toThrow();
    });

    it('opens its channels again after the reply queue is deleted', async () => {
        await serve([users()]);
        const requestClient = client();
        const first = await request(requestClient, 'UserOf', {}, null);
        expect(first.items).toHaveLength(2);
        const replyQueue = (await capturedReplyQueue(requestClient))!;

        await (await channel()).deleteQueue(replyQueue);
        await new Promise(resolve => setTimeout(resolve, 100));

        const second = await request(requestClient, 'UserOf', {}, null);
        expect(second.items).toHaveLength(2);
    });
});

function nextMessage(channel: Channel, queue: string): Promise<ConsumeMessage> {
    return new Promise((resolve, reject) => {
        channel.consume(queue, message => {
            if (message === null) reject(new Error('cancelled'));
            else resolve(message);
        }, { noAck: true }).catch(reject);
    });
}

// The reply queue of a client is private; the test reads it to delete it
function capturedReplyQueue(requestClient: RabbitMqRequestClient): Promise<string | undefined> {
    return Promise.resolve((requestClient as unknown as { replyQueue: string }).replyQueue);
}
