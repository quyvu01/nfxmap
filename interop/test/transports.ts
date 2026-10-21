import { DeleteQueueCommand, GetQueueUrlCommand, QueueDoesNotExist, SQSClient } from '@aws-sdk/client-sqs';
import { ServiceBusClient } from '@azure/service-bus';
import { connect as connectNats } from '@nats-io/transport-node';
import { connect as connectRabbitMq } from 'amqplib';
import { Kafka, logLevel } from 'kafkajs';
import type { QueryHandler, RequestClient } from 'nfxmap';
import { ServiceBusRequestClient, ServiceBusServer } from 'nfxmap-azure-servicebus';
import { KafkaRequestClient, KafkaServer } from 'nfxmap-kafka';
import { NatsRequestClient, NatsServer } from 'nfxmap-nats';
import { RabbitMqNames, RabbitMqRequestClient, RabbitMqServer } from 'nfxmap-rabbitmq';
import { SqsRequestClient, SqsServer } from 'nfxmap-sqs';

/** Something to close once a test is over. */
export type Close = () => Promise<unknown>;

/** A transport of the tests, from the address of its broker in the environment, as the probes and nfxmap reach it. */
export interface Transport {
    readonly name: string;
    /** The address given to the probes. */
    readonly address: string;
    /** Whether the trace context crosses it. */
    readonly carriesTrace: boolean;
    client(): Promise<{ readonly client: RequestClient; readonly close: Close }>;
    serve(handler: QueryHandler): Promise<Close>;
    /** Leaves nothing of an earlier test that the next one could receive. */
    reset?(): Promise<void>;
}

const silentLogger = { error: () => undefined };

/** The transports whose broker is set: `NATS_URL`, `RABBITMQ_URL`, `KAFKA_BROKERS`, `SQS_ENDPOINT`, `SERVICEBUS_CONNECTION_STRING`. */
export function transports(): Transport[] {
    const found: Transport[] = [];
    const { NATS_URL, RABBITMQ_URL, KAFKA_BROKERS, SQS_ENDPOINT, SERVICEBUS_CONNECTION_STRING } = process.env;

    if (NATS_URL) found.push({
        name: 'nats',
        address: NATS_URL,
        carriesTrace: true,
        async client() {
            const connection = await connectNats({ servers: NATS_URL });
            return { client: new NatsRequestClient(connection), close: () => connection.close() };
        },
        async serve(handler) {
            const connection = await connectNats({ servers: NATS_URL });
            const server = new NatsServer(connection, [handler], { logger: silentLogger });
            await server.start();
            await connection.flush();
            return async () => {
                await server.close();
                await connection.close();
            };
        },
    });

    if (RABBITMQ_URL) {
        const url = new URL(RABBITMQ_URL);
        found.push({
            name: 'rabbitmq',
            address: `${url.hostname}:${url.port || 5672}`,
            carriesTrace: true,
            async client() {
                const connection = await connectRabbitMq(RABBITMQ_URL);
                const client = new RabbitMqRequestClient(connection, { timeoutMs: 30_000 });
                return {
                    client,
                    close: async () => {
                        await client.close();
                        await connection.close();
                    },
                };
            },
            // The queue of each owner outlives it, still bound to the exchange of UserOf: a request of a later test
            // would also land there, and wait for the next owner of that queue
            async reset() {
                const connection = await connectRabbitMq(RABBITMQ_URL);
                try {
                    const channel = await connection.createChannel();
                    for (const application of ['NodeUserService', 'JavaUserService', 'DotnetProbe'])
                        await channel.deleteQueue(RabbitMqNames.queue(application));
                } finally {
                    await connection.close();
                }
            },
            async serve(handler) {
                const connection = await connectRabbitMq(RABBITMQ_URL);
                const server = new RabbitMqServer(connection, 'NodeUserService', [handler], { logger: silentLogger });
                await server.start();
                return async () => {
                    await server.close();
                    await connection.close();
                };
            },
        });
    }

    if (KAFKA_BROKERS) {
        const kafka = new Kafka({ clientId: 'nfxmap-interop', brokers: KAFKA_BROKERS.split(','), logLevel: logLevel.NOTHING });
        found.push({
            name: 'kafka',
            address: KAFKA_BROKERS,
            carriesTrace: true,
            async client() {
                const client = new KafkaRequestClient(kafka, 'NodeOrderService', { timeoutMs: 60_000 });
                return { client, close: () => client.close() };
            },
            async serve(handler) {
                const server = new KafkaServer(kafka, [handler], { logger: silentLogger });
                await server.start();
                return () => server.close();
            },
        });
    }

    if (SQS_ENDPOINT) {
        const sqs = new SQSClient({
            endpoint: SQS_ENDPOINT,
            region: 'us-east-1',
            credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        });
        found.push({
            name: 'sqs',
            address: SQS_ENDPOINT,
            carriesTrace: true,
            async client() {
                const client = new SqsRequestClient(sqs, { timeoutMs: 30_000, waitTimeSeconds: 1, logger: silentLogger });
                return { client, close: () => client.close() };
            },
            async serve(handler) {
                // A long poll of an owner stopped by an earlier test can still take the next request, which would then
                // wait out its visibility timeout: the queue of UserOf starts anew
                try {
                    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'fxmap--userof' }));
                    await sqs.send(new DeleteQueueCommand({ QueueUrl }));
                } catch (error) {
                    if (!(error instanceof QueueDoesNotExist)) throw error;
                }
                const server = new SqsServer(sqs, [handler], { waitTimeSeconds: 1, logger: silentLogger });
                await server.start();
                return () => server.close();
            },
        });
    }

    if (SERVICEBUS_CONNECTION_STRING) {
        // The emulator answers a wait for the next session only when it times out: a short one picks up new sessions
        const serviceBus = () => new ServiceBusClient(SERVICEBUS_CONNECTION_STRING,
            { retryOptions: { timeoutInMs: 3_000 } });
        found.push({
            name: 'servicebus',
            address: SERVICEBUS_CONNECTION_STRING,
            // FxMap sends the trace context in bytes, which Service Bus refuses: nfxmap and jfxmap leave it out
            carriesTrace: false,
            async client() {
                const sb = serviceBus();
                const client = new ServiceBusRequestClient(sb, { timeoutMs: 60_000, logger: silentLogger });
                return {
                    client,
                    close: async () => {
                        await client.close();
                        await sb.close();
                    },
                };
            },
            async serve(handler) {
                const sb = serviceBus();
                const server = new ServiceBusServer(sb, [handler], { logger: silentLogger });
                await server.start();
                return async () => {
                    await server.close();
                    await sb.close();
                };
            },
        });
    }
    return found;
}
