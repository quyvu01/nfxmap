# interop

nfxmap in one system with the other ports of FxMap. Services on any of them ask each other through the same string
key, `useDistributedKey('UserOf')` in Node, `UseDistributedKey("UserOf")` in .NET, `useDistributedKey("UserOf")` in
Java, because they send the same subjects, exchanges, queues, topics, headers and JSON as FxMap 5.1.1.

The tests start two services as processes, each in a role:

- [dotnet-probe](dotnet-probe): a .NET service on [FxMap](https://github.com/quyvu01/FxMap) 5.1.1;
- [java-probe](java-probe): a Java service on [jfxmap](https://github.com/quyvu01/jfxmap), built from its sources.

Over NATS, RabbitMQ, Kafka, SQS (LocalStack) and Service Bus (its emulator), for each of them:

- a Node client asks their owner of `UserOf`, and their consumer asks a Node owner;
- the trace goes across, with `nfxmap-opentelemetry` on the Node side, in both directions. Service Bus carries no
  trace: FxMap sends the trace context in bytes, which Service Bus refuses, so nfxmap and jfxmap leave it out and the
  owner starts a trace of its own.

## Run

```sh
dotnet publish interop/dotnet-probe -c Release -o interop/dotnet-probe/out
git clone https://github.com/quyvu01/jfxmap ../jfxmap
../jfxmap/gradlew -p interop/java-probe installDist -PjfxmapDir="$PWD/../jfxmap"

NFXMAP_DOTNET_PROBE="dotnet $PWD/interop/dotnet-probe/out/DotnetProbe.dll" \
NFXMAP_JAVA_PROBE="$PWD/interop/java-probe/build/install/java-probe/bin/java-probe" \
NATS_URL=nats://localhost:4222 RABBITMQ_URL=amqp://guest:guest@localhost:5672 KAFKA_BROKERS=localhost:9092 \
SQS_ENDPOINT=http://localhost:4566 \
SERVICEBUS_CONNECTION_STRING='Endpoint=sb://localhost:5673;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;' \
npm test -w interop
```

A probe or a broker left unset is skipped. The Service Bus emulator reads its queues from
[servicebus-emulator.json](servicebus-emulator.json); the `interop` job of the CI starts everything.
