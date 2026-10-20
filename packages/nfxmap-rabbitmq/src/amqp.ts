/**
 * The parts of an amqplib connection and channel that the transport uses. A connection of amqplib (`connect()`, from
 * the `amqplib` package, version 0.10 or later) is one; so is any client with the same promise API.
 */
export interface AmqpConnection {
    createChannel(): Promise<AmqpChannel>;
}

export interface AmqpChannel {
    assertQueue(queue: string, options?: {
        durable?: boolean;
        exclusive?: boolean;
        autoDelete?: boolean;
    }): Promise<{ queue: string }>;

    assertExchange(exchange: string, type: string, options?: { durable?: boolean; autoDelete?: boolean }): Promise<unknown>;

    checkExchange(exchange: string): Promise<unknown>;

    bindQueue(queue: string, source: string, pattern: string): Promise<unknown>;

    prefetch(count: number): Promise<unknown>;

    consume(queue: string, onMessage: (message: AmqpMessage | null) => void,
            options?: { noAck?: boolean }): Promise<{ consumerTag: string }>;

    cancel(consumerTag: string): Promise<unknown>;

    publish(exchange: string, routingKey: string, content: Buffer, options?: AmqpPublishOptions): boolean;

    ack(message: AmqpMessage): void;

    close(): Promise<void>;

    on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface AmqpPublishOptions {
    correlationId?: string;
    replyTo?: string;
    type?: string;
    headers?: Record<string, unknown>;
    mandatory?: boolean;
}

export interface AmqpMessage {
    content: Buffer;
    fields: { exchange: string; deliveryTag: number };
    properties: {
        correlationId?: string;
        replyTo?: string;
        type?: string;
        headers?: Record<string, unknown>;
    };
}

/** Whether an AMQP error is the 404 a broker answers for an exchange or a queue that does not exist. */
export function isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 404;
}
