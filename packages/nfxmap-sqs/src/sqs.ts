import {
    DeleteMessageBatchCommand,
    type Message,
    type MessageAttributeValue,
    ReceiveMessageCommand,
    type SQSClient,
} from '@aws-sdk/client-sqs';

/** FxMap's `DefaultWaitTimeSeconds`: the longest that SQS allows. */
export const DEFAULT_WAIT_TIME_SECONDS = 20;
const MAX_MESSAGES = 10;
// How long a loop waits after a failed poll before polling again
const PAUSE_MS = 1_000;

// What the client and the server share: long polling, deleting the received messages, string attributes

export async function receive(sqs: SQSClient, queueUrl: string, waitTimeSeconds: number,
                              signal: AbortSignal): Promise<Message[]> {
    const response = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: MAX_MESSAGES,
        WaitTimeSeconds: waitTimeSeconds,
        MessageAttributeNames: ['All'],
    }), { abortSignal: signal });
    return response.Messages ?? [];
}

export async function deleteAll(sqs: SQSClient, queueUrl: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return;
    await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: messages.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
    }));
}

export function stringAttribute(value: string): MessageAttributeValue {
    return { DataType: 'String', StringValue: value };
}

/** The string value of an attribute, or `null`. */
export function attribute(message: Message, name: string): string | null {
    return message.MessageAttributes?.[name]?.StringValue ?? null;
}

/** Every attribute of a message as a string: what an FxMap server gives to the handler as headers. */
export function sqsHeaders(message: Message): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(message.MessageAttributes ?? {}))
        if (typeof value?.StringValue === 'string') headers[name] = value.StringValue;
    return headers;
}

/**
 * Whether a header can travel as a message attribute: SQS refuses a name that is not made of letters, digits, `_`,
 * `-` and `.`, that starts or ends with a dot, holds two dots in a row, or starts with `AWS.` or `Amazon.`.
 */
export function isAttributeName(name: string): boolean {
    return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(name) && !name.endsWith('.') && !name.includes('..')
        && !/^(aws|amazon)\./i.test(name);
}

/** Whether SQS answered that the queue does not exist. */
export function isQueueDoesNotExist(error: unknown): boolean {
    const failure = error as { name?: unknown; Code?: unknown } | null;
    return failure?.name === 'QueueDoesNotExist' || failure?.name === 'AWS.SimpleQueueService.NonExistentQueue'
        || failure?.Code === 'AWS.SimpleQueueService.NonExistentQueue';
}

export function isAbort(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || (error as { name?: unknown } | null)?.name === 'AbortError';
}

/** Waits after a failed poll; ends at once when the loop is stopped. */
export function pause(signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        if (signal.aborted) return resolve();
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, PAUSE_MS);
        signal.addEventListener('abort', done, { once: true });
    });
}

export function checkWaitTime(waitTimeSeconds: number): number {
    if (!Number.isInteger(waitTimeSeconds) || waitTimeSeconds < 0 || waitTimeSeconds > DEFAULT_WAIT_TIME_SECONDS)
        throw new RangeError('The wait time must be a whole number of seconds, between 0 and 20.');
    return waitTimeSeconds;
}

export function checkTimeout(timeoutMs: number): number {
    if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
    return timeoutMs;
}
