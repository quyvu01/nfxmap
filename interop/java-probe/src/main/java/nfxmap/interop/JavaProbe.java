package nfxmap.interop;

import com.azure.core.amqp.AmqpRetryOptions;
import com.azure.messaging.servicebus.ServiceBusClientBuilder;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.rabbitmq.client.ConnectionFactory;
import io.github.quyvu01.jfxmap.FxMap;
import io.github.quyvu01.jfxmap.RequestClient;
import io.github.quyvu01.jfxmap.RequestServer;
import io.github.quyvu01.jfxmap.azure.servicebus.ServiceBusRequestClient;
import io.github.quyvu01.jfxmap.azure.servicebus.ServiceBusServer;
import io.github.quyvu01.jfxmap.fluent.EntityConfigureOf;
import io.github.quyvu01.jfxmap.fluent.ProfileOf;
import io.github.quyvu01.jfxmap.kafka.KafkaRequestClient;
import io.github.quyvu01.jfxmap.kafka.KafkaServer;
import io.github.quyvu01.jfxmap.nats.NatsRequestClient;
import io.github.quyvu01.jfxmap.nats.NatsServer;
import io.github.quyvu01.jfxmap.opentelemetry.JfxMapTelemetry;
import io.github.quyvu01.jfxmap.provider.InMemoryQueryHandler;
import io.github.quyvu01.jfxmap.provider.QueryHandler;
import io.github.quyvu01.jfxmap.rabbitmq.RabbitMqRequestClient;
import io.github.quyvu01.jfxmap.rabbitmq.RabbitMqServer;
import io.github.quyvu01.jfxmap.sqs.SqsRequestClient;
import io.github.quyvu01.jfxmap.sqs.SqsServer;
import io.nats.client.Nats;
import io.opentelemetry.context.Context;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.SpanProcessor;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.sqs.SqsClient;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;

/**
 * A Java service on jfxmap, the counterpart of dotnet-probe:
 *
 * <pre>
 * java-probe owner|consumer nats|rabbitmq|kafka|sqs|servicebus &lt;address&gt; [trace]
 * </pre>
 * <p>
 * The address of rabbitmq is host:port, that of sqs the endpoint, that of servicebus the connection string of the
 * emulator.
 * <ul>
 * <li>owner: owns the string key UserOf (users 1 Alice, 2 Bob) and answers over the transport until it is stopped</li>
 * <li>consumer: maps the orders of users 1, 2 and 3 over the transport and prints them as JSON</li>
 * <li>trace: records the spans of jfxmap-opentelemetry and prints each one as it ends:
 * SPAN &lt;name&gt; &lt;trace id&gt; &lt;span id&gt; &lt;parent span id&gt;</li>
 * </ul>
 */
public final class JavaProbe {
    private JavaProbe() {
    }

    public record User(int id, String name, String email) {
    }

    public static final class UserConfig extends EntityConfigureOf<User> {
        @Override
        protected void configure() {
            id(User::id);
            defaultProperty(User::name);
            useDistributedKey("UserOf");
            exposedName(User::email, "UserEmail");
        }
    }

    public static final class OrderView {
        private int userId;
        private String userName;
        private String userEmail;

        public OrderView() {
        }

        OrderView(int userId) {
            this.userId = userId;
        }

        public int getUserId() {
            return userId;
        }

        public String getUserName() {
            return userName;
        }

        public void setUserName(String userName) {
            this.userName = userName;
        }

        public String getUserEmail() {
            return userEmail;
        }

        public void setUserEmail(String userEmail) {
            this.userEmail = userEmail;
        }
    }

    public static final class OrderViewProfile extends ProfileOf<OrderView> {
        @Override
        protected void configure() {
            useDistributedKey("UserOf").of(OrderView::getUserId)
                    .map(OrderView::getUserName)
                    .map(OrderView::getUserEmail, "UserEmail");
        }
    }

