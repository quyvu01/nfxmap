import { randomUUID } from 'node:crypto';
import { type ServiceBusReceivedMessage, ServiceBusClient } from '@azure/service-bus';
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
    ServiceBusRequestClient,
    type ServiceBusRequestClientOptions,
    ServiceBusServer,
    type ServiceBusServerOptions,
} from '../src/index.js';

/**
 * The Service Bus emulator of the integration tests: `SERVICEBUS_CONNECTION_STRING`; the tests are skipped when it is
 * not set. The emulator has no management API: its queues are declared in servicebus-emulator.json.
 */
const CONNECTION_STRING = process.env.SERVICEBUS_CONNECTION_STRING;

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
const USER_REQUESTS = 'fxmap-request--userof';
const USER_REPLIES = 'fxmap-reply--userof';
const SILENT_REQUESTS = 'fxmap-request--silentof';

/** The client and the server against the Service Bus emulator, and the messages they exchange with FxMap's. */
describe.skipIf(!CONNECTION_STRING)('Azure Service Bus transport', () => {
    let sb: ServiceBusClient;
    const closeables: (() => unknown)[] = [];

    beforeEach(() => {
        // The emulator answers a wait for the next session only when it times out: a short one picks up new sessions
        sb = new ServiceBusClient(CONNECTION_STRING!, { retryOptions: { timeoutInMs: 3_000 } });
    });

    afterEach(async () => {
        for (const close of closeables.splice(0).reverse()) await close();
        await sb.close();
    });

    async function serve(handlers: QueryHandler[], options: ServiceBusServerOptions = {}): Promise<ServiceBusServer> {
        // One reader per server: the emulator keeps the waits of a closed reader, which can take a later session
        const server = new ServiceBusServer(sb, handlers, { logger: silentLogger, maxConcurrentSessions: 1, ...options });
        await server.start();
        closeables.push(() => server.close());
        return server;
    }

    function client(options: ServiceBusRequestClientOptions = {}): ServiceBusRequestClient {
        const created = new ServiceBusRequestClient(sb, { timeoutMs: 15_000, logger: silentLogger, ...options });
        closeables.push(() => created.close());
        return created;
    }

    const request = (requestClient: ServiceBusRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        requestClient.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    /** The next message of a session queue, completed: of the given session, or of any. */
    async function receiveOne(queue: string, sessionId?: string): Promise<ServiceBusReceivedMessage> {
        const receiver = sessionId === undefined
            ? await sb.acceptNextSession(queue, { skipParsingBodyAsJson: true })
            : await sb.acceptSession(queue, sessionId, { skipParsingBodyAsJson: true });
        try {
            for (let i = 0; i < 10; i++) {
                const [message] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 3_000 });
                if (message !== undefined) {
                    await receiver.completeMessage(message);
                    return message;
                }
            }
            throw new Error(`No message on ${queue}`);
        } finally {
            await receiver.close();
        }
    }

    it('maps a DTO through Service Bus', async () => {
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

    it('carries the headers, but the trace context', async () => {
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

        await request(client(), 'UserOf', { authorization: 'Bearer x', traceparent: '00-abc-def-01' }, null);

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

    it('fails at once for a key without queues', async () => {
        const requestClient = client();

        await expect(request(requestClient, 'NobodyOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('times out when the reply does not come', async () => {
        const requestClient = client({ timeoutMs: 500 });

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);
        expect(requestClient.pendingRequests).toBe(0);
        await receiveOne(SILENT_REQUESTS, requestClient.sessionId);
    });

    it('fails the waiting requests when it is closed', async () => {
        const requestClient = client();
        const waiting = request(requestClient, 'SilentOf', {}, 'Name');
        const failure = expect(waiting).rejects.toThrow('closed');
        await receiveOne(SILENT_REQUESTS, requestClient.sessionId);

        await requestClient.close();

        await failure;
        await expect(request(requestClient, 'UserOf', {}, 'Name')).rejects.toThrow('closed');
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        const requestClient = client();
        // What FxMap's AzureServiceBusServer receives and replies
        const answering = receiveOne(USER_REQUESTS, requestClient.sessionId).then(async message => {
            const sender = sb.createSender(message.replyTo!);
            await sender.sendMessages({
                body: Buffer.from('{"IsSuccess":true,"Data":{"Items":[{"Id":"1","Values":[{"Expression":"UserEmail",'
                    + '"Value":"\\"alice@example.com\\""}]}],"Errors":[]},"Fault":null}'),
                correlationId: message.correlationId,
                sessionId: message.sessionId,
            });
            await sender.close();
            return message;
        });

        const response = await request(requestClient, 'UserOf', { tenant: 'a' }, 'UserEmail');

        const received = await answering;
        expect(JSON.parse(Buffer.from(received.body).toString())).toEqual({ SelectorIds: ['1', '2'], Expressions: ['UserEmail'] });
        expect(received.replyTo).toBe(USER_REPLIES);
        expect(received.sessionId).toBe(requestClient.sessionId);
        expect(String(received.correlationId)).toMatch(/^[0-9a-f-]{36}$/);
        expect(received.applicationProperties).toEqual({ tenant: 'a' });
        expect(response.items).toEqual([{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }]);
    });

    it('answers what an FxMap client sends', async () => {
        await serve([users()]);
        // What FxMap's OpenAzureServiceBusClient sends: a DistributedMapRequest in the session of the client
        const sessionId = randomUUID();
        const sender = sb.createSender(USER_REQUESTS);
        closeables.push(() => sender.close());

        await sender.sendMessages({
            body: Buffer.from('{"SelectorIds":["2"],"Expressions":[null,"UserEmail"]}'),
            correlationId: 'c-1',
            replyTo: USER_REPLIES,
            sessionId,
            applicationProperties: { tenant: 'a' },
        });

        const message = await receiveOne(USER_REPLIES, sessionId);
        expect(message.correlationId).toBe('c-1');
        expect(JSON.parse(Buffer.from(message.body).toString())).toEqual({
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

    it('uses the prefixed queues of a topic prefix', async () => {
        await serve([users()], { topicPrefix: 'tenant' });

        const response = await request(client({ topicPrefix: 'tenant' }), 'UserOf', {}, null);

        expect(response.items).toHaveLength(2);
    });

    it('creates the missing queues with an administration client', async () => {
        const created: string[] = [];
        const administration = {
            queueExists: async (queue: string) => queue.startsWith('fxmap-request'),
            createQueue: async (queue: string, options: { requiresSession: boolean }) => {
                expect(options.requiresSession).toBe(true);
                created.push(queue);
            },
        };

        await serve([users()], { administration });

        expect(created).toEqual([USER_REPLIES]);
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
            requestClient: client({ timeoutMs: 1_000 }),
            // Nobody answers the first attempt; the server is up for the second
            retryPolicy: RetryPolicy.retries(3).delay(100).onRetry(async () => {
                if (++retries === 1) await serve([users()]);
            }),
            throwIfException: true,
        });
        const dtos = [new OrderDto(1), new OrderDto(2)];

        await mapper.map(dtos);

        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob']);
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

    it('fails the run when its request queue does not exist', async () => {
        const server = new ServiceBusServer(sb, [users()], { logger: silentLogger, maxConcurrentSessions: 1,
            topicPrefix: 'missing' });
        closeables.push(() => server.close());

        await server.start();

        await expect(server.whenStopped()).rejects.toThrow();
        expect(server.isRunning()).toBe(false);
    });
}, 60_000);
