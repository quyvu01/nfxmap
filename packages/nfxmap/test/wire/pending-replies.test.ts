import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingReplies, RequestTimedOutError } from '../../src/index.js';

const bytes = (text: string) => Buffer.from(text);

describe('PendingReplies', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('completes a request with its reply', async () => {
        const pending = new PendingReplies();
        const reply = pending.register('c1', 'UserOf', 1000);

        expect(pending.size).toBe(1);
        expect(pending.complete('c1', bytes('ok'))).toBe(true);
        expect(Buffer.from(await reply).toString()).toBe('ok');
        expect(pending.size).toBe(0);
    });

    it('drops a reply that no request waits for', () => {
        const pending = new PendingReplies();

        expect(pending.complete('unknown', bytes('ok'))).toBe(false);
        expect(pending.complete(null, bytes('ok'))).toBe(false);
        expect(pending.complete(undefined, bytes('ok'))).toBe(false);
    });

    it('fails a request whose reply does not come in time', async () => {
        vi.useFakeTimers();
        const pending = new PendingReplies();
        const reply = pending.register('c1', 'UserOf', 50);
        const failure = expect(reply).rejects.toThrow(RequestTimedOutError);

        await vi.advanceTimersByTimeAsync(50);

        await failure;
        await expect(reply).rejects.toMatchObject({ key: 'UserOf', timeoutMs: 50 });
        expect(pending.size).toBe(0);
        // The reply that comes late is dropped
        expect(pending.complete('c1', bytes('late'))).toBe(false);
    });

    it('fails a request that was not sent', async () => {
        const pending = new PendingReplies();
        const reply = pending.register('c1', 'UserOf', 1000);
        const cause = new Error('not published');

        pending.fail('c1', cause);

        await expect(reply).rejects.toBe(cause);
        expect(pending.size).toBe(0);
    });

    it('fails every request that waits', async () => {
        const pending = new PendingReplies();
        const first = pending.register('c1', 'UserOf', 1000);
        const second = pending.register('c2', 'UserOf', 1000);
        const cause = new Error('closed');

        pending.failAll(cause);

        await expect(first).rejects.toBe(cause);
        await expect(second).rejects.toBe(cause);
        expect(pending.size).toBe(0);
    });

    it('does not report a request failed before it is awaited as an unhandled rejection', async () => {
        const unhandled: unknown[] = [];
        const listener = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', listener);
        try {
            const pending = new PendingReplies();
            const reply = pending.register('c1', 'UserOf', 1000);

            // The client closes while the request is still being sent
            pending.failAll(new Error('closed'));
            await new Promise(resolve => setTimeout(resolve, 10));

            expect(unhandled).toEqual([]);
            await expect(reply).rejects.toThrow('closed');
        } finally {
            process.off('unhandledRejection', listener);
        }
    });

    it('refuses a correlation id that already waits', async () => {
        const pending = new PendingReplies();
        const reply = pending.register('c1', 'UserOf', 1000);

        expect(() => pending.register('c1', 'UserOf', 1000)).toThrow(/c1/);
        pending.complete('c1', bytes('ok'));
        await reply;
    });
});
