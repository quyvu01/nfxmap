# nfxmap-kafka

The Kafka transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's `FxMap.Kafka`:
requests on the topic of each distributed key and replies on the topic of each client, with the JSON messages of FxMap
5.1.1, so a Node service and a .NET ([FxMap](https://github.com/quyvu01/FxMap)) or Java
([jfxmap](https://github.com/quyvu01/jfxmap)) service on the same brokers answer each other.

```sh
npm install nfxmap nfxmap-kafka kafkajs
```

It uses a client of [KafkaJS](https://kafka.js.org) 2 (`new Kafka({...})`), which belongs to the caller: the brokers,
SSL and SASL are set on it.

## The consumer

```ts
import { Kafka } from 'kafkajs';
import { createDistributedMapper } from 'nfxmap';
import { KafkaRequestClient } from 'nfxmap-kafka';

const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] });
const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: new KafkaRequestClient(kafka, 'order-service', { timeoutMs: 10_000 }),
});
```

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a request waits for its reply (FxMap's `DefaultRequestTimeout`) |
| `replicationFactor` | 1 | the replication factor of the reply topic |

On its first request the client creates its reply topic, `fxmap-response-topic-<service>-<uuid>` (one partition), and
reads it in a consumer group of its own. Each request goes to the request topic of its key, keyed by a correlation id,
wrapped with the reply topic (`{"Message":{...},"ReplyTo":"..."}`), with the headers of the mapping call as Kafka
headers. A request fails with:

- `NoHandlerForDistributedKeyError` at once, when the request topic of the key does not exist (no service owns it);
- `RequestTimedOutError` when the reply does not come in time;
- `ReceivedFaultError` when the owner failed, with the exceptions it sent.

`client.close()` disconnects the producer and the consumer of the client and fails the requests that still wait; the
reply topic stays.

## The owner

```ts
import { KafkaServer } from 'nfxmap-kafka';

const server = new KafkaServer(kafka, [new InMemoryQueryHandler(new UserConfig(), loadUsers)]);
await server.start();
// ...
await server.close();
```

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a handler may take before the request fails |
| `partitions` | 1 | the partitions of each request topic the server creates (a topic that exists is not changed) |
| `replicationFactor` | 1 | the replication factor of the topics the server creates |
| `maxConcurrentProcessing` | 128 | how many requests of a batch are answered at once |
| `logger` | `console` | where failed requests are logged |

The server creates the request topic of each key, `fxmap-request-topic-<key in lower case>`, and reads them in the
consumer group `fxmap-rpc-server-group`, as FxMap does: the instances of a service share the partitions, and each
request is answered once. The offset of a request is committed once it is answered, whether it succeeded or failed.

`server.close()` stops reading after the requests of the current batch are answered; the topics stay.
`server.whenStopped()` resolves when the server is closed, and rejects when its consumer crashes for good (KafkaJS
restarts it after the errors it can retry). `start()` starts it again.
