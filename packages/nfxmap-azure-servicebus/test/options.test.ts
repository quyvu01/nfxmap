import { ServiceBusClient } from '@azure/service-bus';
import { EntityConfigureOf, InMemoryQueryHandler } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { ServiceBusRequestClient, ServiceBusServer } from '../src/index.js';

class User {
    constructor(readonly id: number) {}
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

// Nothing connects before a link is opened
const sb = new ServiceBusClient('Endpoint=sb://localhost;SharedAccessKeyName=key;SharedAccessKey=value');

describe('options', () => {
    it("defaults to FxMap's values", () => {
        const client = new ServiceBusRequestClient(sb);
        expect([client.transport, client.timeoutMs, client.topicPrefix]).toEqual(['azureservicebus', 30_000, null]);
        expect(client.sessionId).toMatch(/^[0-9a-f-]{36}$/);
        const server = new ServiceBusServer(sb, [new InMemoryQueryHandler(new UserConfig(), [])], { topicPrefix: 'tenant' });
        expect([server.maxConcurrentSessions, server.sessionIdleTimeoutMs, server.keys]).toEqual([8, 1_000, ['Shop.UserOf']]);
        expect(server.requestQueues).toEqual(new Map([['Shop.UserOf', 'tenant-fxmap-request-shop-userof']]));
        expect(server.isRunning()).toBe(false);
    });

    it('refuses what cannot work', () => {
        expect(() => new ServiceBusRequestClient(undefined as unknown as ServiceBusClient)).toThrow(TypeError);
        expect(() => new ServiceBusRequestClient(sb, { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new ServiceBusServer(undefined as unknown as ServiceBusClient, [])).toThrow(TypeError);
        expect(() => new ServiceBusServer(sb, [], { maxConcurrentSessions: 0 })).toThrow(RangeError);
        expect(() => new ServiceBusServer(sb, [], { sessionIdleTimeoutMs: 0 })).toThrow(RangeError);
        expect(() => new ServiceBusServer(sb, [], { timeoutMs: -1 })).toThrow(RangeError);
    });

    it('does not start without a key', async () => {
        const server = new ServiceBusServer(sb, []);
        await server.start();
        expect(server.isRunning()).toBe(false);
    });

    it('refuses requests once closed', async () => {
        const client = new ServiceBusRequestClient(sb);
        await client.close();
        await expect(client.request('UserOf', { selectorIds: [], expressions: [] }, { headers: {} } as never))
            .rejects.toThrow('closed');
    });
});
