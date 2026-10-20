import { randomUUID } from 'node:crypto';
import { DotNetKeyNames, type MapRequest, WireMessages } from 'nfxmap';
import type { IHeaders } from 'kafkajs';

/**
 * The names FxMap 5.1.1 gives on Kafka: the request topic of a key, `fxmap-request-topic-<full name>` in lower case
 * (`fxmap-request-topic-userof` for the string key `UserOf`), read by the consumer group
 * {@link KafkaNames.SERVER_GROUP_ID}; and the reply topic of each client, `fxmap-response-topic-<application>-<uuid>`.
 */
export const KafkaNames = {
    REQUEST_TOPIC_PREFIX: 'fxmap-request-topic',
    RESPONSE_TOPIC_PREFIX: 'fxmap-response-topic',
    SERVER_GROUP_ID: 'fxmap-rpc-server-group',
    CLIENT_GROUP_PREFIX: 'fxmap-rpc-client-group',

    requestTopic(key: string): string {
        return `${KafkaNames.REQUEST_TOPIC_PREFIX}-${DotNetKeyNames.fullName(key)}`.toLowerCase();
    },

    /**
     * A new reply topic for a client of the application (FxMap uses the entry assembly's name).
     *
     * @throws RangeError when the name is blank
     */
    newResponseTopic(applicationName: string): string {
        if (typeof applicationName !== 'string' || applicationName.trim().length === 0)
            throw new RangeError('The application name is blank: it names the reply topic.');
        return `${KafkaNames.RESPONSE_TOPIC_PREFIX}-${applicationName.toLowerCase()}-${randomUUID().replaceAll('-', '')}`;
    },
} as const;

/**
 * The request of FxMap's Kafka transport wraps the request with the topic to reply on:
 * `{"Message":{"SelectorIds":[...],"Expressions":[...]},"ReplyTo":"fxmap-response-topic-..."}`. The headers of the
 * mapping call travel as Kafka headers, in UTF-8.
 */
export const KafkaMessages = {
    writeRequest(request: MapRequest, replyTo: string): Buffer {
        return Buffer.from(JSON.stringify({ Message: WireMessages.requestObject(request), ReplyTo: replyTo }));
    },

    /** @throws TypeError when the data is not a wrapped request */
    readRequest(data: Buffer | string): { request: MapRequest; replyTo: string | null } {
        const json = typeof data === 'string' ? data : data.toString('utf8');
        let node: unknown;
        try {
            node = JSON.parse(json);
        } catch (error) {
            throw new TypeError(`The request is not JSON: ${(error as Error).message}`, { cause: error });
        }
        if (node === null || typeof node !== 'object' || Array.isArray(node))
            throw new TypeError('The request is not a JSON object.');
        let replyTo: string | null = null;
        let message: unknown;
        for (const [name, value] of Object.entries(node)) {
            if (name.toLowerCase() === 'replyto' && value !== null && value !== undefined) replyTo = String(value);
            if (name.toLowerCase() === 'message') message = value;
        }
        if (message === null || typeof message !== 'object' || Array.isArray(message))
            throw new TypeError('The request has no Message.');
        return { request: WireMessages.readRequest(message as Record<string, unknown>), replyTo };
    },

    toKafkaHeaders(headers: Readonly<Record<string, string | null | undefined>>): Record<string, string> {
        const kafka: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) kafka[name] = value ?? '';
        return kafka;
    },

    /** The headers as strings; the first value of a repeated name wins. */
    fromKafkaHeaders(kafka: IHeaders | null | undefined): Record<string, string> {
        const headers: Record<string, string> = {};
        if (kafka === null || kafka === undefined) return headers;
        for (const [name, raw] of Object.entries(kafka)) {
            const value = Array.isArray(raw) ? raw[0] : raw;
            headers[name] = value === undefined || value === null ? '' : value.toString();
        }
        return headers;
    },
} as const;
