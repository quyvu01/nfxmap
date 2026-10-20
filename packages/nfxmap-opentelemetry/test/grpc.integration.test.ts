import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import { createDistributedMapper, defineEntity, defineProfile, InMemoryQueryHandler } from 'nfxmap';
import { FxMapGrpcService, GrpcRequestClient } from 'nfxmap-grpc';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NfxMapTelemetry } from '../src/index.js';

/** The trace of a request carried from a traced client to a traced server over gRPC. */

class OrderDto {
    userName: string | null = null;

    constructor(readonly userId: string) {
    }
}

const contextManager = new AsyncLocalStorageContextManager();
const silentLogger = { error: () => undefined };

beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
});

afterAll(() => {
    contextManager.disable();
    context.disable();
});

describe('trace propagation', () => {
    it('carries the trace over gRPC', async () => {
        const spans = new InMemorySpanExporter();
        const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
        const telemetry = new NfxMapTelemetry({ tracerProvider });
        const users = new InMemoryQueryHandler(
            defineEntity<{ id: string; name: string }>('User', { key: 'UserOf', id: 'id', defaultProperty: 'name' }),
            [{ id: '1', name: 'Alice' }]);

        const server = new Server();
        new FxMapGrpcService(telemetry.instrumentHandlers([users]), { logger: silentLogger }).addTo(server);
        const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0',
            ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound)));
        const client = new GrpcRequestClient({ hosts: [`http://127.0.0.1:${port}`], timeoutMs: 5_000 });
        try {
            const mapper = createDistributedMapper({
                profiles: [defineProfile(OrderDto, profile => profile.useDistributedKey('UserOf').of('userId')
                    .for('userName'))],
                requestClient: telemetry.instrumentClient(client),
                throwIfException: true,
            });
            const order = new OrderDto('1');

            await mapper.map(order);

            expect(order.userName).toBe('Alice');
            const request = spans.getFinishedSpans().find(span => span.name === 'fxmap.request')!;
            const process = spans.getFinishedSpans().find(span => span.name === 'fxmap.process')!;
            expect(request.attributes['fxmap.transport']).toBe('grpc');
            expect(process.spanContext().traceId).toBe(request.spanContext().traceId);
            expect(process.parentSpanContext?.spanId).toBe(request.spanContext().spanId);
            expect(process.parentSpanContext?.isRemote).toBe(true);
        } finally {
            await client.close();
            await new Promise<void>(resolve => server.tryShutdown(() => resolve()));
            await tracerProvider.shutdown();
        }
    });
});
