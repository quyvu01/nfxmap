import {
    CreateQueueCommand,
    DeleteQueueCommand,
    GetQueueUrlCommand,
    type Message,
    ReceiveMessageCommand,
    SendMessageCommand,
    SQSClient,
} from '@aws-sdk/client-sqs';
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
    SqsNames,
    SqsRequestClient,
    type SqsRequestClientOptions,
    SqsServer,
    type SqsServerOptions,
} from '../src/index.js';

/** The SQS endpoint of the integration tests (ElasticMQ or LocalStack): `SQS_ENDPOINT`; skipped when it is not set. */
const SQS_ENDPOINT = process.env.SQS_ENDPOINT;

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
const USER_QUEUE = 'fxmap--userof';
const SILENT_QUEUE = 'fxmap--silentof';
const ASSEMBLY_QUALIFIED_USER_OF =
    'UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null';
// Short polls, so that the tests do not wait on a poll in progress
const FAST = { waitTimeSeconds: 1 };

/** The client and the server against a real SQS endpoint, and the messages they exchange with FxMap's. */
describe.skipIf(!SQS_ENDPOINT)('SQS transport', () => {
    const sqs = new SQSClient({
        endpoint: SQS_ENDPOINT,
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const closeables: (() => unknown)[] = [];

    beforeEach(async () => {
        // Each test starts without the queues and the messages of the others
        for (const name of [USER_QUEUE, SILENT_QUEUE]) {
            const url = await queueUrl(name);
            if (url !== null) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
        }
    });

    afterEach(async () => {
        for (const close of closeables.splice(0).reverse()) await close();
    });

    async function queueUrl(name: string): Promise<string | null> {
        try {
            return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl ?? null;
        } catch {
            return null;
        }
    }

    async function createQueue(name: string): Promise<string> {
        return (await sqs.send(new CreateQueueCommand({ QueueName: name }))).QueueUrl!;
    }

    async function nextMessage(url: string): Promise<Message> {
        for (;;) {
            const { Messages } = await sqs.send(new ReceiveMessageCommand({
                QueueUrl: url, WaitTimeSeconds: 1, MaxNumberOfMessages: 1, MessageAttributeNames: ['All'],
            }));
            if (Messages?.length) return Messages[0];
        }
    }

    async function serve(handlers: QueryHandler[], options: SqsServerOptions = {}): Promise<SqsServer> {
        const server = new SqsServer(sqs, handlers, { logger: silentLogger, ...FAST, ...options });
        await server.start();
        closeables.push(() => server.close());
        return server;
    }

    function client(options: SqsRequestClientOptions = {}): SqsRequestClient {
        const created = new SqsRequestClient(sqs, { timeoutMs: 10_000, logger: silentLogger, ...FAST, ...options });
        closeables.push(() => created.close());
        return created;
    }

    const request = (requestClient: SqsRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        requestClient.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    it('maps a DTO through SQS', async () => {
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

    it('carries the headers, with the attributes of the request, as FxMap does', async () => {
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

        await request(client(), 'UserOf', { authorization: 'Bearer x', empty: '', 'not allowed': 'x' }, null);

        expect(seen?.headers.authorization).toBe('Bearer x');
        expect(seen?.headers.Type).toBe(ASSEMBLY_QUALIFIED_USER_OF);
        expect(Object.keys(seen!.headers).sort()).toEqual(['CorrelationId', 'ReplyTo', 'Type', 'authorization']);
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

    it('fails at once for a key without queue', async () => {
        const requestClient = client();

        await expect(request(requestClient, 'NobodyOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('fails at once when the queue of a key was deleted since it was found', async () => {
        const url = await createQueue(SILENT_QUEUE);
        const requestClient = client({ timeoutMs: 300 });
        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);

        await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('times out when the reply does not come', async () => {
        await createQueue(SILENT_QUEUE);
        const requestClient = client({ timeoutMs: 300 });

        await expect(request(requestClient, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);
        expect(requestClient.pendingRequests).toBe(0);
    });

    it('fails the waiting requests and deletes its response queue when it is closed', async () => {
        const silent = await createQueue(SILENT_QUEUE);
        const requestClient = client();
        const waiting = request(requestClient, 'SilentOf', {}, 'Name');
        const failure = expect(waiting).rejects.toThrow('closed');
        await nextMessage(silent);
        const responseQueue = (await requestClient.responseQueueUrl())!;

        await requestClient.close();

        await failure;
        await expect(request(requestClient, 'UserOf', {}, 'Name')).rejects.toThrow('closed');
        expect(await queueUrl(responseQueue.slice(responseQueue.lastIndexOf('/') + 1))).toBeNull();
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        // What FxMap's SqsServer polls and replies
        const owner = await createQueue(USER_QUEUE);
        const answering = nextMessage(owner).then(async message => {
            await sqs.send(new SendMessageCommand({
                QueueUrl: message.MessageAttributes!.ReplyTo.StringValue,
                MessageBody: '{"IsSuccess":true,"Data":{"Items":[{"Id":"1","Values":[{"Expression":"UserEmail",'
                    + '"Value":"\\"alice@example.com\\""}]}],"Errors":[]},"Fault":null}',
                MessageAttributes: { CorrelationId: message.MessageAttributes!.CorrelationId },
            }));
            return message;
        });

        const response = await request(client({ machineName: 'Node.Host' }), 'UserOf', { tenant: 'a' }, 'UserEmail');

        const received = await answering;
        const attributes = received.MessageAttributes!;
        expect(JSON.parse(received.Body!)).toEqual({ SelectorIds: ['1', '2'], Expressions: ['UserEmail'] });
        expect(attributes.Type.StringValue).toBe(ASSEMBLY_QUALIFIED_USER_OF);
        expect(attributes.ReplyTo.StringValue).toMatch(/\/fxmap-response-nodehost-[0-9a-f-]{36}$/);
        expect(attributes.CorrelationId.StringValue).toMatch(/^[0-9a-f-]{36}$/);
        expect(attributes.tenant).toEqual({ DataType: 'String', StringValue: 'a' });
        expect(response.items).toEqual([{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }]);
    });

    it('answers what an FxMap client sends', async () => {
        const server = await serve([users()]);
        // What FxMap's SqsRequestClient sends: a DistributedMapRequest to the queue of the key
        const replyQueue = await createQueue(SqsNames.responseQueue('dotnet'));
        closeables.push(() => sqs.send(new DeleteQueueCommand({ QueueUrl: replyQueue })));

        await sqs.send(new SendMessageCommand({
            QueueUrl: server.queueUrls.get('UserOf'),
            MessageBody: '{"SelectorIds":["2"],"Expressions":[null,"UserEmail"]}',
            MessageAttributes: {
                CorrelationId: { DataType: 'String', StringValue: 'c-1' },
                ReplyTo: { DataType: 'String', StringValue: replyQueue },
                Type: { DataType: 'String', StringValue: ASSEMBLY_QUALIFIED_USER_OF },
            },
        }));

        const message = await nextMessage(replyQueue);
        expect(message.MessageAttributes?.CorrelationId?.StringValue).toBe('c-1');
        expect(JSON.parse(message.Body!)).toEqual({
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

    it('finds the key by the queue when the message has no type', async () => {
        const server = await serve([users()]);
        const replyQueue = await createQueue(SqsNames.responseQueue('untyped'));
        closeables.push(() => sqs.send(new DeleteQueueCommand({ QueueUrl: replyQueue })));

        await sqs.send(new SendMessageCommand({
            QueueUrl: server.queueUrls.get('UserOf'),
            MessageBody: '{"SelectorIds":["1"],"Expressions":[null]}',
            MessageAttributes: { ReplyTo: { DataType: 'String', StringValue: replyQueue } },
        }));

        const message = await nextMessage(replyQueue);
        expect(message.MessageAttributes?.CorrelationId?.StringValue).toBe('Unknown');
        expect(JSON.parse(message.Body!).Data.Items).toEqual([{ Id: '1', Values: [{ Expression: null, Value: '"Alice"' }] }]);
    });

    it('answers at most maxConcurrentProcessing requests at once', async () => {
        let running = 0;
        let most = 0;
        const slow: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async () => {
                most = Math.max(most, ++running);
                await new Promise(resolve => setTimeout(resolve, 100));
                running--;
                return { items: [], errors: [] };
            },
        };
        await serve([slow], { maxConcurrentProcessing: 2 });
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
            // No queue for the first attempt; the server is up for the second
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

        await sqs.send(new DeleteQueueCommand({ QueueUrl: server.queueUrls.get('UserOf') }));

        await expect(server.whenStopped()).rejects.toThrow();
        expect(server.isRunning()).toBe(false);
        await server.start();
        const response = await request(client(), 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    }, 30_000);
});
