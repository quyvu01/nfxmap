import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
    CreateQueueCommand,
    DeleteQueueCommand,
    GetQueueUrlCommand,
    type MessageAttributeValue,
    SendMessageCommand,
    type SQSClient,
} from '@aws-sdk/client-sqs';
import {
    DEFAULT_REQUEST_TIMEOUT_MS,
    DotNetKeyNames,
    type ErrorLogger,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    PendingReplies,
    type RequestClient,
    WireMessages,
} from 'nfxmap';
import { SqsNames } from './names.js';
import {
    attribute,
    checkTimeout,
    checkWaitTime,
    DEFAULT_WAIT_TIME_SECONDS,
    deleteAll,
    isAbort,
    isAttributeName,
    isQueueDoesNotExist,
    pause,
    receive,
    stringAttribute,
} from './sqs.js';

export interface SqsRequestClientOptions {
    /** How long a request may wait for its reply, in milliseconds (default 30 seconds, FxMap's DefaultRequestTimeout). */
    readonly timeoutMs?: number;
    /** How long a poll of the response queue waits for messages, in seconds (0 to 20, 20 by default). */
    readonly waitTimeSeconds?: number;
    /** The machine name in the name of the response queue; the host name by default, as FxMap does. */
    readonly machineName?: string;
    /** Where the failed polls of the response queue are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * Sends requests over Amazon SQS (FxMap's SqsRequestClient and `AddSqs`): each request is sent to the queue of its key
 * ({@link SqsNames.queue}) with the attributes `CorrelationId`, `ReplyTo` (the URL of the response queue of this
 * client), `Type` (the assembly-qualified name of the key) and the headers of the mapping call. The owner replies on
 * the response queue, `fxmap-response-<machine>-<uuid>`, which this client creates on its first request (messages kept
 * 5 minutes) and deletes when it closes.
 *
 * A key whose queue does not exist (no service owns it) fails at once. The SQS client belongs to the caller.
 *
 * ```ts
 * const client = new SqsRequestClient(new SQSClient({ region: 'us-east-1' }));
 * ```
 */
export class SqsRequestClient implements RequestClient {
    readonly transport = 'sqs';
    readonly timeoutMs: number;
    readonly waitTimeSeconds: number;
    private readonly machineName: string;
    private readonly logger: ErrorLogger;
    private readonly pending = new PendingReplies();
    private readonly queueUrls = new Map<string, string>();
    private readonly polling = new AbortController();
    private responseQueueCreation: Promise<string> | null = null;
    private receiving: Promise<void> = Promise.resolve();
    private closed = false;

    constructor(private readonly sqs: SQSClient, options: SqsRequestClientOptions = {}) {
        if (sqs === null || sqs === undefined) throw new TypeError('The SQS client is required.');
        this.timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
        this.waitTimeSeconds = checkWaitTime(options.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS);
        this.machineName = options.machineName ?? hostname();
        this.logger = options.logger ?? console;
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        this.ensureOpen();
        const replyTo = await this.ensureResponseQueue();
        const queueUrl = await this.queueUrl(key);
        this.ensureOpen();

        const correlationId = randomUUID();
        const attributes: Record<string, MessageAttributeValue> = {
            [SqsNames.CORRELATION_ID]: stringAttribute(correlationId),
            [SqsNames.REPLY_TO]: stringAttribute(replyTo),
            [SqsNames.TYPE]: stringAttribute(DotNetKeyNames.assemblyQualifiedName(key)),
        };
        for (const [name, value] of Object.entries(context.headers)) {
            // SQS refuses an attribute without a value, or with a name it does not allow
            if (value === null || value === undefined || value === '' || !isAttributeName(name)) continue;
            attributes[name] ??= stringAttribute(value);
        }
        const reply = this.pending.register(correlationId, key, this.timeoutMs);
        try {
            await this.sqs.send(new SendMessageCommand({
                QueueUrl: queueUrl,
                MessageBody: WireMessages.writeRequest(request).toString('utf8'),
                MessageAttributes: attributes,
            }));
        } catch (error) {
            if (isQueueDoesNotExist(error)) {
                // Deleted since it was found
                this.queueUrls.delete(SqsNames.queue(key));
                this.pending.fail(correlationId, new NoHandlerForDistributedKeyError(key));
            } else {
                this.pending.fail(correlationId, new Error(`The request for ${key} could not be sent to SQS.`,
                    { cause: error }));
            }
        }
        return WireMessages.readResult(await reply);
    }

    /** How many requests wait for their reply. */
    get pendingRequests(): number {
        return this.pending.size;
    }

    /** The URL of the response queue, once the first request created it. */
    async responseQueueUrl(): Promise<string | null> {
        return this.responseQueueCreation === null ? null : this.responseQueueCreation.catch(() => null);
    }

    /** Fails the requests that still wait, stops polling and deletes the response queue. */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.pending.failAll(new Error('The SQS request client is closed.'));
        this.polling.abort();
        await this.receiving;
        const url = await this.responseQueueUrl();
        if (url === null) return;
        try {
            await this.sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
        } catch (error) {
            this.logger.error(`The response queue ${url} was not deleted.`, error);
        }
    }

    private ensureOpen(): void {
        if (this.closed) throw new Error('The SQS request client is closed.');
    }

    private async queueUrl(key: string): Promise<string> {
        const name = SqsNames.queue(key);
        const known = this.queueUrls.get(name);
        if (known !== undefined) return known;
        try {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
            if (!QueueUrl) throw new NoHandlerForDistributedKeyError(key);
            this.queueUrls.set(name, QueueUrl);
            return QueueUrl;
        } catch (error) {
            if (isQueueDoesNotExist(error)) throw new NoHandlerForDistributedKeyError(key);
            throw error;
        }
    }

    private ensureResponseQueue(): Promise<string> {
        this.responseQueueCreation ??= this.createResponseQueue().catch(error => {
            // Created again on the next request
            this.responseQueueCreation = null;
            throw error;
        });
        return this.responseQueueCreation;
    }

    private async createResponseQueue(): Promise<string> {
        const { QueueUrl } = await this.sqs.send(new CreateQueueCommand({
            QueueName: SqsNames.responseQueue(this.machineName),
            Attributes: { MessageRetentionPeriod: '300', VisibilityTimeout: '30', ReceiveMessageWaitTimeSeconds: '20' },
        }));
        if (!QueueUrl) throw new Error('SQS created the response queue without a URL.');
        if (this.closed) {
            await this.sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => undefined);
            throw new Error('The SQS request client is closed.');
        }
        this.receiving = this.receiveReplies(QueueUrl);
        return QueueUrl;
    }

    private async receiveReplies(url: string): Promise<void> {
        const signal = this.polling.signal;
        while (!signal.aborted) {
            try {
                const messages = await receive(this.sqs, url, this.waitTimeSeconds, signal);
                for (const message of messages)
                    this.pending.complete(attribute(message, SqsNames.CORRELATION_ID), Buffer.from(message.Body ?? '', 'utf8'));
                await deleteAll(this.sqs, url, messages);
            } catch (error) {
                if (isAbort(error, signal)) return;
                this.logger.error(`The replies of ${url} could not be received.`, error);
                await pause(signal);
            }
        }
    }
}
