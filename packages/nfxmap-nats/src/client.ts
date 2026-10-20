import { errors, headers as natsHeaders, type Msg, type NatsConnection } from '@nats-io/nats-core';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    ReceivedFaultError,
    type RequestClient,
    RequestTimedOutError,
    WireMessages,
} from 'nfxmap';
import { NatsSubjects } from './subjects.js';

export interface NatsRequestClientOptions {
    /** The prefix of the subjects (FxMap's `TopicPrefix`); none by default. */
    readonly topicPrefix?: string;
    /** How long a request may wait for its reply, in milliseconds (default 30 seconds, FxMap's DefaultRequestTimeout). */
    readonly timeoutMs?: number;
}

/**
 * Sends requests over NATS request-reply (FxMap's NatsRequestClient and `AddNats`): the request goes to the subject of
 * its key ({@link NatsSubjects}) with the headers of the mapping call as NATS headers, and the owner answers on the
 * reply inbox. The connection belongs to the caller, who closes it.
 *
 * ```ts
 * const connection = await connect({ servers: 'nats://localhost:4222' });
 * const client = new NatsRequestClient(connection);
 * ```
 */
export class NatsRequestClient implements RequestClient {
    readonly transport = 'nats';
    readonly topicPrefix: string | undefined;
    readonly timeoutMs: number;

    constructor(private readonly connection: NatsConnection, options: NatsRequestClientOptions = {}) {
        if (connection === null || connection === undefined) throw new TypeError('The NATS connection is required.');
        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
        this.topicPrefix = options.topicPrefix;
        this.timeoutMs = timeoutMs;
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        const entries = Object.entries(context.headers).filter(([, value]) => value !== null && value !== undefined);
        let headers;
        if (entries.length > 0) {
            headers = natsHeaders();
            for (const [name, value] of entries) headers.append(name, value);
        }
        let reply: Msg;
        try {
            reply = await this.connection.request(NatsSubjects.of(key, this.topicPrefix), WireMessages.writeRequest(request),
                { timeout: this.timeoutMs, headers });
        } catch (error) {
            throw this.translate(key, error);
        }
        if (reply.headers?.hasError) {
            if (reply.headers.code === 503) throw new NoHandlerForDistributedKeyError(key);
            throw new ReceivedFaultError(null, [{
                exceptionType: `NATS status ${reply.headers.code}`,
                message: reply.headers.description || null,
                stackTrace: null,
            }]);
        }
        return WireMessages.readResult(reply.data);
    }

    private translate(key: string, error: unknown): unknown {
        const cause = error instanceof Error ? error.cause : undefined;
        if (error instanceof errors.TimeoutError || cause instanceof errors.TimeoutError)
            return new RequestTimedOutError(key, this.timeoutMs);
        // No subscriber on the subject: the server answers "no responders" at once
        if (error instanceof errors.NoRespondersError || cause instanceof errors.NoRespondersError
            || (error instanceof errors.RequestError && error.isNoResponders()))
            return new NoHandlerForDistributedKeyError(key);
        if (error instanceof errors.ClosedConnectionError
            || (error instanceof errors.RequestError && /connection closed/i.test(error.message)))
            return new Error(`The NATS connection closed before the reply for ${key} came.`, { cause: error });
        return error;
    }
}
