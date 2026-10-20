# nfxmap-typeorm

The SQL data provider of [nfxmap](https://github.com/quyvu01/nfxmap) (FxMap for Node.js), on
[TypeORM](https://typeorm.io): the counterpart of FxMap's `FxMap.EntityFrameworkCore` and jfxmap's `jfxmap-jpa`. It
answers the requests for an entity from any database TypeORM supports (PostgreSQL, MySQL, MariaDB, SQLite, SQL Server,
Oracle...).

```sh
npm install nfxmap nfxmap-typeorm typeorm
```

```ts
import { TypeOrmQueryHandler } from 'nfxmap-typeorm';

const users = new TypeOrmQueryHandler(new UserConfig(), dataSource);

// in the same process
const client = new LocalRequestClient(users);
// or behind a transport
const server = new NatsServer(connection, [users]);
```

`UserConfig` is the entity configuration of nfxmap (`EntityConfigureOf<User>` or `defineEntity(User, ...)`); its entity
class is a TypeORM entity of the data source (an entity declared with an `EntitySchema` is found by its name). The data
source may be initialized after the handler is created.

| Option | Default | |
|---|---|---|
| `batchSize` | 1000 | how many ids one query asks for |
| `maxJoinDepth` | 5 | how deep the associations named in the expressions are followed |
| `now` | the clock | today, for `:daysAgo` |

## How a request is answered

Each chunk of ids is one `find`, `where <id> in (...)`, that loads only what the expressions read:

- the columns whose names appear in the expressions, and the primary keys;
- the associations they navigate (`Country.Name`, `Orders:where(Status = 'Done'):sum(Total)`), each with one more query,
  the items of a collection in the order of their primary key;
- all the columns of an entity whose class has a getter named in an expression, since a getter may read any column.

The expressions are then evaluated on the loaded entities by the evaluator of the in-memory handler, so the whole
expression language is supported, with the answers of the in-memory handler and one difference taken from FxMap's
database handlers: a navigation through a null association (`Country.Name` when there is no country) is null instead of
an error.

The requested ids are strings; they are converted to the type of the id column (a string, number, bigint or uuid column),
and an id that does not convert (`not-a-uuid`) is not found. The configured id does not have to be the primary key.

Values are those of TypeORM: a `decimal` or `bigint` column is read as a string by the PostgreSQL and MySQL drivers,
which `:sum` and the other math functions do not add up; give such a column a `transformer` that reads a number.

## Not yet

FxMap's EF Core handler and jfxmap's JPA handler translate the expressions into SQL (aggregations become subqueries
and only the results are read). This handler loads the rows of the collections an expression aggregates.
