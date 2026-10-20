import {
    type Context,
    createTraceState,
    isSpanContextValid,
    ROOT_CONTEXT,
    type SpanContext,
    trace,
} from '@opentelemetry/api';
import type { Headers } from 'nfxmap';
import { TelemetryNames } from './names.js';

// The W3C trace context, which FxMap writes and reads whatever propagators the application configured

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** The `traceparent` and `tracestate` headers of a span, or none when its context is not valid (no SDK). */
export function traceHeaders(spanContext: SpanContext): Record<string, string> {
    if (!isSpanContextValid(spanContext)) return {};
    const flags = (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0');
    const headers: Record<string, string> = {
        [TelemetryNames.TRACEPARENT]: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
    };
    const state = spanContext.traceState?.serialize();
    if (state) headers[TelemetryNames.TRACESTATE] = state;
    return headers;
}

/** The value of a header, whatever its case: some transports change the case of the header names. */
export function header(headers: Headers, name: string): string | undefined {
    const exact = headers[name];
    if (exact !== undefined) return exact;
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
    return undefined;
}

/** The context of the remote span in the headers, or `undefined` when they hold no valid `traceparent`. */
export function remoteContext(headers: Headers): Context | undefined {
    const traceparent = header(headers, TelemetryNames.TRACEPARENT)?.trim().toLowerCase();
    const match = traceparent === undefined ? null : TRACEPARENT.exec(traceparent);
    if (match === null) return undefined;
    const [, version, traceId, spanId, flags, rest] = match;
    // Version ff is forbidden; version 00 has nothing after the flags
    if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined;
    const tracestate = header(headers, TelemetryNames.TRACESTATE);
    const spanContext: SpanContext = {
        traceId,
        spanId,
        traceFlags: Number.parseInt(flags, 16),
        isRemote: true,
        traceState: tracestate ? createTraceState(tracestate) : undefined,
    };
    if (!isSpanContextValid(spanContext)) return undefined;
    return trace.setSpanContext(ROOT_CONTEXT, spanContext);
}
