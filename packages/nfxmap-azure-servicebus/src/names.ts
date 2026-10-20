import { DotNetKeyNames } from 'nfxmap';

/**
 * The names FxMap 5.1.1 gives on Azure Service Bus: two queues per key, both requiring sessions, named
 * `fxmap-request-<namespace>-<name>` and `fxmap-reply-<namespace>-<name>` with the dots turned into dashes, in lower
 * case (`fxmap-request--userof` for the string key `UserOf`), after an optional prefix (`<prefix>-fxmap-request-...`,
 * FxMap's `TopicPrefix`).
 */
export const ServiceBusNames = {
    /** The queue the owner of a key reads its requests from. */
    requestQueue(key: string, prefix?: string | null): string {
        return name('fxmap-request', key, prefix);
    },

    /** The queue the clients of a key read their replies from, each in its own session. */
    replyQueue(key: string, prefix?: string | null): string {
        return name('fxmap-reply', key, prefix);
    },
} as const;

function name(kind: string, key: string, prefix: string | null | undefined): string {
    let queue = `${kind}-${DotNetKeyNames.namespace(key)}-${DotNetKeyNames.name(key)}`;
    if (prefix) queue = `${prefix}-${queue}`;
    return queue.replaceAll('.', '-').toLowerCase();
}
