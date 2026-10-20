import { DotNetKeyNames } from 'nfxmap';

const EXCHANGE_PREFIX = 'FxMap-';

/**
 * The names FxMap 5.1.1 gives on RabbitMQ: one direct exchange per key, `FxMap-<namespace>:<name>` (`FxMap-:UserOf`
 * for the string key `UserOf`), bound with the routing key {@link RabbitMqNames.ROUTING_KEY} to the queue of the owning
 * service, `fxmap-rpc-queue-<application name in lower case>`.
 */
export const RabbitMqNames = {
    /** The routing key of every request, spelled as FxMap spells it. */
    ROUTING_KEY: 'fxmap-rpc-rounting-key',
    QUEUE_PREFIX: 'fxmap-rpc-queue',
    REPLY_QUEUE_PREFIX: 'fxmap-reply',

    exchange(key: string): string {
        return `${EXCHANGE_PREFIX}${DotNetKeyNames.namespace(key)}:${DotNetKeyNames.name(key)}`;
    },

    /** The key of an exchange name, or `null` when it is not one of FxMap. */
    keyOfExchange(exchange: string | null | undefined): string | null {
        if (exchange === null || exchange === undefined || !exchange.startsWith(EXCHANGE_PREFIX)) return null;
        const rest = exchange.slice(EXCHANGE_PREFIX.length);
        const colon = rest.lastIndexOf(':');
        if (colon < 0 || colon === rest.length - 1) return null;
        const namespace = rest.slice(0, colon);
        const name = rest.slice(colon + 1);
        return namespace.length === 0 ? name : `${namespace}.${name}`;
    },

    /**
     * The queue of a service, from its name (FxMap uses the name of the entry assembly).
     *
     * @throws RangeError when the name is blank
     */
    queue(applicationName: string): string {
        if (typeof applicationName !== 'string' || applicationName.trim().length === 0)
            throw new RangeError('The application name is blank: it names the queue of the service.');
        return `${RabbitMqNames.QUEUE_PREFIX}-${applicationName.toLowerCase()}`;
    },
} as const;

/** The headers of a mapping call, as AMQP headers: strings, without the missing values. */
export function toAmqpHeaders(headers: Readonly<Record<string, string | null | undefined>>): Record<string, string> {
    const amqp: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) if (value !== null && value !== undefined) amqp[name] = value;
    return amqp;
}

/** The received AMQP headers as strings: a long string may come as text or as bytes. */
export function fromAmqpHeaders(amqp: Record<string, unknown> | null | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (amqp === null || amqp === undefined) return headers;
    for (const [name, value] of Object.entries(amqp)) {
        if (value === null || value === undefined) continue;
        headers[name] = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : String(value);
    }
    return headers;
}
