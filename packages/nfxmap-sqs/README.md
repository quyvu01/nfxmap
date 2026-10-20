# nfxmap-sqs

The Amazon SQS transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's
`FxMap.Aws.Sqs`: the same queues, attributes and messages as FxMap 5.1.1, so a Node service and a .NET
([FxMap](https://github.com/quyvu01/FxMap)) or Java ([jfxmap](https://github.com/quyvu01/jfxmap)) service call each other.

```sh
npm install nfxmap nfxmap-sqs @aws-sdk/client-sqs
```

It runs on the AWS SDK for JavaScript v3 (`@aws-sdk/client-sqs`). The `SQSClient` belongs to the application: its
region, credentials and endpoint (LocalStack, ElasticMQ) are configured there.

## The consumer

```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { createDistributedMapper } from 'nfxmap';
import { SqsRequestClient } from 'nfxmap-sqs';

const client = new SqsRequestClient(new SQSClient({ region: 'us-east-1' }));
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()], requestClient: client });
// When the application stops: fails the waiting requests and deletes the response queue
await client.close();
```

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a request may wait for its reply (FxMap's `DefaultRequestTimeout`) |
| `waitTimeSeconds` | 20 | how long a poll of the response queue waits for messages (0 to 20) |
| `machineName` | the host name | the machine in the name of the response queue |
| `logger` | `console` | receives the failed polls |

Each request goes to the queue of its key with the attributes `CorrelationId`, `ReplyTo` (the URL of the response
queue of the client), `Type` (the assembly-qualified name of the key) and the headers of the mapping call. A header
without a value, or whose name SQS refuses as an attribute name, is left out; SQS allows 10 attributes per message, so
7 headers at most. The client creates its response queue, `fxmap-response-<machine>-<uuid>` (messages kept 5 minutes),
on its first request, and polls it. A request fails with:

- `NoHandlerForDistributedKeyError` when the queue of the key does not exist (no service owns the key);
- `RequestTimedOutError` when the reply does not come in time;
- `ReceivedFaultError` when the owner failed.

## The owner

```ts
import { SqsServer } from 'nfxmap-sqs';

const server = new SqsServer(new SQSClient({ region: 'us-east-1' }),
    [new InMemoryQueryHandler(new UserConfig(), loadUsers)]);
await server.start();
// ...
await server.close();
```

| Option | Default | |
|---|---|---|
| `timeoutMs` | 30 000 | how long a handler may take before the request fails |
| `waitTimeSeconds` | 20 | how long a poll waits for messages (0 to 20) |
| `maxConcurrentProcessing` | 128 | how many requests are answered at once (FxMap's `MaxConcurrentProcessing`) |
| `logger` | `console` | receives the failed requests, polls and replies |

`start()` creates the queue of each key when it does not exist (visibility timeout 30 seconds, long polling 20
seconds, as FxMap creates it) and polls each one, 10 messages at a time. The received messages are deleted at once, as
FxMap does, and answered on the queue of their `ReplyTo` attribute; every attribute of a request reaches the handler as
a header. The instances of a service share the queues, so each request reaches one of them.

`close()` stops polling and waits for the requests being answered; the messages received by a poll that ends after
`close()` go back to the queue at once, for another instance. `whenStopped()` rejects when a queue of the server is
deleted; `start()` creates it again.

## The wire

The request queue of a key is `fxmap-<namespace>-<name>` with the dots turned into dashes, in lower case
(`fxmap--userof` for the key `UserOf`, `fxmap-shop-keys-userof` for `Shop.Keys.UserOf`; `SqsNames.queue`). The body of
a request is FxMap's `DistributedMapRequest` in JSON, and the body of a reply its `Result`, with the `CorrelationId` of
the request.