    public static void main(String[] args) throws Exception {
        var role = args[0];
        var transport = args[1];
        var address = args[2];
        var sdk = args.length > 3 && args[3].equals("trace") ? tracing() : null;
        var telemetry = sdk == null ? null : JfxMapTelemetry.create(sdk);
        var closeables = new ArrayList<AutoCloseable>();
        if (sdk != null) closeables.add(sdk);
        try {
            if (role.equals("owner")) {
                QueryHandler users = new InMemoryQueryHandler<>(new UserConfig(),
                        List.of(new User(1, "Alice", "alice@java"), new User(2, "Bob", "bob@java")));
                if (telemetry != null) users = telemetry.instrument(users);
                var server = server(transport, address, users, closeables);
                closeables.add(server);
                server.start();
                var stopped = new CountDownLatch(1);
                Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                    closeAll(closeables);
                    stopped.countDown();
                }));
                System.out.println("READY");
                stopped.await();
                return;
            }
            var client = client(transport, address, closeables);
            if (telemetry != null) client = telemetry.instrument(client);
            var mapper = FxMap.builder().addProfiles(new OrderViewProfile()).requestClient(client).throwIfException()
                    .build();
            var orders = List.of(new OrderView(1), new OrderView(2), new OrderView(3));
            int exit;
            try {
                mapper.map(orders, Map.of("x-probe", "java"));
                System.out.println("RESULT " + new ObjectMapper().writeValueAsString(orders));
                exit = 0;
            } catch (RuntimeException e) {
                System.out.println("FAILED " + e);
                exit = 1;
            }
            closeAll(closeables);
            System.out.flush();
            System.exit(exit);
        } catch (Exception e) {
            closeAll(closeables);
            throw e;
        }
    }

    private static RequestServer server(String transport, String address, QueryHandler users,
                                        List<AutoCloseable> closeables) throws Exception {
        var handlers = List.of(users);
        return switch (transport) {
            case "nats" -> {
                var connection = Nats.connect(address);
                closeables.add(connection);
                yield NatsServer.builder(connection, handlers).build();
            }
            case "rabbitmq" -> {
                var connection = rabbitConnection(address);
                closeables.add(connection);
                yield RabbitMqServer.builder(connection, "JavaUserService", handlers).build();
            }
            case "kafka" -> KafkaServer.builder(address, handlers).build();
            case "sqs" -> {
                var sqs = sqs(address);
                closeables.add(sqs);
                yield SqsServer.builder(sqs, handlers).waitTime(Duration.ofSeconds(1)).build();
            }
            case "servicebus" -> ServiceBusServer.builder(serviceBus(address), handlers).build();
            default -> throw new IllegalArgumentException(transport);
        };
    }

    private static RequestClient client(String transport, String address, List<AutoCloseable> closeables)
            throws Exception {
        return switch (transport) {
            case "nats" -> {
                var connection = Nats.connect(address);
                closeables.add(connection);
                yield NatsRequestClient.builder(connection).timeout(Duration.ofSeconds(30)).build();
            }
            case "rabbitmq" -> {
                var connection = rabbitConnection(address);
                closeables.add(connection);
                var client = RabbitMqRequestClient.builder(connection).timeout(Duration.ofSeconds(30)).build();
                closeables.add(client);
                yield client;
            }
            case "kafka" -> {
                var client = KafkaRequestClient.builder(address, "JavaOrderService").timeout(Duration.ofSeconds(60))
                        .build();
                closeables.add(client);
                yield client;
            }
            case "sqs" -> {
                var sqs = sqs(address);
                closeables.add(sqs);
                var client = SqsRequestClient.builder(sqs).timeout(Duration.ofSeconds(30))
                        .waitTime(Duration.ofSeconds(1)).build();
                closeables.add(client);
                yield client;
            }
            case "servicebus" -> {
                var client = ServiceBusRequestClient.builder(serviceBus(address)).timeout(Duration.ofSeconds(60))
                        .build();
                closeables.add(client);
                yield client;
            }
            default -> throw new IllegalArgumentException(transport);
        };
    }

    private static com.rabbitmq.client.Connection rabbitConnection(String address) throws Exception {
        var parts = address.split(":");
        var factory = new ConnectionFactory();
        factory.setHost(parts[0]);
        factory.setPort(Integer.parseInt(parts[1]));
        return factory.newConnection();
    }

    private static SqsClient sqs(String endpoint) {
        return SqsClient.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.US_EAST_1)
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("test", "test")))
                .build();
    }

    // The emulator answers a wait for the next session only when it times out: a short one picks up new sessions
    private static ServiceBusClientBuilder serviceBus(String connectionString) {
        return new ServiceBusClientBuilder().connectionString(connectionString)
                .retryOptions(new AmqpRetryOptions().setTryTimeout(Duration.ofSeconds(3)));
    }

    private static OpenTelemetrySdk tracing() {
        var printer = new SpanProcessor() {
            @Override
            public void onStart(Context parentContext, ReadWriteSpan span) {
            }

            @Override
            public boolean isStartRequired() {
                return false;
            }

            @Override
            public void onEnd(ReadableSpan span) {
                var data = span.toSpanData();
                System.out.println("SPAN " + data.getName() + " " + data.getTraceId() + " " + data.getSpanId() + " "
                        + data.getParentSpanId());
            }

            @Override
            public boolean isEndRequired() {
                return true;
            }
        };
        return OpenTelemetrySdk.builder()
                .setTracerProvider(SdkTracerProvider.builder().addSpanProcessor(printer).build())
                .build();
    }

    // In the reverse order of their creation: the clients and servers before their connections
    private static void closeAll(List<AutoCloseable> closeables) {
        for (var closeable : closeables.reversed()) {
            try {
                closeable.close();
            } catch (Exception e) {
                System.out.println("CLOSE FAILED " + e);
            }
        }
        closeables.clear();
    }
}
