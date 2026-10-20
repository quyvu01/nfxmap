# nfxmap-mongodb

The MongoDB data provider of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), on the official
[`mongodb`](https://www.npmjs.com/package/mongodb) driver: the counterpart of FxMap's `FxMap.MongoDb` and jfxmap's
`jfxmap-mongodb`.

```sh
npm install nfxmap nfxmap-mongodb mongodb
```

```ts
import { MongoQueryHandler } from 'nfxmap-mongodb';

const users = new MongoQueryHandler(new UserConfig(), database.collection('users'));
```

| Option | Default | |
|---|---|---|
| `idField` | `_id` for an `id` property, the property name otherwise | the stored name of the id |
| `idType` | `auto` | the type of the stored ids: `objectId`, `uuid`, `number`, `string`, or `auto` to try each one the requested id can be read as |
| `map` | none | turns a document into the entity (an instance of its class, say) |
| `batchSize` | 1000 | how many ids one query asks for |
| `now` | the clock | today, for `:daysAgo` |

Each chunk of ids is one `find({<id field>: {$in: [...]}})`. The expressions are then evaluated on the loaded documents
by the evaluator of the in-memory handler, so the whole expression language works and gives the answers of the
in-memory handler. That includes sub-documents (`Country.Name`) and arrays (`Orders:where(Status = 'Done'):sum(Total)`).

Without `map`, only the top-level fields the expressions name are loaded. Each name is loaded in the spelling of the
expression, in camelCase and in PascalCase, so the documents that FxMap's .NET services write (`{ "Name": ... }`) are
read too. The stored id is read under the name of the configured id property (`id` for `_id`).

With `map`, whole documents are loaded, since the entity may read any field (in a getter, say).
