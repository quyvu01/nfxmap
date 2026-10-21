# nfxmap

FxMap for Node.js: a port of [FxMap](https://github.com/quyvu01/FxMap), the fluent distributed data-enrichment
library, written in TypeScript. Its Java sibling is [jfxmap](https://github.com/quyvu01/jfxmap).

Given a DTO with a foreign key (`userId`), nfxmap fills its related properties (`userName`, `userEmail`) from the
service that owns the entity, batching the ids of every object into one request per entity type.

> Status: early. Ported: the core (profiles, entity configurations, the mapper with id batching, dependency ordering
> and nested mapping), the full expression language, the in-memory handler, the send and receive pipelines with
> retries, the JSON wire messages of FxMap 5.1.1, the NATS, RabbitMQ, Kafka, gRPC, SQS and Azure Service
> Bus transports, the SQL (TypeORM) and MongoDB providers, GraphQL, the server supervisor and OpenTelemetry.

## Packages

| Package | Content |
|---|---|
| [`nfxmap`](packages/nfxmap) | `ProfileOf` / `defineProfile`, `EntityConfigureOf` / `defineEntity`, `createDistributedMapper`, the `RequestClient` and `QueryHandler` interfaces, `InMemoryQueryHandler` and `LocalRequestClient`, the pipelines and `RetryPolicy`, the wire messages, the `ServerSupervisor`, `validateOrThrow`; `nfxmap/expressions` is the expression language (tokenizer, parser, evaluator) |
| [`nfxmap-nats`](packages/nfxmap-nats) | `NatsRequestClient` and `NatsServer`: request-reply over NATS, on the subjects FxMap uses |
| [`nfxmap-rabbitmq`](packages/nfxmap-rabbitmq) | `RabbitMqRequestClient` and `RabbitMqServer`: request-reply over RabbitMQ (amqplib), on the exchanges and queues FxMap uses |
| [`nfxmap-kafka`](packages/nfxmap-kafka) | `KafkaRequestClient` and `KafkaServer`: requests and replies over Kafka (kafkajs), on the topics FxMap uses |
| [`nfxmap-grpc`](packages/nfxmap-grpc) | `GrpcRequestClient` and `FxMapGrpcService`: FxMap's `FxMapTransportService` over gRPC (@grpc/grpc-js) |
| [`nfxmap-sqs`](packages/nfxmap-sqs) | `SqsRequestClient` and `SqsServer`: requests and replies on the queues FxMap uses on Amazon SQS (@aws-sdk/client-sqs) |
| [`nfxmap-azure-servicebus`](packages/nfxmap-azure-servicebus) | `ServiceBusRequestClient` and `ServiceBusServer`: requests and replies on the session queues FxMap uses on Azure Service Bus (@azure/service-bus) |
| [`nfxmap-typeorm`](packages/nfxmap-typeorm) | `TypeOrmQueryHandler`: answers the requests for an entity from a SQL database, through TypeORM |
| [`nfxmap-mongodb`](packages/nfxmap-mongodb) | `MongoQueryHandler`: answers the requests for an entity from a MongoDB collection |
| [`nfxmap-graphql`](packages/nfxmap-graphql) | `NfxMapGraphQL`: resolves the mapped fields of a graphql-js schema, batched per level of the query |
| [`nfxmap-opentelemetry`](packages/nfxmap-opentelemetry) | `NfxMapTelemetry`: FxMap's spans and metrics, and the W3C trace context carried from the consumer to the owner |

## Usage

```sh
npm install nfxmap
```

A distributed key, shared by both sides: a string, or a class whose name is the key.

```ts
export class UserOf extends DistributedKey {}   // or just 'UserOf'
```

The owner of the entity (provider side):

```ts
import { EntityConfigureOf, InMemoryQueryHandler } from 'nfxmap';

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');                            // required
        this.defaultProperty('name');             // returned when a rule has no expression
        this.useDistributedKey(UserOf);           // or 'UserOf'
        this.exposedName('email', 'UserEmail');
    }
}

// or without a class:
const userConfig = defineEntity(User, { key: UserOf, id: 'id', defaultProperty: 'name',
                                        exposedNames: { UserEmail: 'email' } });

const users = new InMemoryQueryHandler(new UserConfig(), () => loadUsers());
// or, from a SQL database with nfxmap-typeorm: new TypeOrmQueryHandler(new UserConfig(), dataSource)
// or, from MongoDB with nfxmap-mongodb: new MongoQueryHandler(new UserConfig(), database.collection('users'))
```

The consumer:

```ts
import { createDistributedMapper, ProfileOf, LocalRequestClient } from 'nfxmap';

class OrderResponseProfile extends ProfileOf<OrderResponse> {
    constructor() {
        super(OrderResponse);
    }

    protected configure() {
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('userName')                              // the default property
            .for('userEmail', 'UserEmail')                // an exposed name
            .for('countryName', 'Country.Name')           // a navigation
            .for('doneTotal', "Orders:where(Status = 'Done'):sum(Total)")
            .for('displayName', c => c                    // chosen per call
                .when(ctx => 'x-admin' in ctx.headers)
                .expression('UserEmail')
                .otherwise('Name'));
    }
}

const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: new LocalRequestClient(users),   // a transport; LocalRequestClient answers in-process
    throwIfException: true,
});

await mapper.map(orders);                           // an object, an array, or a whole object graph
await mapper.map(orders, { headers: { 'x-admin': '1' } });
```

Property names are checked by TypeScript (`'userId'` must be a key of `OrderResponse`). The names in expressions are
written as FxMap writes them, in PascalCase (`Country.Name`), and find the camelCase properties of JavaScript objects
(`country.name`), so the same expression works on a .NET, Java or Node owner.

### Models without a class

A profile is matched to the objects by their class (or a superclass); plain objects without a profile, such as a
response envelope (`{ data: orders }`), are looked into. Plain objects are mapped with a profile declared under a name:

```ts
const orderProfile = defineProfile<OrderDto>('OrderDto', p => p
    .useDistributedKey('UserOf')
    .of('userId')
    .for('userName'));

await mapper.mapAs('OrderDto', plainOrders);
```

### Values

Values travel as JSON, as in FxMap, and are written back as they are parsed: a date arrives as its ISO string, a
projection (`{Id, Name}`) as a plain object with the keys written in the expression. A rule can convert its value,
which is also how a nested object gets mapped in turn by its own profile:

```ts
.for('createdAt', 'CreatedAt', { convert: v => new Date(v as string) })
.for('owner', '{Id, Name}', { convert: v => Object.assign(new UserView(), v) })
```

## Validation

`validateOrThrow` checks the profiles and the entity configurations when the service starts, for the mistakes the
mapper or a handler would otherwise report on the first request (jfxmap's `JfxMapValidator`, the checks of
FxMap.Analyzers):

```ts
import { validateOrThrow } from 'nfxmap';

validateOrThrow({ profiles: [new OrderProfile()], entities: [new UserConfig()] });
// NfxMapValidationError: nfxmap found 1 problem(s):
//  - OrderProfile.userEmail: Expression 'Email:uper' is invalid: Unknown function 'uper' at position 6
```

- a profile whose rules cannot be declared, or a second profile for the same model;
- a fixed expression that does not parse (the expressions of a conditional rule are chosen when the mapping runs, so
  they are not checked);
- rules whose keys are filled by each other, so none of them can run first;
- an entity configuration without an id or a key, or with an exposed name declared twice;
- an exposed name an expression cannot use, such as `User Email` or `User.Name`;
- two entity configurations for the same distributed key.

`validateProfiles` and `validateEntities` return the problems (`source`, `property`, `expression`, `message`) instead
of throwing.

## Around the requests

FxMap's send and receive pipelines: a `SendBehavior` runs around each request a client sends (once per attempt), a
`ReceiveBehavior` around each request a handler answers.

```ts
const tenant: SendBehavior = (request, next) => next(request.withHeader('x-tenant', currentTenant()));

const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: transportClient,
    sendBehaviors: [tenant],
    retryPolicy: RetryPolicy.retries(3)                    // FxMap's SetRetryPolicy
        .exponentialDelay(200, 5_000)
        .shouldRetry(e => !(e instanceof ReceivedFaultError)),
});

const handler = receivePipeline(users, [audit]);
```

## Supervision

FxMap's `ServerSupervisor`: it starts the servers of a service (`NatsServer`, `KafkaServer`...) and starts them again
when they fail, after a backoff that grows from 1 second up to 5 minutes. The restarts are limited to 32 a minute, and
3 failures in a row open a circuit breaker for a minute.

```ts
import { ServerSupervisor } from 'nfxmap';

const supervisor = new ServerSupervisor({
    strategy: 'oneForOne',                       // or 'oneForAll', 'restForOne'
    directives: [[AuthenticationError, 'stop']], // 'resume', 'restart' (default), 'stop', 'escalate'
})
    .register('nats', natsServer)
    .register('kafka', kafkaServer)
    .onHealthChange(change => console.log(change.serverId, change.current));
await supervisor.start();
supervisor.states();                             // health, restarts, last failure... of each server
await supervisor.close();
```

## OpenTelemetry

```sh
npm install nfxmap nfxmap-opentelemetry @opentelemetry/api
```

```ts
import { NfxMapTelemetry } from 'nfxmap-opentelemetry';

const telemetry = new NfxMapTelemetry();
const mapper = createDistributedMapper({ profiles, requestClient: telemetry.instrumentClient(natsClient) });
const server = new NatsServer(connection, telemetry.instrumentHandlers([users]));
```

The spans `fxmap.request` and `fxmap.process` and the histograms `fxmap.client.request.duration` and
`fxmap.server.request.duration` have FxMap's names, and the trace context travels as the W3C `traceparent` header, so a
trace goes from a Node consumer to a .NET or Java owner and back. See
[`nfxmap-opentelemetry`](packages/nfxmap-opentelemetry) for the attributes.

## Interoperability

Use a string key on both sides (`'UserOf'` here, `UseDistributedKey("UserOf")` in .NET, `useDistributedKey("UserOf")`
in jfxmap). `WireMessages` reads and writes the JSON that FxMap 5.1.1 sends on its message transports
(`{"SelectorIds":[...],"Expressions":[...]}`, and the `Result` reply with its `Fault`), `DotNetKeyNames` gives the
names FxMap derives from a key, `WireResponder` answers a received request with the handler of its key, and
`PendingReplies` holds the requests a client waits for, by correlation id: the pieces the transports are built on. A transport package speaks to the FxMap and jfxmap services on the same broker.

[`interop`](interop/) checks it against a real .NET service on FxMap 5.1.1 and a Java service on jfxmap, over NATS,
RabbitMQ, Kafka, SQS and Service Bus, in both directions, traces included.

[`samples`](samples/) has a user service and an order service, which also run with the samples of jfxmap
(`node samples/run.mjs`).

## NATS

```sh
npm install nfxmap nfxmap-nats @nats-io/transport-node
```

```ts
import { connect } from '@nats-io/transport-node';
import { NatsRequestClient, NatsServer } from 'nfxmap-nats';

const connection = await connect({ servers: 'nats://localhost:4222' });

// The consumer
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new NatsRequestClient(connection) });

// The owner
const server = new NatsServer(connection, [users]);
await server.start();
```

See [`nfxmap-nats`](packages/nfxmap-nats) for the options.

## RabbitMQ

```sh
npm install nfxmap nfxmap-rabbitmq amqplib
```

```ts
import { connect } from 'amqplib';
import { RabbitMqRequestClient, RabbitMqServer } from 'nfxmap-rabbitmq';

const connection = await connect('amqp://localhost');

// The consumer
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new RabbitMqRequestClient(connection) });

// The owner: the name of the service names its queue
const server = new RabbitMqServer(connection, 'user-service', [users]);
await server.start();
```

See [`nfxmap-rabbitmq`](packages/nfxmap-rabbitmq) for the options.

## Kafka

```sh
npm install nfxmap nfxmap-kafka kafkajs
```

```ts
import { Kafka } from 'kafkajs';
import { KafkaRequestClient, KafkaServer } from 'nfxmap-kafka';

const kafka = new Kafka({ clientId: 'order-service', brokers: ['localhost:9092'] });

// The consumer: the name of the service is in the name of its reply topic
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new KafkaRequestClient(kafka, 'order-service') });

// The owner
const server = new KafkaServer(kafka, [users]);
await server.start();
```

See [`nfxmap-kafka`](packages/nfxmap-kafka) for the options.

## gRPC

```sh
npm install nfxmap nfxmap-grpc @grpc/grpc-js
```

```ts
import { Server, ServerCredentials } from '@grpc/grpc-js';
import { FxMapGrpcService, GrpcRequestClient } from 'nfxmap-grpc';

// The consumer: the hosts of the services that own keys
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new GrpcRequestClient({ hosts: ['http://user-service:9090'] }) });

// The owner
const server = new Server();
new FxMapGrpcService([users]).addTo(server);
server.bindAsync('0.0.0.0:9090', ServerCredentials.createInsecure(), () => undefined);
```

See [`nfxmap-grpc`](packages/nfxmap-grpc) for the options.

## Amazon SQS

```sh
npm install nfxmap nfxmap-sqs @aws-sdk/client-sqs
```

```ts
import { SQSClient } from '@aws-sdk/client-sqs';
import { SqsRequestClient, SqsServer } from 'nfxmap-sqs';

const sqs = new SQSClient({ region: 'us-east-1' });

// The consumer
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new SqsRequestClient(sqs) });

// The owner: creates and polls the queue of each of its keys
const server = new SqsServer(sqs, [users]);
await server.start();
```

See [`nfxmap-sqs`](packages/nfxmap-sqs) for the options.

## Azure Service Bus

```sh
npm install nfxmap nfxmap-azure-servicebus @azure/service-bus
```

```ts
import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus';
import { ServiceBusRequestClient, ServiceBusServer } from 'nfxmap-azure-servicebus';

const serviceBus = new ServiceBusClient(connectionString);

// The consumer
const mapper = createDistributedMapper({ profiles: [new OrderResponseProfile()],
                                         requestClient: new ServiceBusRequestClient(serviceBus) });

// The owner: creates the session queues of its keys with an administration client, and reads them
const server = new ServiceBusServer(serviceBus, [users],
                                    { administration: new ServiceBusAdministrationClient(connectionString) });
await server.start();
```

See [`nfxmap-azure-servicebus`](packages/nfxmap-azure-servicebus) for the options.

## GraphQL

```sh
npm install nfxmap nfxmap-graphql graphql
```

```ts
import { NfxMapGraphQL } from 'nfxmap-graphql';

const nfxmap = new NfxMapGraphQL(mapper, { typeNames: [[OrderDto, 'Order']] });
// The GraphQL type Order gets a resolver for each of its fields that the profile of OrderDto maps
const schema = nfxmap.instrument(makeExecutableSchema({ typeDefs, resolvers }));
// Each request needs a context object; its headers go with the requests
await graphql({ schema, source, contextValue: { [NfxMapGraphQL.HEADERS]: { authorization } } });
```

The selected fields of every object of a level are mapped together: one request per distributed key, with only
those fields. See [`nfxmap-graphql`](packages/nfxmap-graphql) for the details.

## Expressions

```ts
import { ExpressionEvaluator, parseExpression } from 'nfxmap/expressions';

const evaluator = new ExpressionEvaluator();
evaluator.evaluate("Orders:where(Status = 'Done'):sum(Total)", customer);
evaluator.evaluate('Orders:orderBy(Total desc):limit(10).{Id, Total}', customer);   // an array of plain objects
const tree = parseExpression('{Id, (Nickname ?? Name) as DisplayName}');
```

See FxMap's [expression documentation](https://fxmapper.net/docs/expressions) for the syntax. In JavaScript:

- numbers are JavaScript numbers (or bigints): `:divide` of two whole numbers is not an integer division, and
  `:round` rounds a midpoint to the even number as .NET does;
- dates are `Date`s, read in UTC; `:format` takes the .NET patterns (`'yyyy-MM-dd HH:mm'`);
- `Address.City` fails when `Address` is null; `Address?.City` gives null; `undefined` is null.

## Build

Node 20 or later:

```sh
npm install
npm test
npm run build      # ESM and CommonJS, with type declarations
```
