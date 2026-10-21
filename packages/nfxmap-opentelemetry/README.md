# nfxmap-opentelemetry

OpenTelemetry for [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js): the spans, metrics and W3C trace
context of FxMap's telemetry, so that a trace goes from a consumer to the owner of a key, whether the owner runs on
Node, .NET ([FxMap](https://github.com/quyvu01/FxMap)) or Java ([jfxmap](https://github.com/quyvu01/jfxmap)).

```sh
npm install nfxmap nfxmap-opentelemetry @opentelemetry/api
```

It runs on [@opentelemetry/api](https://www.npmjs.com/package/@opentelemetry/api) 1.3 or later, with the SDK the
application sets up (`@opentelemetry/sdk-node`, or the trace and metrics SDKs).

## Usage

```ts
import { NfxMapTelemetry } from 'nfxmap-opentelemetry';

const telemetry = new NfxMapTelemetry();   // the global tracer and meter providers

// The consumer: a span around each request sent, and the trace context in its headers
const mapper = createDistributedMapper({ profiles, requestClient: telemetry.instrumentClient(natsClient) });

// The owner: a span around each request answered, child of the trace context of the request
const server = new NatsServer(connection, telemetry.instrumentHandlers([users, products]));
```

| Option | Default | |
|---|---|---|
| `tracerProvider` | the global one | where the spans go |
| `meterProvider` | the global one | where the measures go |

Without an OpenTelemetry SDK nothing is recorded and no header is added.

## What it records

The names are FxMap's (`TelemetryNames`), with the instrumentation scope `FxMap`:

- **`fxmap.request`**: a client span around each request a `RequestClient` sends. Its attributes are
  `fxmap.distributed_key`, `fxmap.transport`, `messaging.system`, `fxmap.version`, `fxmap.expressions`,
  `fxmap.selector_count`, `fxmap.selector_ids` (the first 5 ids) and `fxmap.item_count`. Its trace context travels with
  the request as the `traceparent` and `tracestate` headers, in the W3C format that FxMap reads, whatever propagators the
  application configured.
- **`fxmap.process`**: a server span around each request a `QueryHandler` answers. It is a child of the
  `traceparent` of the request (whatever the case of the header), or of the current span for a request answered in the
  same process. It adds `db.system` when the handler gives one, and `fxmap.expression_error_count`.
- **`fxmap.client.request.duration`** and **`fxmap.server.request.duration`**: histograms in seconds, by
  `fxmap.distributed_key` and `fxmap.transport` or `db.system`, with `error.type` (the class of the error) for the
  failed requests.

A failed request sets the status of its span to error and records the exception.

The trace context crosses every transport but Azure Service Bus: Service Bus refuses the trace context as FxMap sends
it (bytes), so `nfxmap-azure-servicebus` leaves it out and the owner starts a trace of its own.
