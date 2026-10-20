import { DistributedKeyAssignedToMultipleEntitiesError, EntityConfigureOf, InMemoryQueryHandler } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { type AmqpConnection, RabbitMqRequestClient, RabbitMqServer } from '../src/index.js';

// Never used: the constructors only keep it
const CONNECTION = new Proxy({}, {
    get: (_, name) => {
        throw new Error(`unexpected ${String(name)}`);
    },
}) as AmqpConnection;

class User {
    constructor(readonly id: number, readonly name: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.useDistributedKey('Shop.UserOf');
    }
}

describe('what the client and the server check before they touch the connection', () => {
    it('the client needs a connection and a positive timeout', () => {
        expect(() => new RabbitMqRequestClient(undefined as unknown as AmqpConnection)).toThrow(TypeError);
        expect(() => new RabbitMqRequestClient(CONNECTION, { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new RabbitMqRequestClient(CONNECTION, { timeoutMs: -1 })).toThrow(RangeError);
        const client = new RabbitMqRequestClient(CONNECTION, { timeoutMs: 1000 });
        expect(client.transport).toBe('rabbitmq');
        expect(client.timeoutMs).toBe(1000);
        expect(client.pendingRequests).toBe(0);
        expect(new RabbitMqRequestClient(CONNECTION).timeoutMs).toBe(30_000);
    });

    it('a closed client refuses requests', async () => {
        const client = new RabbitMqRequestClient(CONNECTION);
        await client.close();
        await client.close();

        await expect(client.request('UserOf', { selectorIds: ['1'], expressions: [null] }, undefined as never))
            .rejects.toThrow('closed');
    });

    it('the server binds the exchange of each key to the queue of the service', async () => {
        const server = new RabbitMqServer(CONNECTION, 'UserService', [new InMemoryQueryHandler(new UserConfig(), [])]);

        expect(server.queue).toBe('fxmap-rpc-queue-userservice');
        expect(server.keys).toEqual(['Shop.UserOf']);
        expect(server.exchanges).toEqual(new Map([['Shop.UserOf', 'FxMap-Shop:UserOf']]));
        expect(server.channelPoolSize).toBe(5);
        expect(server.maxConcurrentProcessing).toBe(128);
        expect(server.isRunning()).toBe(false);
        await expect(server.whenStopped()).resolves.toBeUndefined();
        await server.close();
    });

    it('a server without keys does not start', async () => {
        const server = new RabbitMqServer(CONNECTION, 'UserService', []);

        await server.start();

        expect(server.isRunning()).toBe(false);
    });

    it('the server rejects bad options and shared keys', () => {
        const handler = new InMemoryQueryHandler(new UserConfig(), []);

        expect(() => new RabbitMqServer(CONNECTION, 'S', [], { channelPoolSize: 0 })).toThrow(RangeError);
        expect(() => new RabbitMqServer(CONNECTION, 'S', [], { maxConcurrentProcessing: 0 })).toThrow(RangeError);
        expect(() => new RabbitMqServer(CONNECTION, 'S', [], { maxConcurrentProcessing: 1.5 })).toThrow(RangeError);
        expect(() => new RabbitMqServer(CONNECTION, 'S', [], { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new RabbitMqServer(CONNECTION, ' ', [])).toThrow(RangeError);
        expect(() => new RabbitMqServer(undefined as unknown as AmqpConnection, 'S', [])).toThrow(TypeError);
        expect(() => new RabbitMqServer(CONNECTION, 'S', [handler, handler]))
            .toThrow(DistributedKeyAssignedToMultipleEntitiesError);
    });
});
