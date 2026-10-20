# nfxmap

FxMap for Node.js: a port of [FxMap](https://github.com/quyvu01/FxMap), the fluent distributed data-enrichment
library, written in TypeScript. Its Java sibling is [jfxmap](https://github.com/quyvu01/jfxmap).

Given a DTO with a foreign key (`userId`), nfxmap fills its related properties (`userName`, `userEmail`) from the
service that owns the entity, batching the ids of every object into one request per entity type.

> Status: early. Ported: the core (profiles, entity configurations, the mapper with id batching, dependency ordering
> and nested mapping), the full expression language, the in-memory handler, the send and receive pipelines with
> retries, the JSON wire messages of FxMap 5.1.1, the NATS transport and the SQL provider on TypeORM. Not yet: the
> other transports (RabbitMQ, Kafka, gRPC, SQS, Azure Service Bus), MongoDB, GraphQL, supervision and telemetry.

## Packages

| Package | Content |
|---|---|
| [`nfxmap`](https://github.com/quyvu01/nfxmap/tree/main/packages/nfxmap) | `ProfileOf` / `defineProfile`, `EntityConfigureOf` / `defineEntity`, `createDistributedMapper`, the `RequestClient` and `QueryHandler` interfaces, `InMemoryQueryHandler` and `LocalRequestClient`, the pipelines and `RetryPolicy`, the wire messages; `nfxmap/expressions` is the expression language (tokenizer, parser, evaluator) |
| [`nfxmap-nats`](https://github.com/quyvu01/nfxmap/tree/main/packages/nfxmap-nats) | `NatsRequestClient` and `NatsServer`: request-reply over NATS, on the subjects FxMap uses |
| [`nfxmap-typeorm`](https://github.com/quyvu01/nfxmap/tree/main/packages/nfxmap-typeorm) | `TypeOrmQueryHandler`: answers the requests for an entity from a SQL database, through TypeORM |

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

## Interoperability

Use a string key on both sides (`'UserOf'` here, `UseDistributedKey("UserOf")` in .NET, `useDistributedKey("UserOf")`
in jfxmap). `WireMessages` reads and writes the JSON that FxMap 5.1.1 sends on its message transports
(`{"SelectorIds":[...],"Expressions":[...]}`, and the `Result` reply with its `Fault`), `DotNetKeyNames` gives the
names FxMap derives from a key, and `WireResponder` answers a received request with the handler of its key: the
pieces the transports are built on. A transport package speaks to the FxMap and jfxmap services on the same broker.

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

See [`nfxmap-nats`](https://github.com/quyvu01/nfxmap/tree/main/packages/nfxmap-nats) for the options.

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
