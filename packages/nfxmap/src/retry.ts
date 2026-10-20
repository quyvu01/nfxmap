import type { SendBehavior } from './pipeline.js';

/** Waits for a number of milliseconds; tests give their own. */
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * How failed requests are sent again (FxMap's `SetRetryPolicy`):
 * - at most `retries` retries after the first attempt: `RetryPolicy.retries(3)` makes at most 4 attempts;
 * - the delay is waited before each retry, not after the last failure;
 * - `onRetry` is called before each retry, with the failure of the attempt that failed and the delay;
 * - `shouldRetry` can refuse a retry: the failure is returned at once;
 * - when the attempts are used up, the last failure is returned.
 *
 * An expression the owner could not evaluate is part of its answer, not a failure, and is not retried.
 *
 * ```ts
 * RetryPolicy.retries(3)
 *     .exponentialDelay(200, 5_000)   // 200 ms, 400 ms, 800 ms...
 *     .shouldRetry(e => !(e instanceof NoHandlerForDistributedKeyError))
 * ```
 */
export class RetryPolicy {
    private constructor(
        /** The retries after the first attempt. */
        readonly retries: number,
        private readonly delayOf: ((retry: number) => number) | null,
        private readonly onRetryCallback: ((error: unknown, delayMs: number) => void) | null,
        private readonly shouldRetryPredicate: ((error: unknown) => boolean) | null,
    ) {
        if (!Number.isInteger(retries) || retries < 0) throw new RangeError('The retries must be a whole number, 0 or more.');
    }

    /** `retries` retries, without a delay. */
    static retries(retries: number): RetryPolicy {
        return new RetryPolicy(retries, null, null, null);
    }

    /** The same policy with a delay before each retry: milliseconds, or a function of the retry number (1 first). */
    delay(delay: number | ((retry: number) => number)): RetryPolicy {
        const delayOf = typeof delay === 'number' ? () => delay : delay;
        return new RetryPolicy(this.retries, delayOf, this.onRetryCallback, this.shouldRetryPredicate);
    }

    /** The same policy with a delay that doubles at each retry, from `firstMs` up to `maxMs`. */
    exponentialDelay(firstMs: number, maxMs: number): RetryPolicy {
        return this.delay(retry => Math.min(firstMs * 2 ** Math.min(retry - 1, 30), maxMs));
    }

    /** The same policy, calling `onRetry` before each retry. */
    onRetry(onRetry: (error: unknown, delayMs: number) => void): RetryPolicy {
        return new RetryPolicy(this.retries, this.delayOf, onRetry, this.shouldRetryPredicate);
    }

    /** The same policy, retrying only the failures `shouldRetry` accepts. */
    shouldRetry(shouldRetry: (error: unknown) => boolean): RetryPolicy {
        return new RetryPolicy(this.retries, this.delayOf, this.onRetryCallback, shouldRetry);
    }

    /** This policy as the behavior that runs it. */
    asBehavior(sleep: Sleep = defaultSleep): SendBehavior {
        return async (request, next) => {
            for (let retry = 0; ; retry++) {
                try {
                    return await next(request);
                } catch (error) {
                    if (retry >= this.retries || (this.shouldRetryPredicate !== null && !this.shouldRetryPredicate(error)))
                        throw error;
                    const wait = Math.max(0, this.delayOf?.(retry + 1) ?? 0);
                    this.onRetryCallback?.(error, wait);
                    if (wait > 0) await sleep(wait);
                }
            }
        };
    }
}
