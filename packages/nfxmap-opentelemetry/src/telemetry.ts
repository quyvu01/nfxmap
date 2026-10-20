import { performance } from 'node:perf_hooks';
import {
    type Attributes,
    context as contexts,
    type Context,
    type Histogram,
    metrics,
    type MeterProvider,
    type Span,
    SpanKind,
    SpanStatusCode,
    trace,
    type Tracer,
    type TracerProvider,
} from '@opentelemetry/api';
import type { ItemsResponse, MapContext, MapRequest, QueryHandler, RequestClient } from 'nfxmap';
import { TelemetryNames } from './names.js';
import { remoteContext, traceHeaders } from './w3c.js';

/** The version of nfxmap-opentelemetry, in the `fxmap.version` attribute. */
export const VERSION = '0.1.0';

// How many ids the selector_ids attribute shows, as FxMap
const SHOWN_IDS = 5;
const INSTRUMENTED = Symbol('nfxmap.instrumented');

export interface NfxMapTelemetryOptions {
    /** Where the spans go; the global tracer provider by default. */
    readonly tracerProvider?: TracerProvider;
    /** Where the measures go; the global meter provider by default. */
    readonly meterProvider?: MeterProvider;
}

/**
 * Traces and measures the requests of nfxmap with OpenTelemetry, as FxMap does with its `ActivitySource`:
 *
 * - a client span `fxmap.request` around each request a {@link RequestClient} sends, whose W3C trace context travels
 *   with the request as the `traceparent` and `tracestate` headers;
 * - a server span `fxmap.process` around each request a {@link QueryHandler} answers, child of the trace context of the
 *   request, so a trace goes from the consumer to the owner, Node, Java or .NET;
 * - the histograms `fxmap.client.request.duration` and `fxmap.server.request.duration`, in seconds.
 *
 * The trace context is always written and read in the W3C format, the one FxMap reads, whatever propagators the
 * application configured. Without an OpenTelemetry SDK, nothing is recorded and no header is added.
 *
 * ```ts
 * const telemetry = new NfxMapTelemetry();
 * const mapper = createDistributedMapper({ profiles, requestClient: telemetry.instrumentClient(natsClient) });
 * const server = new NatsServer(connection, telemetry.instrumentHandlers(handlers));
 * ```
 */
export class NfxMapTelemetry {
    private readonly tracer: Tracer;
    private readonly clientDuration: Histogram;
    private readonly serverDuration: Histogram;

    constructor(options: NfxMapTelemetryOptions = {}) {
        this.tracer = (options.tracerProvider ?? trace.getTracerProvider())
            .getTracer(TelemetryNames.INSTRUMENTATION_NAME, VERSION);
        const meter = (options.meterProvider ?? metrics.getMeterProvider())
            .getMeter(TelemetryNames.INSTRUMENTATION_NAME, VERSION);
        this.clientDuration = meter.createHistogram(TelemetryNames.METRIC_CLIENT_DURATION, {
            unit: 's', description: 'The duration of the FxMap requests sent to the owners of distributed keys.',
        });
        this.serverDuration = meter.createHistogram(TelemetryNames.METRIC_SERVER_DURATION, {
            unit: 's', description: 'The duration of the FxMap requests answered by this service.',
        });
    }

    /** The client with a span and a measure around each request it sends, and the trace context in the headers. */
    instrumentClient(client: RequestClient): RequestClient {
        if (client === null || client === undefined) throw new TypeError('The client is required.');
        if ((client as Partial<Instrumented>)[INSTRUMENTED] === true) return client;
        const transport = client.transport ?? 'custom';
        const instrumented: RequestClient & Instrumented = {
            [INSTRUMENTED]: true,
            transport,
            request: (key, request, mapContext) => this.traceRequest(client, transport, key, request, mapContext),
        };
        return instrumented;
    }

    /** The handler with a span and a measure around each request it answers, child of the trace of the request. */
    instrumentHandler(handler: QueryHandler): QueryHandler {
        if (handler === null || handler === undefined) throw new TypeError('The handler is required.');
        if ((handler as Partial<Instrumented>)[INSTRUMENTED] === true) return handler;
        const instrumented: QueryHandler & Instrumented = {
            [INSTRUMENTED]: true,
            key: handler.key,
            entityName: handler.entityName,
            dbSystem: handler.dbSystem,
            handle: (request, mapContext) => this.traceHandling(handler, request, mapContext),
        };
        return instrumented;
    }

