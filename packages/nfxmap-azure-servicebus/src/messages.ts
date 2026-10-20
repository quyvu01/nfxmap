// What the client and the server share: the headers of a message and the errors of Service Bus

/** The longest a session stays locked by its receiver: as long as the receiver lives. */
export const SESSION_LOCK_RENEWAL_MS = 3650 * 24 * 60 * 60 * 1000;

/**
 * The application properties of a message, as strings: what an FxMap server gives to the handler as headers. FxMap
 * sends its trace context as bytes, read as UTF-8.
 */
export function serviceBusHeaders(properties: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> {
    const headers: Record<string, string> = {};
    if (properties === null || properties === undefined) return headers;
    for (const [name, value] of Object.entries(properties)) {
        if (value === null || value === undefined) continue;
        headers[name] = value instanceof Uint8Array ? Buffer.from(value).toString('utf8')
            : value instanceof Date ? value.toISOString() : String(value);
    }
    return headers;
}

/**
 * Whether a header can go as an application property. The W3C trace context (`traceparent`, `tracestate`) does not:
 * FxMap 5.1.1 sends and reads it as bytes, and a string would make an FxMap server fail on its cast to bytes. A trace
 * stops at Service Bus, as it does between two FxMap services.
 */
export function isSent(header: string): boolean {
    return header !== 'traceparent' && header !== 'tracestate';
}

/** The code of a Service Bus error (`MessagingEntityNotFound`, `ServiceTimeout`...), or `null`. */
export function errorCode(error: unknown): string | null {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : null;
}

/** Whether a failure says that a queue does not exist. */
export function isMissingEntity(error: unknown): boolean {
    return errorCode(error) === 'MessagingEntityNotFound';
}

/** The correlation id of a message as a string, or `null`. */
export function correlationIdOf(id: unknown): string | null {
    if (id === null || id === undefined) return null;
    return id instanceof Uint8Array ? Buffer.from(id).toString('utf8') : String(id);
}

/** The body of a received message as bytes; a body that is not bytes is sent again as JSON. */
export function bodyOf(body: unknown): Buffer {
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body === 'string') return Buffer.from(body, 'utf8');
    return Buffer.from(JSON.stringify(body ?? null), 'utf8');
}

export function checkTimeout(timeoutMs: number): number {
    if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
    return timeoutMs;
}
