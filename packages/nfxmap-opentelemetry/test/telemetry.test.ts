import { readFileSync } from 'node:fs';
import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
    AggregationTemporality,
    type DataPoint,
    type Histogram,
    MeterProvider,
    MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
    BasicTracerProvider,
    InMemorySpanExporter,
    type ReadableSpan,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
    type ItemsResponse,
    LocalRequestClient,
    MapContext,
    type MapRequest,
    type QueryHandler,
    type RequestClient,
} from 'nfxmap';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NfxMapTelemetry, TelemetryNames, VERSION } from '../src/index.js';

/** Ported from jfxmap's JfxMapTelemetryTest. */

class TestMetricReader extends MetricReader {
    constructor() {
        super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
    }

    protected async onForceFlush(): Promise<void> {
    }

    protected async onShutdown(): Promise<void> {
    }
}

const REQUEST: MapRequest = { selectorIds: ['1', '2', '3', '4', '5', '6'], expressions: [null, 'UserEmail'] };
const TWO_USERS: ItemsResponse = { items: [{ id: '1', values: [] }, { id: '2', values: [] }], errors: [] };

const contextManager = new AsyncLocalStorageContextManager();
let spans: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;
let reader: TestMetricReader;
let telemetry: NfxMapTelemetry;
let sent: MapContext | null;

beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
    contextManager.disable();
    context.disable();
});

beforeEach(() => {
    spans = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    reader = new TestMetricReader();
    telemetry = new NfxMapTelemetry({ tracerProvider, meterProvider: new MeterProvider({ readers: [reader] }) });
    sent = null;
});

afterEach(async () => {
    await tracerProvider.shutdown();
    await reader.shutdown();
});

function transport(answer: () => Promise<ItemsResponse>, name: string | undefined = 'nats'): RequestClient {
    return {
        transport: name,
        request: (_key, _request, mapContext) => {
            sent = mapContext;
            return answer();
        },
    };
}

function handler(dbSystem: string | undefined, answer: ItemsResponse): QueryHandler {
    return {
        key: 'UserOf',
        entityName: 'User',
        dbSystem,
        handle: async (_request, mapContext) => {
            sent = mapContext;
            return answer;
        },
    };
}

function onlySpan(): ReadableSpan {
    const finished = spans.getFinishedSpans();
    expect(finished).toHaveLength(1);
    return finished[0];
}

function spanNamed(name: string): ReadableSpan {
    const span = spans.getFinishedSpans().find(finished => finished.name === name);
    expect(span).toBeDefined();
    return span!;
}

async function onlyPoint(metric: string): Promise<DataPoint<Histogram>> {
    const { resourceMetrics } = await reader.collect();
    const found = resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics)
        .find(data => data.descriptor.name === metric);
    expect(found).toBeDefined();
    expect(found!.dataPoints).toHaveLength(1);
    return found!.dataPoints[0] as DataPoint<Histogram>;
}

