# nfxmap-azure-servicebus

The Azure Service Bus transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's
`FxMap.Azure.ServiceBus`: the same session queues and messages as FxMap 5.1.1, so a Node service and a .NET
([FxMap](https://github.com/quyvu01/FxMap)) or Java ([jfxmap](https://github.com/quyvu01/jfxmap)) service call each other.

```sh
npm install nfxmap nfxmap-azure-servicebus @azure/service-bus
```

It runs on [@azure/service-bus](https://www.npmjs.com/package/@azure/service-bus) 7.9 or later. The
`ServiceBusClient` belongs to the application, which closes it.

## The consumer

```ts
import { ServiceBusClient } from '@azure/service-bus';
import { createDistributedMapper } from 'nfxmap';
import { ServiceBusRequestClient } from 'nfxmap-azure-servicebus';

const client = new ServiceBusRequestClient(new ServiceBusClient(connectionString));
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()], requestClient: client });
// When the application stops: fails the waiting requests, releases the sessions
await client.close();
```

| Option | Default | |
|---|---|---|
| `topicPrefix` | none | the prefix of the queue names (FxMap's `TopicPrefix`) |
| `timeoutMs` | 30 000 | how long a request may wait for its reply (FxMap's `DefaultRequestTimeout`) |
| `logger` | `console` | receives the lost reply sessions |

Each request goes to the request queue of its key with a correlation id, the reply queue of the key as `replyTo`, the
session id of the client, and the headers of the mapping call as application properties, but `traceparent` and
`tracestate`: FxMap sends them as bytes, which Service Bus refuses. The owner replies on the reply queue in the same
session, which the client holds; the clients of a key share its reply queue, each reading its own session. A request
fails with:

- `NoHandlerForDistributedKeyError` when the request queue of the key does not exist (no service owns the key);
- `RequestTimedOutError` when the reply does not come in time;
- `ReceivedFaultError` when the owner failed.

## The owner

```ts
import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus';
import { ServiceBusServer } from 'nfxmap-azure-servicebus';

const server = new ServiceBusServer(new ServiceBusClient(connectionString),
    [new InMemoryQueryHandler(new UserConfig(), loadUsers)],
    { administration: new ServiceBusAdministrationClient(connectionString) });
await server.start();
// ...
await server.close();
```

| Option | Default | |
|---|---|---|
| `administration` | none | creates the queues that do not exist; without it they must exist |
| `topicPrefix` | none | the prefix of the queue names (FxMap's `TopicPrefix`) |
| `timeoutMs` | 30 000 | how long a handler may take before the request fails |
| `maxConcurrentSessions` | 8 | how many sessions (clients) are answered at once on each request queue (FxMap's `MaxConcurrentSessions`) |
| `sessionIdleTimeoutMs` | 1 000 | how long a session without requests stays with a reader before it takes another |
| `logger` | `console` | receives the failed requests, replies and sessions |

`start()` creates the request and reply queue of each key, both requiring sessions, when an administration client is
given and they do not exist, then reads each request queue in `maxConcurrentSessions` sessions at once, one request
at a time in each, as FxMap's session processor does. Every application property of a request reaches the handler as
a header. `close()` stops reading and waits for the requests being answered. `whenStopped()` rejects when a request
queue does not exist; `start()` creates it again with an administration client.

The Service Bus emulator has no management API: its queues are declared in its configuration, as in
[`test/servicebus-emulator.json`](test/servicebus-emulator.json).

## The wire

The queues of a key are `fxmap-request-<namespace>-<name>` and `fxmap-reply-<namespace>-<name>` with the dots turned
into dashes, in lower case (`fxmap-request--userof` for the key `UserOf`; `ServiceBusNames`), after the topic prefix
when there is one (`tenant-fxmap-request--userof`). The body of a request is FxMap's `DistributedMapRequest` in JSON,
and the body of a reply its `Result`, with the correlation id and the session id of the request.
