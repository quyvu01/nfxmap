import { describe, expect, it } from 'vitest';
import { SqsNames } from '../src/index.js';
import { isAttributeName, isQueueDoesNotExist } from '../src/sqs.js';

describe('SqsNames', () => {
    it('names the queue of a key as FxMap names it', () => {
        expect(SqsNames.queue('UserOf')).toBe('fxmap--userof');
        expect(SqsNames.queue('Shop.Keys.UserOf')).toBe('fxmap-shop-keys-userof');
    });

    it('names a response queue after the machine, within what SQS allows', () => {
        expect(SqsNames.responseQueue('Build-01')).toMatch(/^fxmap-response-build-01-[0-9a-f-]{36}$/);
        expect(SqsNames.responseQueue('my.host.local')).toMatch(/^fxmap-response-myhostlocal-[0-9a-f-]{36}$/);
        const long = SqsNames.responseQueue('x'.repeat(200));
        expect(long).toHaveLength(80);
        expect(long).toMatch(/^[a-z0-9_-]+$/);
        expect(SqsNames.responseQueue('')).toMatch(/^fxmap-response--[0-9a-f-]{36}$/);
    });

    it('names the attributes as FxMap does', () => {
        expect([SqsNames.CORRELATION_ID, SqsNames.REPLY_TO, SqsNames.TYPE]).toEqual(['CorrelationId', 'ReplyTo', 'Type']);
    });
});

describe('message attributes', () => {
    it('lets through the names SQS allows', () => {
        for (const name of ['authorization', 'x-tenant', 'trace.id', 'A_1']) expect(isAttributeName(name)).toBe(true);
    });

    it('keeps back the names SQS refuses', () => {
        for (const name of ['', 'has space', '.lead', 'trail.', 'two..dots', 'AWS.trace', 'amazon.x', 'é', 'a'.repeat(257)])
            expect(isAttributeName(name)).toBe(false);
    });

    it('knows the error of a missing queue, in the JSON and the query protocols', () => {
        expect(isQueueDoesNotExist({ name: 'QueueDoesNotExist' })).toBe(true);
        expect(isQueueDoesNotExist({ name: 'AWS.SimpleQueueService.NonExistentQueue' })).toBe(true);
        expect(isQueueDoesNotExist({ name: 'Error', Code: 'AWS.SimpleQueueService.NonExistentQueue' })).toBe(true);
        expect(isQueueDoesNotExist(new Error('other'))).toBe(false);
        expect(isQueueDoesNotExist(null)).toBe(false);
    });
});
