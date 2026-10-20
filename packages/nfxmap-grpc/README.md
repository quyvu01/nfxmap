# nfxmap-grpc

The gRPC transport of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's `FxMap.Grpc`: the
`FxMapTransportService` of FxMap 5.1.1 ([`proto/fxMap.proto`](proto/fxMap.proto), unchanged), client and server, so a
Node service and a .NET ([FxMap](https://github.com/quyvu01/FxMap)) or Java
([jfxmap](https://github.com/quyvu01/jfxmap)) service call each other.

```sh
npm install nfxmap nfxmap-grpc @grpc/grpc-js
```

It runs on [@grpc/grpc-js](https://github.com/grpc/grpc-node) 1.10 or later. The contract is built in: there is no
code to generate.

## The consumer

```ts
import { createDistributedMapper } from 'nfxmap';
import { GrpcRequestClient } from 'nfxmap-grpc';

const mapper = createDistributedMapper({
    profiles: [new OrderResponseProfile()],
    requestClient: new GrpcRequestClient({ hosts: ['http://user-service:9090', 'https://product-service:9443'] }),
});
```

| Option | Default | |
|---|---|---|
| `hosts` | (required) | the services that own keys: `http://host:port` and `host:port` are plaintext, `https://host:port` uses TLS |
| `timeoutMs` | 3 000 | how long a call may take (as in FxMap) |
| `credentials` | from the URL | the `ChannelCredentials` of a host, for client certificates or a custom CA |

The first time a key is requested, the client asks each host it has not reached yet which keys it handles
(`GetDistributedKeys`), and from then on sends the requests for that key to that host (`GetItems`), with the headers of
the mapping call as metadata. A host that cannot be reached is asked again on the next unknown key. A request fails
with:

- `NoHandlerForDistributedKeyError` when no host owns the key;
- `RequestTimedOutError` when the call does not end in time;
- `ReceivedFaultError` when the owner failed or refused the request, with the gRPC status and its message.

`client.close()` closes the channels.

## The owner

```ts
import { Server, ServerCredentials } from '@grpc/grpc-js';
import { FxMapGrpcService } from 'nfxmap-grpc';

const server = new Server();
new FxMapGrpcService([new InMemoryQueryHandler(new UserConfig(), loadUsers)]).addTo(server);
server.bindAsync('0.0.0.0:9090', ServerCredentials.createInsecure(), () => undefined);
```

The service goes on any gRPC server, next to the other services of the application (`addTo(server)`, or
`server.addService(service.definition, service.implementation)`). It answers `GetDistributedKeys` with its keys and
`GetItems` with the handler of the key; the text metadata of a call reaches the handler as headers. A key it does not
own fails with `NOT_FOUND`, expressions that are not a JSON array with `INVALID_ARGUMENT`, and a handler that fails with
`INTERNAL` and its message. The option `logger` (default `console`) receives the failed requests.

## The wire

Each key travels as the assembly-qualified name FxMap gives a string key
(`UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null`; `GrpcKeyNames`), and
the expressions of a request as one JSON array in the `expression` field (`[null,"Email"]`; `ExpressionsJson`).
`FXMAP_PACKAGE_DEFINITION` is the contract, for `loadPackageDefinition`.
