import type { Headers } from './context.js';
import type { MapContext } from './context.js';
import type { ItemsResponse, MapRequest } from './responses.js';
import type { QueryHandler, RequestClient } from './transport.js';

/**
 * A request on its way through a pipeline (FxMap's `RequestContext`): to the transport on the client side, to the
 * {@link QueryHandler} on the owner's side. It does not change: a behavior that adds a header passes a new context to
 * the next step.
 */
export class RequestContext {
    constructor(readonly key: string, readonly request: MapRequest, readonly context: MapContext) {
    }

    /** The headers that travel with the request. */
    get headers(): Headers {
        return this.context.headers;
    }

    /** The same request with one more header, or a new value for it; a `null` value removes it. */
    withHeader(name: string, value: string | null): RequestContext {
        return new RequestContext(this.key, this.request, this.context.withHeader(name, value));
    }

    /** The same request with other ids or expressions. */
    withRequest(request: MapRequest): RequestContext {
        return new RequestContext(this.key, request, this.context);
    }
}

/** The rest of a pipeline: the next behavior, or at the end the transport or the handler. */
export type Next = (request: RequestContext) => Promise<ItemsResponse>;

/**
 * A step around each request the mapper sends (FxMap's `ISendPipelineBehavior`): add headers, log, measure, cache,
 * or answer without sending by not calling `next`. The behaviors run in their order, inside the retries of the
 * {@link RetryPolicy}: each attempt goes through them.
 *
 * ```ts
 * const tenant: SendBehavior = (request, next) => next(request.withHeader('x-tenant', currentTenant()));
 * ```
 */
export type SendBehavior = (request: RequestContext, next: Next) => Promise<ItemsResponse>;

/**
 * A step around each request a {@link QueryHandler} answers, on the owner's side (FxMap's
 * `IReceivedPipelineBehavior`): check the headers, log, measure, or answer without the handler by not calling `next`.
 */
export type ReceiveBehavior = (request: RequestContext, next: Next) => Promise<ItemsResponse>;

type Behavior = (request: RequestContext, next: Next) => Promise<ItemsResponse>;

// A step that throws fails the request; a step that returns no promise fails it too, as in FxMap
function run(behaviors: readonly Behavior[], last: Next): Next {
    const step = (index: number): Next => async request => {
        const stage = index === behaviors.length ? last(request) : behaviors[index](request, step(index + 1));
        if (stage === null || stage === undefined) throw new TypeError('A pipeline step returned no promise.');
        return stage;
    };
    return step(0);
}

/** The client with the behaviors around it, the first one outermost; the client itself when there is none. */
export function sendPipeline(client: RequestClient, behaviors: readonly SendBehavior[]): RequestClient {
    if (behaviors.length === 0) return client;
    const steps = [...behaviors];
    const pipeline = run(steps, request => client.request(request.key, request.request, request.context));
    return {
        request: (key, request, context) => pipeline(new RequestContext(key, request, context)),
        transport: client.transport,
    };
}

/** The handler with the behaviors around it, the first one outermost; the handler itself when there is none. */
export function receivePipeline(handler: QueryHandler, behaviors: readonly ReceiveBehavior[]): QueryHandler {
    if (behaviors.length === 0) return handler;
    const steps = [...behaviors];
    const pipeline = run(steps, request => handler.handle(request.request, request.context));
    return {
        key: handler.key,
        entityName: handler.entityName,
        dbSystem: handler.dbSystem,
        handle: (request, context) => pipeline(new RequestContext(handler.key, request, context)),
    };
}
