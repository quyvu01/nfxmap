# nfxmap-rabbitmq

The RabbitMQ transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's
`FxMap.RabbitMq`: request-reply on the exchange of each distributed key, with the JSON messages of FxMap 5.1.1, so a
Node service and a .NET ([FxMap](https://github.com/quyvu01/FxMap)) or Java
([jfxmap](https://github.com/quyvu01/jfxmap)) service on the same broker answer each other.

```sh
npm install nfxmap nfxmap-rabbitmq amqplib
```

It uses a connection of [amqplib](https://github.com/amqp-node/amqplib) (0.10 or later, `connect()` of its promise
API), or of any client with the same promise API. The connection belongs to the caller, who closes it.

## The consumer

```ts
import { connect } from 'amqplib';
import { createDistributedMapper } from 'nfxmap';
import { RabbitMqRequestClient } from 'nfxmap-rabbitmq';

const connection = await connect('amqp://localhost');
const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: new RabbitMqRequestClient(connection, { timeoutMs: 10_000 }),
});
```

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a request waits for its reply (FxMap's `DefaultRequestTimeout`) |

Each request is published to the exchange of its key with a correlation id, the reply queue of the client
(`fxmap-reply-<uuid>`, exclusive to it), the .NET name of the key as type, and the headers of the mapping call as AMQP
headers. A request fails with:

- `NoHandlerForDistributedKeyError` at once, when the exchange of the key does not exist or routes to no queue (no
  service owns the key);
- `RequestTimedOutError` when the reply does not come in time;
- `ReceivedFaultError` when the owner failed, with the exceptions it sent.

`client.close()` closes the channels of the client and fails the requests that still wait.

## The owner

```ts
import { RabbitMqServer } from 'nfxmap-rabbitmq';

const server = new RabbitMqServer(connection, 'user-service', [new InMemoryQueryHandler(new UserConfig(), loadUsers)]);
await server.start();
// ...
await server.close();
```

The second argument is the name of the service, which names its queue, as FxMap names it after the entry assembly:
`fxmap-rpc-queue-user-service`. Two services with the same name share one queue, and each gets the requests of the
other; the instances of one service share it, and each request is answered once.

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a handler may take before the request fails |
| `channelPoolSize` | 5 | how many channels consume the queue (FxMap's `ChannelPoolSize`) |
| `maxConcurrentProcessing` | 128 | how many requests each channel answers at once (its prefetch) |
| `logger` | `console` | where failed requests are logged |

`server.close()` stops consuming and waits for the requests being answered; the queue and the exchanges stay.
`server.whenStopped()` resolves when the server is closed, and rejects when it stops on its own: RabbitMQ cancelled its
consumers (the queue was deleted), or closed a consumer channel or the connection. `start()` declares the queue again.

## Names

`RabbitMqNames` gives the names FxMap uses:

- the exchange of a key, direct: `FxMap-<namespace>:<name>` (`UserOf` → `FxMap-:UserOf`, `Shop.Keys.UserOf` →
  `FxMap-Shop.Keys:UserOf`);
- the routing key of every request, `fxmap-rpc-rounting-key`, with FxMap's spelling;
- the queue of a service, `fxmap-rpc-queue-<name in lower case>`.

The queue and the exchanges are declared as FxMap declares them (not durable), so that the services of either side
can declare them first.
