import { headers, type NatsConnection } from '@nats-io/nats-core';
import { DistributedKeyAssignedToMultipleEntitiesError, EntityConfigureOf, InMemoryQueryHandler } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { NatsRequestClient, NatsServer, natsServerHeaders } from '../src/index.js';

// Never used: the constructors only keep it
const CONNECTION = new Proxy({}, {
    get: (_, name) => {
        throw new Error(`unexpected ${String(name)}`);
    },
}) as NatsConnection;

class User {
    constructor(readonly id: number, readonly name: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.useDistributedKey('UserOf');
    }
}

describe('what the client and the server check before they touch the connection', () => {
    it('the client needs a connection and a positive timeout', () => {
        expect(() => new NatsRequestClient(undefined as unknown as NatsConnection)).toThrow(TypeError);
        expect(() => new NatsRequestClient(CONNECTION, { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new NatsRequestClient(CONNECTION, { timeoutMs: -1 })).toThrow(RangeError);
        const client = new NatsRequestClient(CONNECTION, { topicPrefix: 'p', timeoutMs: 1000 });
        expect(client.transport).toBe('nats');
        expect(client.timeoutMs).toBe(1000);
        expect(new NatsRequestClient(CONNECTION).timeoutMs).toBe(30_000);
    });

    it('the server listens on the subject of each key', async () => {
        const server = new NatsServer(CONNECTION, [new InMemoryQueryHandler(new UserConfig(), [])], { topicPrefix: 'Prod' });

        expect(server.keys).toEqual(['UserOf']);
        expect(server.subjects).toEqual(new Map([['UserOf', 'prod-fxmap--userof']]));
        expect(server.isRunning()).toBe(false);
        await expect(server.whenStopped()).resolves.toBeUndefined();
        await server.close();
    });

    it('the server rejects bad options and shared keys', () => {
        const handler = new InMemoryQueryHandler(new UserConfig(), []);

        expect(() => new NatsServer(CONNECTION, [], { maxConcurrentProcessing: 0 })).toThrow(RangeError);
        expect(() => new NatsServer(CONNECTION, [], { maxConcurrentProcessing: 1.5 })).toThrow(RangeError);
        expect(() => new NatsServer(CONNECTION, [], { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new NatsServer(undefined as unknown as NatsConnection, [])).toThrow(TypeError);
        expect(() => new NatsServer(CONNECTION, [handler, handler])).toThrow(DistributedKeyAssignedToMultipleEntitiesError);
    });

    it('the headers of a message are their first values', () => {
        const h = headers();
        h.append('tenant', 'a');
        h.append('tenant', 'b');
        h.append('user', 'u');

        expect(natsServerHeaders(h)).toEqual({ tenant: 'a', user: 'u' });
        expect(natsServerHeaders(undefined)).toEqual({});
    });
});
