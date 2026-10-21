import { BasicTracerProvider, InMemorySpanExporter, type ReadableSpan, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
    EntityConfigureOf,
    InMemoryQueryHandler,
    type ItemsResponse,
    MapContext,
    type QueryHandler,
} from 'nfxmap';
import { NfxMapTelemetry } from 'nfxmap-opentelemetry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { orders, PEERS, type Peer, probeSpan, runConsumer, startOwner } from './probes.js';
import { type Close, transports } from './transports.js';

/**
 * nfxmap and the other ports of FxMap in one system: a real .NET service on FxMap 5.1.1 (dotnet-probe/) and a Java
 * service on jfxmap (java-probe/) talk with nfxmap over each message transport, in both directions, through the string
 * key UserOf: a Node client asks their owner of UserOf, and their consumer asks a Node owner. The trace goes across
 * too, with nfxmap-opentelemetry on the Node side.
 *
 * Runs against the probes that `NFXMAP_DOTNET_PROBE` and `NFXMAP_JAVA_PROBE` start, over the transports whose broker
 * is set (see transports.ts).
 */

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('UserOf');
        this.exposedName('email', 'UserEmail');
    }
}

/** The Node owner of UserOf, which keeps the context of the last request. */
function nodeUsers(): QueryHandler & { seen: MapContext | null } {
    const users = new InMemoryQueryHandler(new UserConfig(),
        [new User(1, 'Alice', 'alice@node'), new User(2, 'Bob', 'bob@node')]);
    const handler = {
        key: users.key,
        entityName: users.entityName,
        seen: null as MapContext | null,
        handle(request: Parameters<QueryHandler['handle']>[0], context: MapContext): Promise<ItemsResponse> {
            handler.seen = context;
            return users.handle(request, context);
        },
    };
    return handler;
}

function tracing() {
    const spans = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] });
    return {
        telemetry: new NfxMapTelemetry({ tracerProvider: provider }),
        only(name: string): ReadableSpan {
            const found = spans.getFinishedSpans().filter(span => span.name === name);
            expect(found).toHaveLength(1);
            return found[0];
        },
        close: () => provider.shutdown(),
    };
}

const closeables: Close[] = [];

afterEach(async () => {
    for (const close of closeables.splice(0).reverse()) await close();
});

async function askTheOwnerOf(peer: Peer, response: Promise<ItemsResponse>) {
    const { items, errors } = await response;
    expect(errors).toEqual([]);
    expect(items).toHaveLength(2);
    expect(items).toEqual(expect.arrayContaining([
        { id: '1', values: [{ expression: null, value: '"Alice"' }, { expression: 'UserEmail', value: `"alice@${peer.name}"` }] },
        { id: '2', values: [{ expression: null, value: '"Bob"' }, { expression: 'UserEmail', value: `"bob@${peer.name}"` }] },
    ]));
}

const REQUEST = { selectorIds: ['1', '2', '3'], expressions: [null, 'UserEmail'] };

describe.each(PEERS)('nfxmap and $name', peer => {
    describe.each(transports())('over $name', transport => {
        beforeEach(async () => {
            await transport.reset?.();
        });

        it(`a Node client asks a ${peer.name} owner`, async () => {
            const owner = await startOwner(peer, transport.name, transport.address);
            closeables.push(owner.stop);
            const { client, close } = await transport.client();
            closeables.push(close);

            await askTheOwnerOf(peer, client.request('UserOf', REQUEST, new MapContext({ 'x-probe': 'node' })));
        });

        it(`a ${peer.name} consumer asks a Node owner`, async () => {
            const users = nodeUsers();
            closeables.push(await transport.serve(users));

            const mapped = orders(await runConsumer(peer, transport.name, transport.address));

            expect(mapped.map(order => order.UserName ?? order.userName ?? null)).toEqual(['Alice', 'Bob', null]);
            expect(mapped.map(order => order.UserEmail ?? order.userEmail ?? null))
                .toEqual(['alice@node', 'bob@node', null]);
            expect(users.seen?.headers['x-probe']).toBe(peer.name);
        });

        it(`the ${peer.name} owner ${transport.carriesTrace ? 'continues' : 'starts'} the trace of a Node request`,
            async () => {
                const owner = await startOwner(peer, transport.name, transport.address, true);
                closeables.push(owner.stop);
                const traces = tracing();
                closeables.push(traces.close);
                const { client, close } = await transport.client();
                closeables.push(close);

                await askTheOwnerOf(peer, traces.telemetry.instrumentClient(client)
                    .request('UserOf', REQUEST, MapContext.empty()));

                const request = traces.only('fxmap.request').spanContext();
                const process = await probeSpan(owner.output, 'fxmap.process');
                if (transport.carriesTrace) {
                    expect(process.traceId).toBe(request.traceId);
                    expect(process.parentSpanId).toBe(request.spanId);
                } else {
                    expect(process.traceId).not.toBe(request.traceId);
                    expect(process.parentSpanId).toBe('0000000000000000');
                }
            });

        // A traced .NET consumer fails on Service Bus, which refuses the trace context as FxMap sends it
        it.skipIf(!transport.carriesTrace)(`a Node owner continues the trace of a ${peer.name} request`, async () => {
            const traces = tracing();
            closeables.push(traces.close);
            closeables.push(await transport.serve(traces.telemetry.instrumentHandler(nodeUsers())));

            const output = await runConsumer(peer, transport.name, transport.address, true);

            expect(orders(output).map(order => order.UserName ?? order.userName ?? null)).toEqual(['Alice', 'Bob', null]);
            const request = await probeSpan(output, 'fxmap.request');
            const process = traces.only('fxmap.process');
            expect(process.spanContext().traceId).toBe(request.traceId);
            expect(process.parentSpanContext?.spanId).toBe(request.spanId);
        });
    });
});

it('runs against at least one probe when one is given', () => {
    if (PEERS.length > 0) expect(transports()).not.toHaveLength(0);
});
