# nfxmap-graphql

The GraphQL integration of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), as FxMap's
`FxMap.HotChocolate` and jfxmap's `jfxmap-graphql`: the fields that the profiles map are resolved through nfxmap, and
the fields of every object of a level of the query are mapped together.

```sh
npm install nfxmap nfxmap-graphql graphql
```

It runs on [graphql](https://www.npmjs.com/package/graphql) 16 or 17, with any server built on graphql-js (Apollo
Server, graphql-yoga, Mercurius, graphql-http...).

## Usage

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { NfxMapGraphQL } from 'nfxmap-graphql';

const typeDefs = `
    type Query { orders: [Order] }
    type Order { id: Int userId: Int userName: String userEmail: String }
`;

const nfxmap = new NfxMapGraphQL(mapper, { typeNames: [[OrderDto, 'Order']] });
const schema = nfxmap.instrument(makeExecutableSchema({ typeDefs, resolvers: { Query: { orders: loadOrders } } }));
```

A GraphQL object type named after a profiled model gets a resolver for each of its fields named after a property with
a rule: `userName` and `userEmail` of `Order` here. A type is named after the class of its profile (`OrderDto`), or
the name a profile was declared with for plain objects (`defineProfile('PlainOrder', ...)`), unless `typeNames` names
it otherwise. The other fields keep their resolvers.

For `{ orders { userName } }`, the resolvers of the `userName` of every order call `mapper.mapProperties` once, with
every order and only the selected fields: one request per distributed key, whatever the number of orders, and only
the expressions of those fields. A field whose key another rule fills (a province name read from the province id of
the user) gets that rule first. The objects of every parent of a level are batched together:
`{ customers { orders { userName } } }` sends one request too. A failed mapping is an error of the field.

| Option | Default | |
|---|---|---|
| `typeNames` | none | the GraphQL type of a model, as `[model, typeName]` pairs or a `Map` |
| `headers` | `context.nfxmapHeaders` | the headers of the requests, from the context of the GraphQL request |

## Wiring the resolvers

- `instrument(schema)` sets the resolvers of the mapped fields that the schema has, in place, and returns it: for a
  schema built from SDL, with `buildSchema` or in code. Types and fields the schema does not have are left out.
- `resolvers()` returns them by type and field, to merge with the resolvers of the application. graphql-tools refuses
  a resolver of a field that the schema does not have, so give it
  `resolverValidationOptions: { requireResolversToMatchSchema: 'ignore' }` when the profile maps more fields than the
  schema shows.
- `resolver(property)` is the resolver of one field.

## The context

The batching needs a context object per GraphQL request, which servers give: the data loader of the request is
created on its first mapped field and kept with the context. Without a context each field is mapped on its own.

```ts
await graphql({ schema, source, contextValue: { [NfxMapGraphQL.HEADERS]: { authorization: 'Bearer ...' } } });

// Or with Apollo Server, from the HTTP request:
startStandaloneServer(server, {
    context: async ({ req }) => ({ [NfxMapGraphQL.HEADERS]: { authorization: req.headers.authorization ?? '' } }),
});
```

An application that creates its data loaders itself puts the one of the request under `NfxMapGraphQL.LOADER`
(`nfxmapLoader`): `nfxmap.createLoader(headers)`, or its own `DataLoader` whose batch function calls
`nfxmap.load(keys, headers)`, which returns the values of the fields in the order of the keys.
