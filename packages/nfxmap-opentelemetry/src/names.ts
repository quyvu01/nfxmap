/**
 * The names nfxmap gives its spans, metrics and attributes: those of FxMap's telemetry (`Constants.Telemetry`), so the
 * traces of Node, Java and .NET services read alike.
 */
export const TelemetryNames = Object.freeze({
    /** The instrumentation scope, FxMap's `ActivitySource`. */
    INSTRUMENTATION_NAME: 'FxMap',

    /** The span of a request sent to the owner of a key. */
    SPAN_REQUEST: 'fxmap.request',
    /** The span of a request answered by the owner. */
    SPAN_PROCESS: 'fxmap.process',

    /** The duration of the requests sent, in seconds. */
    METRIC_CLIENT_DURATION: 'fxmap.client.request.duration',
    /** The duration of the requests answered, in seconds. */
    METRIC_SERVER_DURATION: 'fxmap.server.request.duration',

    DISTRIBUTED_KEY: 'fxmap.distributed_key',
    TRANSPORT: 'fxmap.transport',
    VERSION: 'fxmap.version',
    EXPRESSIONS: 'fxmap.expressions',
    SELECTOR_COUNT: 'fxmap.selector_count',
    SELECTOR_IDS: 'fxmap.selector_ids',
    ITEM_COUNT: 'fxmap.item_count',
    EXPRESSION_ERROR_COUNT: 'fxmap.expression_error_count',
    MESSAGING_SYSTEM: 'messaging.system',
    DB_SYSTEM: 'db.system',
    ERROR_TYPE: 'error.type',

    /** The W3C trace context headers, which FxMap sends and reads on every transport. */
    TRACEPARENT: 'traceparent',
    TRACESTATE: 'tracestate',
});
