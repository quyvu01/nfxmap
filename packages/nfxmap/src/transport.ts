import type { MapContext } from './context.js';
import type { ItemsResponse, MapRequest } from './responses.js';

/**
 * Sends a {@link MapRequest} to the service that owns a distributed key. This is what a transport implements
 * (NATS, gRPC, Kafka...); {@link LocalRequestClient} answers in the same process.
 */
export interface RequestClient {
    request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse>;

    /**
     * The name of the transport, as FxMap names it in its telemetry (`nats`, `rabbitmq`, `kafka`, `grpc`, `sqs`,
     * `azureservicebus`); `custom` when it does not say.
     */
    readonly transport?: string;
}

/**
 * Answers the requests for one distributed key, on the service that owns the entity (FxMap's `IQueryOfHandler`). A
 * data provider implements it; {@link InMemoryQueryHandler} answers from objects in memory.
 */
export interface QueryHandler {
    readonly key: string;
    /** The name of the entity, for messages. */
    readonly entityName: string;

    handle(request: MapRequest, context: MapContext): Promise<ItemsResponse>;

    /** The database the entities are read from, as FxMap names it in its telemetry, when there is one. */
    readonly dbSystem?: string;
}

/**
 * Answers the requests for the keys a service owns over a transport (FxMap's `IRequestServer`): the NATS, RabbitMQ,
 * Kafka, SQS and Service Bus servers.
 */
export interface RequestServer {
    /**
     * Starts answering; does nothing when the server already runs.
     *
     * @throws Error when the server cannot start (the broker cannot be reached, a queue cannot be declared)
     */
    start(): Promise<void>;

    isRunning(): boolean;

    /**
     * The end of the current run: resolved when {@link close} stops it, rejected with the cause when the server stops on
     * its own because of a failure (its connection closed, its consumer was cancelled...). Already resolved when the
     * server does not run. A failed server can be started again.
     */
    whenStopped(): Promise<void>;

    /** Stops answering; does nothing when the server does not run. The requests being answered still get their reply. */
    close(): Promise<void>;
}
