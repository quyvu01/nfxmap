import type { Kafka } from 'kafkajs';
import { DistributedKeyAssignedToMultipleEntitiesError, EntityConfigureOf, InMemoryQueryHandler } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { KafkaRequestClient, KafkaServer } from '../src/index.js';

// Never used: the constructors only keep it
const KAFKA = new Proxy({}, {
    get: (_, name) => {
        throw new Error(`unexpected ${String(name)}`);
    },
}) as Kafka;

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

describe('what the client and the server check before they touch Kafka', () => {
    it('the client needs a Kafka client, a name and positive options', () => {
        expect(() => new KafkaRequestClient(undefined as unknown as Kafka, 'S')).toThrow(TypeError);
        expect(() => new KafkaRequestClient(KAFKA, ' ')).toThrow(RangeError);
        expect(() => new KafkaRequestClient(KAFKA, 'S', { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new KafkaRequestClient(KAFKA, 'S', { replicationFactor: 0 })).toThrow(RangeError);
        const client = new KafkaRequestClient(KAFKA, 'OrderService', { timeoutMs: 1000 });
        expect(client.transport).toBe('kafka');
        expect(client.timeoutMs).toBe(1000);
        expect(client.replicationFactor).toBe(1);
        expect(client.pendingRequests).toBe(0);
        expect(client.replyTopic).toMatch(/^fxmap-response-topic-orderservice-/);
        expect(new KafkaRequestClient(KAFKA, 'S').timeoutMs).toBe(30_000);
    });

    it('a closed client refuses requests', async () => {
        const client = new KafkaRequestClient(KAFKA, 'S');
        await client.close();
        await client.close();

        await expect(client.request('UserOf', { selectorIds: ['1'], expressions: [null] }, undefined as never))
            .rejects.toThrow('closed');
    });

    it('the server reads the request topic of each key', async () => {
        const server = new KafkaServer(KAFKA, [new InMemoryQueryHandler(new UserConfig(), [])]);

        expect(server.keys).toEqual(['Shop.UserOf']);
        expect(server.topics).toEqual(new Map([['Shop.UserOf', 'fxmap-request-topic-shop.userof']]));
        expect(server.partitions).toBe(1);
        expect(server.replicationFactor).toBe(1);
        expect(server.maxConcurrentProcessing).toBe(128);
        expect(server.isRunning()).toBe(false);
        await expect(server.whenStopped()).resolves.toBeUndefined();
        await server.close();
    });

    it('a server without keys does not start', async () => {
        const server = new KafkaServer(KAFKA, []);

        await server.start();

        expect(server.isRunning()).toBe(false);
    });

    it('the server rejects bad options and shared keys', () => {
        const handler = new InMemoryQueryHandler(new UserConfig(), []);

        expect(() => new KafkaServer(KAFKA, [], { partitions: 0 })).toThrow(RangeError);
        expect(() => new KafkaServer(KAFKA, [], { replicationFactor: 0 })).toThrow(RangeError);
        expect(() => new KafkaServer(KAFKA, [], { maxConcurrentProcessing: 1.5 })).toThrow(RangeError);
        expect(() => new KafkaServer(KAFKA, [], { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new KafkaServer(undefined as unknown as Kafka, [])).toThrow(TypeError);
        expect(() => new KafkaServer(KAFKA, [handler, handler])).toThrow(DistributedKeyAssignedToMultipleEntitiesError);
    });
});
