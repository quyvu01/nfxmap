import { beforeEach, describe, expect, it } from 'vitest';
import {
    type ItemsResponse,
    MapContext,
    type Next,
    RequestContext,
    RetryPolicy,
    type Sleep,
} from '../../src/index.js';

const REQUEST = new RequestContext('UserOf', { selectorIds: ['1'], expressions: ['Name'] }, MapContext.empty());
const ANSWER: ItemsResponse = { items: [], errors: [] };

describe('RetryPolicy', () => {
    let attempts: number;
    // The delays the sleep was asked for; it returns at once (JS: Java's Scheduler is an injectable sleep)
    let waited: number[];
    let sleep: Sleep;

    beforeEach(() => {
        attempts = 0;
        waited = [];
        sleep = async ms => {
            waited.push(ms);
        };
    });

    /** Fails the first `failures` attempts with `failure`, then answers. */
    function failing(failures: number, failure: Error): Next {
        return async () => {
            if (++attempts <= failures) throw failure;
            return ANSWER;
        };
    }

    it('retriesUntilAnAttemptSucceeds', async () => {
        const policy = RetryPolicy.retries(3);

        const response = await policy.asBehavior(sleep)(REQUEST, failing(2, new Error('down')));

        expect(response).toBe(ANSWER);
        expect(attempts).toBe(3);
        expect(waited).toEqual([]);
    });

    it('givesTheLastFailureWhenTheRetriesAreUsedUp', async () => {
        const policy = RetryPolicy.retries(2);

        const response = policy.asBehavior(sleep)(REQUEST, failing(10, new Error('down')));

        await expect(response).rejects.toThrow(new Error('down'));
        expect(attempts).toBe(3);
    });

    it('waitsTheDelayOfEachRetryAndCallsOnRetryBeforeIt', async () => {
        const retried: string[] = [];
        const policy = RetryPolicy.retries(3)
            .delay(retry => 100 * retry)
            .onRetry((failure, delay) => retried.push(`${(failure as Error).message} ${delay}`));

        await policy.asBehavior(sleep)(REQUEST, failing(3, new Error('down')));

        expect(waited).toEqual([100, 200, 300]);
        expect(retried).toEqual(['down 100', 'down 200', 'down 300']);
    });

    it('doesNotRetryWhatShouldRetryRefuses', async () => {
        const policy = RetryPolicy.retries(3).shouldRetry(e => !(e instanceof TypeError));

        const response = policy.asBehavior(sleep)(REQUEST, failing(1, new TypeError('bad')));

        await expect(response).rejects.toBeInstanceOf(TypeError);
        expect(attempts).toBe(1);
    });

    // Not ported: neverRetriesAnError. JS has no split between Error and Exception: every failure may be retried.

    it('retriesAStepThatThrowsInsteadOfFailing', async () => {
        const policy = RetryPolicy.retries(1);
        const next: Next = () => {
            if (++attempts === 1) throw new Error('thrown');
            return Promise.resolve(ANSWER);
        };

        expect(await policy.asBehavior(sleep)(REQUEST, next)).toBe(ANSWER);
        expect(attempts).toBe(2);
    });

    it('zeroRetriesMakesOneAttempt', async () => {
        const response = RetryPolicy.retries(0).asBehavior(sleep)(REQUEST, failing(1, new Error('down')));

        await expect(response).rejects.toThrow('down');
        expect(attempts).toBe(1);
    });

    it('waitsForRealWithTheDefaultScheduler', async () => {
        const policy = RetryPolicy.retries(1).delay(150);
        const started = performance.now();

        await policy.asBehavior()(REQUEST, failing(1, new Error('down')));

        // A timer of Node may fire up to a millisecond early
        expect(performance.now() - started).toBeGreaterThanOrEqual(148);
        expect(attempts).toBe(2);
    });

    it('aFixedDelayIsTheSameForEachRetry', async () => {
        // JS: the delay function of a policy is private; the delays are seen through the sleep
        const policy = RetryPolicy.retries(2).delay(1_000);

        await policy.asBehavior(sleep)(REQUEST, failing(2, new Error('down')));

        expect(waited).toEqual([1_000, 1_000]);
    });

    it('anExponentialDelayDoublesUpToItsMaximum', async () => {
        // JS: seen through the sleep, as above
        const policy = RetryPolicy.retries(60).exponentialDelay(100, 1_000);

        await policy.asBehavior(sleep)(REQUEST, failing(60, new Error('down')));

        expect([1, 2, 3, 4, 5, 60].map(retry => waited[retry - 1])).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    });

    it('aNullDelayMeansNone', async () => {
        // JS: outside the types, as Java's null Duration
        const policy = RetryPolicy.retries(1).delay(() => null as unknown as number);

        await policy.asBehavior(sleep)(REQUEST, failing(1, new Error('down')));

        expect(waited).toEqual([]);
        expect(attempts).toBe(2);
    });

    it('rejectsNegativeRetriesAndMissingFunctions', () => {
        expect(() => RetryPolicy.retries(-1)).toThrow(RangeError);
        // JS: the types rule out a null delay, onRetry or shouldRetry
    });
});
