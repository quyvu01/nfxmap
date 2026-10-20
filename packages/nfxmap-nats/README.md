# nfxmap-nats

The NATS transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's `FxMap.Nats`:
request-reply on the subject of each distributed key, with the JSON messages of FxMap 5.1.1, so a Node service and a
.NET ([FxMap](https://github.com/quyvu01/FxMap)) or Java ([jfxmap](https://github.com/quyvu01/jfxmap)) service on the
same NATS server answer each other.

```sh
npm install nfxmap nfxmap-nats @nats-io/transport-node
```

It uses the connection of the [nats.js](https://github.com/nats-io/nats.js) v3 client (`@nats-io/transport-node`, or
any transport built on `@nats-io/nats-core`). The connection belongs to the caller, who closes it.

## The consumer

```ts
import { connect } from '@nats-io/transport-node';
import { createDistributedMapper } from 'nfxmap';
import { NatsRequestClient } from 'nfxmap-nats';

const connection = await connect({ servers: 'nats://localhost:4222' });
const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: new NatsRequestClient(connection, { topicPrefix: 'prod', timeoutMs: 10_000 }),
});
```

| Option | Default | |
|---|---|---|
| `topicPrefix` | none | FxMap's `TopicPrefix`: the subjects become `<prefix>-fxmap-...` |
| `timeoutMs` | 30 000 | how long a request waits for its reply (FxMap's `DefaultRequestTimeout`) |

The headers of a mapping call travel as NATS headers. A request fails with:

- `NoHandlerForDistributedKeyError` when nobody listens on the subject of the key (NATS answers "no responders" at once);
- `RequestTimedOutError` when the reply does not come in time;
- `ReceivedFaultError` when the owner failed, with the exceptions it sent.

## The owner

```ts
import { NatsServer } from 'nfxmap-nats';

const server = new NatsServer(connection, [new InMemoryQueryHandler(new UserConfig(), loadUsers)], {
    topicPrefix: 'prod',
});
await server.start();
// ...
await server.close();
```

| Option | Default | |
|---|---|---|
| `topicPrefix` | none | as on the consumer |
| `timeoutMs` | 30 000 | how long a handler may take before the request fails |
| `maxConcurrentProcessing` | 128 | how many requests are answered at once; the others wait in the subscription |
| `logger` | `console` | where failed requests are logged |

As in FxMap, the subscriptions have no queue group: every instance of the service answers, and the requester takes the
first reply. `server.whenStopped()` resolves when the server is closed, and rejects when the connection closes under
it (the connection was closed or ran out of reconnect attempts). A server that stopped can be started again while its
connection is open.

## Subjects

`NatsSubjects.of(key, prefix)` gives the subject of a key, as FxMap names it: `fxmap-<namespace>-<name>` in lower case,
where a string key has an empty namespace (`UserOf` → `fxmap--userof`, `Shop.Keys.UserOf` → `fxmap-shop.keys-userof`).
