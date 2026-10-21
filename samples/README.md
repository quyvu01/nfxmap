# nfxmap samples

Two Node services, the same as the [samples of jfxmap](https://github.com/quyvu01/jfxmap/tree/main/samples): a user
service that owns the users, and an order service that shows its orders with the fields of their users.

| Service | Owns | Ports | What nfxmap does there |
|---|---|---|---|
| [`user-service`](user-service) | users, countries, addresses (TypeORM, SQLite in memory) | HTTP 8081, gRPC 9091 | `UserConfig` exposes `User` under the string key `UserOf`; `TypeOrmQueryHandler` answers it from the database and `FxMapGrpcService` serves it on gRPC |
| [`order-service`](order-service) | orders, which hold only a `userId` | HTTP 8082 | `OrderResponseProfile` fills each order's user name, email, country, upper-case name and address count from `UserOf` over gRPC, all the orders of a response in one call; `validateOrThrow` checks the profile when the service starts |

`UserOf` is a string key, so a .NET service on FxMap or a Java one on jfxmap can take either side: the order service of
jfxmap shows its orders from this user service, and this order service shows its orders from the user service of
jfxmap. The CI checks both.

## Run

One script, on macOS, Linux and Windows, with Node 20 or later: it builds both services, starts the user service,
waits for it, starts the order service and prints `/orders`. Both keep running until Ctrl+C; their logs are in
`samples/build/logs/`.

```sh
npm install
node samples/run.mjs
```

Add `--check` to only check that `/orders` shows the users' fields, then stop both; the CI runs that on the three
systems. Then:

```sh
curl localhost:8082/orders      # every order with its user's fields, in one gRPC call
curl localhost:8082/orders/2
curl localhost:8081/users
```

To run a service of jfxmap in place of one of them, give its command:

```sh
USER_SERVICE_COMMAND="java -jar ../jfxmap/samples/user-service/build/libs/user-service-0.1.0-SNAPSHOT.jar" node samples/run.mjs
ORDER_SERVICE_COMMAND="java -jar ../jfxmap/samples/order-service/build/libs/order-service-0.1.0-SNAPSHOT.jar" node samples/run.mjs
```

(`./gradlew :samples:user-service:bootJar :samples:order-service:bootJar` in jfxmap builds them.)

## Test

`order-service/test` starts both services in one process, on free ports, and checks what `/orders` shows:

```sh
npm test -w samples/order-service
```