describe('NfxMapTelemetry', () => {
    it('traces a request sent and carries its trace context', async () => {
        const client = telemetry.instrumentClient(transport(async () => TWO_USERS));

        await client.request('UserOf', REQUEST, new MapContext({ 'x-caller': 'orders' }));

        const span = onlySpan();
        expect(span.name).toBe('fxmap.request');
        expect(span.kind).toBe(SpanKind.CLIENT);
        expect(span.status.code).toBe(SpanStatusCode.OK);
        expect(span.instrumentationScope.name).toBe('FxMap');
        expect(span.instrumentationScope.version).toBe(VERSION);
        expect(span.attributes).toMatchObject({
            'fxmap.distributed_key': 'UserOf',
            'fxmap.transport': 'nats',
            'messaging.system': 'nats',
            'fxmap.version': VERSION,
            'fxmap.expressions': ['', 'UserEmail'],
            'fxmap.selector_count': 6,
            'fxmap.selector_ids': '1,2,3,4,5',
            'fxmap.item_count': 2,
        });
        expect(sent!.headers['x-caller']).toBe('orders');
        const { traceId, spanId } = span.spanContext();
        expect(sent!.headers.traceparent).toBe(`00-${traceId}-${spanId}-01`);

        const point = await onlyPoint('fxmap.client.request.duration');
        expect(point.value.count).toBe(1);
        expect(point.attributes).toEqual({ 'fxmap.distributed_key': 'UserOf', 'fxmap.transport': 'nats' });
    });

    it('records a failed request', async () => {
        const client = telemetry.instrumentClient(transport(() => Promise.reject(new RangeError('down'))));

        await expect(client.request('UserOf', REQUEST, MapContext.empty())).rejects.toThrow('down');

        const span = onlySpan();
        expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'down' });
        expect(span.events.map(event => event.name)).toEqual(['exception']);
        expect((await onlyPoint('fxmap.client.request.duration')).attributes['error.type']).toBe('RangeError');
    });

    it('fails the request and ends the span when the transport throws', async () => {
        const throwing: RequestClient = {
            request: () => {
                throw new TypeError('thrown');
            },
        };

        await expect(telemetry.instrumentClient(throwing).request('UserOf', REQUEST, MapContext.empty()))
            .rejects.toBeInstanceOf(TypeError);

        expect(onlySpan().status.code).toBe(SpanStatusCode.ERROR);
        expect(onlySpan().attributes['fxmap.transport']).toBe('custom');
    });

    it('traces a request answered as a child of its trace context', async () => {
        const traceId = '0af7651916cd43dd8448eb211c80319c';
        const parentId = 'b7ad6b7169203331';
        const users = telemetry.instrumentHandler(handler('postgresql', {
            items: [], errors: [{ expression: 'Bad', message: 'bad expression' }],
        }));

        await users.handle(REQUEST, new MapContext({ traceparent: `00-${traceId}-${parentId}-01` }));

        const span = onlySpan();
        expect(span.name).toBe('fxmap.process');
        expect(span.kind).toBe(SpanKind.SERVER);
        expect(span.spanContext().traceId).toBe(traceId);
        expect(span.parentSpanContext?.spanId).toBe(parentId);
        expect(span.parentSpanContext?.isRemote).toBe(true);
        expect(span.attributes).toMatchObject({
            'fxmap.distributed_key': 'UserOf', 'db.system': 'postgresql', 'fxmap.item_count': 0,
            'fxmap.expression_error_count': 1,
        });
        expect((await onlyPoint('fxmap.server.request.duration')).attributes)
            .toEqual({ 'fxmap.distributed_key': 'UserOf', 'db.system': 'postgresql' });
    });

    it('reads the trace context whatever the case of its headers', async () => {
        const users = telemetry.instrumentHandler(handler(undefined, TWO_USERS));

        await users.handle(REQUEST, new MapContext({
            Traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', TraceState: 'vendor=1',
        }));

        expect(onlySpan().spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
        expect(onlySpan().spanContext().traceState?.get('vendor')).toBe('1');
        expect(onlySpan().attributes['db.system']).toBeUndefined();
    });

    it('starts a new trace when the trace context is not valid', async () => {
        const users = telemetry.instrumentHandler(handler(undefined, TWO_USERS));

        for (const traceparent of ['nonsense', '00-00000000000000000000000000000000-b7ad6b7169203331-01',
            'ff-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
            '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01-extra'])
            await users.handle(REQUEST, new MapContext({ traceparent }));

        expect(spans.getFinishedSpans().map(span => span.parentSpanContext)).toEqual([
            undefined, undefined, undefined, undefined,
        ]);
    });

    it('answers a request in process as a child of the current span', async () => {
        const users = telemetry.instrumentHandler(handler(undefined, TWO_USERS));
        const tracer = tracerProvider.getTracer('test');

        await tracer.startActiveSpan('caller', async parent => {
            await users.handle(REQUEST, MapContext.empty());
            parent.end();
        });

        expect(spanNamed('fxmap.process').parentSpanContext?.spanId)
            .toBe(spanNamed('caller').spanContext().spanId);
    });

    it('carries the trace from the client to the handler', async () => {
        const users = telemetry.instrumentHandler(handler('mongodb', TWO_USERS));
        const client = telemetry.instrumentClient(new LocalRequestClient(users));

        await client.request('UserOf', REQUEST, MapContext.empty());

        const request = spanNamed('fxmap.request');
        const process = spanNamed('fxmap.process');
        expect(process.spanContext().traceId).toBe(request.spanContext().traceId);
        expect(process.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
        expect(request.attributes['fxmap.transport']).toBe('local');
    });

    it('records a handler that fails', async () => {
        const failing: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: () => Promise.reject(new Error('database down')),
        };

        await expect(telemetry.instrumentHandler(failing).handle(REQUEST, MapContext.empty()))
            .rejects.toThrow('database down');

        expect(onlySpan().status.code).toBe(SpanStatusCode.ERROR);
        expect((await onlyPoint('fxmap.server.request.duration')).attributes['error.type']).toBe('Error');
    });

    it('adds no header without an SDK', async () => {
        const client = new NfxMapTelemetry().instrumentClient(transport(async () => TWO_USERS));

        await client.request('UserOf', REQUEST, new MapContext({ 'x-caller': 'orders' }));

        expect(sent!.headers).toEqual({ 'x-caller': 'orders' });
    });

    it('keeps what the client and the handler say, and instruments once', () => {
        const client = telemetry.instrumentClient(transport(async () => TWO_USERS));
        const users = telemetry.instrumentHandler(handler('postgresql', TWO_USERS));

        expect(client.transport).toBe('nats');
        expect(telemetry.instrumentClient(client)).toBe(client);
        expect(users.key).toBe('UserOf');
        expect(users.entityName).toBe('User');
        expect(users.dbSystem).toBe('postgresql');
        expect(telemetry.instrumentHandler(users)).toBe(users);
        const all = telemetry.instrumentHandlers([users, handler(undefined, TWO_USERS)]);
        expect(all).toHaveLength(2);
        expect(all[0]).toBe(users);
        expect(() => telemetry.instrumentClient(null as never)).toThrow(TypeError);
        expect(() => telemetry.instrumentHandler(undefined as never)).toThrow(TypeError);
    });

    it('knows the version of the package', () => {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
        expect(VERSION).toBe(pkg.version);
        expect(TelemetryNames.INSTRUMENTATION_NAME).toBe('FxMap');
    });
});
