import { randomUUID } from 'node:crypto';
import { DotNetKeyNames } from 'nfxmap';

// SQS: up to 80 letters, digits, dashes and underscores
const MAX_QUEUE_NAME = 80;

/**
 * The names FxMap 5.1.1 gives on Amazon SQS: one request queue per key, `fxmap-<namespace>-<name>` with the dots turned
 * into dashes, in lower case (`fxmap--userof` for the string key `UserOf`), and a response queue per client,
 * `fxmap-response-<machine name>-<uuid>`.
 */
export const SqsNames = {
    RESPONSE_QUEUE_PREFIX: 'fxmap-response',
    /** The message attribute that carries the correlation id of a request and of its reply. */
    CORRELATION_ID: 'CorrelationId',
    /** The message attribute that carries the URL of the response queue of a request. */
    REPLY_TO: 'ReplyTo',
    /** The message attribute that carries the assembly-qualified name of the key of a request. */
    TYPE: 'Type',

    /** The request queue of a key, which its owner creates and reads. */
    queue(key: string): string {
        return `FxMap-${DotNetKeyNames.namespace(key)}-${DotNetKeyNames.name(key)}`.replaceAll('.', '-').toLowerCase();
    },

    /**
     * A new response queue for a client on a machine. The characters that SQS refuses in a name are dropped from the
     * machine name, which is shortened to keep the name within 80 characters.
     */
    responseQueue(machineName: string): string {
        let machine = (machineName ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const suffix = `-${randomUUID()}`;
        const room = MAX_QUEUE_NAME - SqsNames.RESPONSE_QUEUE_PREFIX.length - 1 - suffix.length;
        if (machine.length > room) machine = machine.slice(0, room);
        return `${SqsNames.RESPONSE_QUEUE_PREFIX}-${machine}${suffix}`;
    },
} as const;
