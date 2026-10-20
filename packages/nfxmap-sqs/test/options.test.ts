import { SQSClient } from '@aws-sdk/client-sqs';
import { InMemoryQueryHandler, EntityConfigureOf } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { SqsRequestClient, SqsServer } from '../src/index.js';

class User {
    constructor(readonly id: number) {}
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

const sqs = new SQSClient({ region: 'us-east-1' });

describe('options', () => {
    it("defaults to FxMap's values", () => {
        const client = new SqsRequestClient(sqs);
        expect([client.transport, client.timeoutMs, client.waitTimeSeconds]).toEqual(['sqs', 30_000, 20]);
        const server = new SqsServer(sqs, [new InMemoryQueryHandler(new UserConfig(), [])]);
        expect([server.waitTimeSeconds, server.maxConcurrentProcessing, server.keys]).toEqual([20, 128, ['UserOf']]);
        expect(server.isRunning()).toBe(false);
        expect(server.queueUrls.size).toBe(0);
    });

    it('refuses what cannot work', () => {
        expect(() => new SqsRequestClient(undefined as unknown as SQSClient)).toThrow(TypeError);
        expect(() => new SqsRequestClient(sqs, { timeoutMs: 0 })).toThrow(RangeError);
        expect(() => new SqsRequestClient(sqs, { waitTimeSeconds: 21 })).toThrow(RangeError);
        expect(() => new SqsRequestClient(sqs, { waitTimeSeconds: 1.5 })).toThrow(RangeError);
        expect(() => new SqsServer(undefined as unknown as SQSClient, [])).toThrow(TypeError);
        expect(() => new SqsServer(sqs, [], { maxConcurrentProcessing: 0 })).toThrow(RangeError);
        expect(() => new SqsServer(sqs, [], { waitTimeSeconds: -1 })).toThrow(RangeError);
        expect(() => new SqsServer(sqs, [], { timeoutMs: -5 })).toThrow(RangeError);
    });

    it('does not start without a key', async () => {
        const server = new SqsServer(sqs, []);
        await server.start();
        expect(server.isRunning()).toBe(false);
    });

    it('refuses requests once closed', async () => {
        const client = new SqsRequestClient(sqs);
        await client.close();
        expect(await client.responseQueueUrl()).toBeNull();
        await expect(client.request('UserOf', { selectorIds: [], expressions: [] }, { headers: {} } as never))
            .rejects.toThrow('closed');
    });
});
