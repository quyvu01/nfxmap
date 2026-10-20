import { RequestTimedOutError } from './errors.js';

interface Pending {
    readonly resolve: (reply: Uint8Array) => void;
    readonly reject: (error: unknown) => void;
    readonly timer: NodeJS.Timeout;
}

/**
 * The requests a client of a message transport waits for, by correlation id (RabbitMQ, Kafka): a request completes
 * with its reply, or fails when the reply does not come in time.
 */
export class PendingReplies {
    private readonly pending = new Map<string, Pending>();

    /**
     * Waits for the reply of a request.
     *
     * @return the reply, which fails with {@link RequestTimedOutError} after the timeout
     * @throws Error when a request already waits for the correlation id
     */
    register(correlationId: string, key: string, timeoutMs: number): Promise<Uint8Array> {
        if (this.pending.has(correlationId))
            throw new Error(`A request already waits for the correlation id ${correlationId}.`);
        const reply = new Promise<Uint8Array>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(correlationId);
                reject(new RequestTimedOutError(key, timeoutMs));
            }, timeoutMs);
            this.pending.set(correlationId, { resolve, reject, timer });
        });
        // A client awaits the reply once its request is sent: a failure before (the client closed while sending) is
        // not an unhandled rejection. The caller still gets it.
        reply.catch(() => undefined);
        return reply;
    }

    /** Completes the request of a reply; a reply that no request waits for is dropped. */
    complete(correlationId: string | null | undefined, reply: Uint8Array): boolean {
        const request = this.take(correlationId);
        request?.resolve(reply);
        return request !== undefined;
    }

    /** Fails the request of a correlation id, when it was not sent. */
    fail(correlationId: string | null | undefined, error: unknown): void {
        this.take(correlationId)?.reject(error);
    }

    /** Fails every request that still waits, when the client closes. */
    failAll(error: unknown): void {
        for (const correlationId of [...this.pending.keys()]) this.fail(correlationId, error);
    }

    /** How many requests wait. */
    get size(): number {
        return this.pending.size;
    }

    private take(correlationId: string | null | undefined): Pending | undefined {
        if (correlationId === null || correlationId === undefined) return undefined;
        const request = this.pending.get(correlationId);
        if (request === undefined) return undefined;
        this.pending.delete(correlationId);
        clearTimeout(request.timer);
        return request;
    }
}