    /** Each handler, instrumented. */
    instrumentHandlers(handlers: Iterable<QueryHandler>): QueryHandler[] {
        return [...handlers].map(handler => this.instrumentHandler(handler));
    }

    private async traceRequest(client: RequestClient, transport: string, key: string, request: MapRequest,
                               mapContext: MapContext): Promise<ItemsResponse> {
        const started = performance.now();
        const span = this.tracer.startSpan(TelemetryNames.SPAN_REQUEST, {
            kind: SpanKind.CLIENT,
            attributes: {
                [TelemetryNames.DISTRIBUTED_KEY]: key,
                [TelemetryNames.TRANSPORT]: transport,
                [TelemetryNames.VERSION]: VERSION,
                [TelemetryNames.MESSAGING_SYSTEM]: transport,
            },
        });
        setRequestAttributes(span, request);
        const traced = trace.setSpan(contexts.active(), span);
        let sent = mapContext;
        for (const [name, value] of Object.entries(traceHeaders(span.spanContext()))) sent = sent.withHeader(name, value);
        return this.ended(span, this.clientDuration, started,
            { [TelemetryNames.DISTRIBUTED_KEY]: key, [TelemetryNames.TRANSPORT]: transport },
            traced, () => client.request(key, request, sent));
    }

    private async traceHandling(handler: QueryHandler, request: MapRequest,
                                mapContext: MapContext): Promise<ItemsResponse> {
        const started = performance.now();
        // The trace of the caller: from the headers when it came over a transport, else the current one
        const parent = remoteContext(mapContext.headers) ?? contexts.active();
        const attributes: Attributes = {
            [TelemetryNames.DISTRIBUTED_KEY]: handler.key,
            [TelemetryNames.VERSION]: VERSION,
        };
        if (handler.dbSystem) attributes[TelemetryNames.DB_SYSTEM] = handler.dbSystem;
        const span = this.tracer.startSpan(TelemetryNames.SPAN_PROCESS, { kind: SpanKind.SERVER, attributes }, parent);
        setRequestAttributes(span, request);
        const measured: Attributes = { [TelemetryNames.DISTRIBUTED_KEY]: handler.key };
        if (handler.dbSystem) measured[TelemetryNames.DB_SYSTEM] = handler.dbSystem;
        return this.ended(span, this.serverDuration, started, measured, trace.setSpan(parent, span),
            () => handler.handle(request, mapContext));
    }

    // Runs the call in the context of the span, then ends the span and records the duration
    private async ended(span: Span, duration: Histogram, started: number, measured: Attributes, traced: Context,
                        call: () => Promise<ItemsResponse>): Promise<ItemsResponse> {
        try {
            const items = await contexts.with(traced, call);
            span.setAttribute(TelemetryNames.ITEM_COUNT, items?.items?.length ?? 0);
            if (items?.errors?.length) span.setAttribute(TelemetryNames.EXPRESSION_ERROR_COUNT, items.errors.length);
            span.setStatus({ code: SpanStatusCode.OK });
            return items;
        } catch (error) {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
            measured = { ...measured, [TelemetryNames.ERROR_TYPE]: errorType(error) };
            throw error;
        } finally {
            span.end();
            duration.record((performance.now() - started) / 1_000, measured);
        }
    }
}

interface Instrumented {
    readonly [INSTRUMENTED]: true;
}

function setRequestAttributes(span: Span, request: MapRequest): void {
    if (!span.isRecording()) return;
    span.setAttribute(TelemetryNames.EXPRESSIONS, request.expressions.map(expression => expression ?? ''));
    span.setAttribute(TelemetryNames.SELECTOR_COUNT, request.selectorIds.length);
    if (request.selectorIds.length > 0)
        span.setAttribute(TelemetryNames.SELECTOR_IDS, request.selectorIds.slice(0, SHOWN_IDS).join(','));
}

function errorType(error: unknown): string {
    return error instanceof Error ? error.constructor.name : typeof error;
}
