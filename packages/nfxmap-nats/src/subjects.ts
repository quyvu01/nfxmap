import { DotNetKeyNames, type DistributedKeyLike, keyName } from 'nfxmap';

/**
 * The NATS subject of a distributed key, as FxMap 5.1.1 names it: `fxmap-<namespace>-<name>` in lower case, after
 * `<prefix>-` when a topic prefix is set. A string key has an empty namespace, so `UserOf` is on `fxmap--userof`, and
 * a Node, .NET or Java service that uses the same key and prefix meet on the same subject.
 */
export const NatsSubjects = {
    of(key: DistributedKeyLike, topicPrefix?: string | null): string {
        const name = keyName(key);
        const subject = `fxmap-${DotNetKeyNames.namespace(name)}-${DotNetKeyNames.name(name)}`.toLowerCase();
        return topicPrefix ? `${topicPrefix.toLowerCase()}-${subject}` : subject;
    },
} as const;
