import { connect } from '@nats-io/transport-node';
import type { NatsConnection, Subscription } from '@nats-io/nats-core';
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
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NatsRequestClient, NatsServer, type NatsServerOptions } from '../src/index.js';
import { startNatsServer } from './nats-server.js';

const nats = await startNatsServer();

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

/** The client and the server against a real NATS server, and the messages they exchange with FxMap's. */
describe.skipIf(nats === null)('NATS transport', () => {
    let connection: NatsConnection;
    const closeables: (() => unknown)[] = [];

    afterAll(() => nats?.stop());

    beforeEach(async () => {
        connection = await connect({ servers: nats!.url });
    });

    afterEach(async () => {
        for (const close of closeables.splice(0)) await close();
        await connection.close();
    });

    async function serve(handlers: QueryHandler[], options: NatsServerOptions = {}): Promise<NatsServer> {
        const server = new NatsServer(connection, handlers, { logger: silentLogger, ...options });
        await server.start();
        closeables.push(() => server.close());
        await connection.flush();
        return server;
    }

    function subscribe(subject: string, answer: (data: Uint8Array, reply: string) => void): Subscription {
        const subscription = connection.subscribe(subject, {
            callback: (error, message) => {
                if (error === null && message.reply) answer(message.data, message.reply);
            },
        });
        closeables.push(() => subscription.unsubscribe());
        return subscription;
    }

    const request = (client: NatsRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        client.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    it('maps a DTO through NATS', async () => {
        await serve([users()]);
        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: new NatsRequestClient(connection),
            throwIfException: true,
        });
        const dtos = [new OrderDto(1), new OrderDto(2), new OrderDto(3)];

        await mapper.map(dtos);

        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob', null]);
        expect(dtos.map(d => d.userEmail)).toEqual(['alice@example.com', 'bob@example.com', null]);
    });

    it('carries the headers and the topic prefix', async () => {
        let seen: MapContext | undefined;
        const recording: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async (_: MapRequest, context: MapContext) => {
                seen = context;
                return { items: [], errors: [] };
            },
        };
        await serve([recording], { topicPrefix: 'tenant1' });
        const client = new NatsRequestClient(connection, { topicPrefix: 'tenant1' });

        await request(client, 'UserOf', { authorization: 'Bearer x' }, null);

        expect(seen?.headers).toEqual({ authorization: 'Bearer x' });
    });

    it('brings an owner failure back as a received fault', async () => {
        const failing = new InMemoryQueryHandler(new UserConfig(), () => {
            throw new Error('database down');
        });
        await serve([failing]);

        const failure = request(new NatsRequestClient(connection), 'UserOf', {}, 'Name');

        await expect(failure).rejects.toBeInstanceOf(ReceivedFaultError);
        await expect(failure).rejects.toThrow('database down');
    });

    it('fails at once for a key that nobody serves', async () => {
        await expect(request(new NatsRequestClient(connection), 'NobodyOf', {}, 'Name'))
            .rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
    });

    it('times out when the reply does not come', async () => {
        subscribe('fxmap--silentof', () => undefined);
        await connection.flush();
        const client = new NatsRequestClient(connection, { timeoutMs: 300 });

        await expect(request(client, 'SilentOf', {}, 'Name')).rejects.toBeInstanceOf(RequestTimedOutError);
    });

    it('fails when the connection closes before the reply', async () => {
        subscribe('fxmap--silentof', () => undefined);
        await connection.flush();
        const pending = request(new NatsRequestClient(connection), 'SilentOf', {}, 'Name');

        await connection.close();

        await expect(pending).rejects.toThrow('The NATS connection closed before the reply for SilentOf came.');
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        let received: string | undefined;
        // What FxMap's NatsServer would do: read a DistributedMapRequest, reply with a Result (System.Text.Json)
        subscribe('fxmap--userof', (data, reply) => {
            received = new TextDecoder().decode(data);
            connection.publish(reply, '{"IsSuccess":true,"Data":{"Items":[{"Id":"1",'
                + '"Values":[{"Expression":"UserEmail","Value":"\\"alice@example.com\\""}]}],"Errors":[]}}');
        });
        await connection.flush();

        const response = await request(new NatsRequestClient(connection), 'UserOf', {}, 'UserEmail');

        expect(JSON.parse(received!)).toEqual({ SelectorIds: ['1', '2'], Expressions: ['UserEmail'] });
        expect(response.items).toEqual([{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }]);
    });

    it('answers what an FxMap client sends', async () => {
        await serve([users()]);

        // What FxMap's NatsRequestClient sends: a DistributedMapRequest on the subject of the key
        const reply = await connection.request('fxmap--userof', '{"SelectorIds":["2"],"Expressions":[null,"UserEmail"]}',
            { timeout: 5000 });

        expect(reply.json()).toEqual({
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

    it('answers at most maxConcurrentProcessing requests at once', async () => {
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
        await serve([slow], { maxConcurrentProcessing: 2 });
        const client = new NatsRequestClient(connection);

        await Promise.all(Array.from({ length: 6 }, () => request(client, 'UserOf', {}, null)));

        expect(most).toBe(2);
    });

    it('can start and close repeatedly', async () => {
        const server = await serve([users()]);
        await server.start();
        await server.close();
        await server.close();

        expect(server.isRunning()).toBe(false);
        await server.start();
        await connection.flush();
        const response = await request(new NatsRequestClient(connection), 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    });

    it('retries a request until a server answers', async () => {
        let retries = 0;
        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: new NatsRequestClient(connection),
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
        const server = new NatsServer(connection, [users()], { logger: silentLogger });
        await server.start();
        let ended = false;
        const run = server.whenStopped().then(() => {
            ended = true;
        });
        await connection.flush();
        expect(ended).toBe(false);

        await server.close();

        await run;
        expect(ended).toBe(true);
        expect(server.isRunning()).toBe(false);
        await server.start();
        let endedAgain = false;
        void server.whenStopped().then(() => {
            endedAgain = true;
        });
        await connection.flush();
        expect(endedAgain).toBe(false);
        await server.close();
    });

    it('fails the run when the connection closes under it', async () => {
        const server = new NatsServer(connection, [users()], { logger: silentLogger });
        await server.start();

        await connection.close();

        await expect(server.whenStopped()).rejects.toThrow('the connection closed');
        expect(server.isRunning()).toBe(false);
        await expect(server.start()).rejects.toThrow();
    });
});
