import type { Admin, Kafka } from 'kafkajs';

// How long, and how often, the leaders of new topics are waited for when kafkajs gives up on them
const LEADER_WAIT_ATTEMPTS = 50;
const LEADER_WAIT_DELAY_MS = 200;

/** Creates topics, as FxMap does: a topic that already exists is left as it is. */
export async function createTopics(kafka: Kafka, topics: readonly string[], partitions: number,
                                   replicationFactor: number): Promise<void> {
    const admin = kafka.admin();
    await admin.connect();
    try {
        try {
            await admin.createTopics({
                waitForLeaders: true,
                topics: topics.map(topic => ({ topic, numPartitions: partitions, replicationFactor })),
            });
        } catch (error) {
            // Right after its creation, a broker may not know the topic yet: kafkajs stops waiting for its leaders
            if (!isUnknownTopic(error)) throw error;
            await waitForLeaders(admin, topics);
        }
    } finally {
        await admin.disconnect();
    }
}

export async function topicExists(kafka: Kafka, topic: string): Promise<boolean> {
    const admin = kafka.admin();
    await admin.connect();
    try {
        return (await admin.listTopics()).includes(topic);
    } finally {
        await admin.disconnect();
    }
}

async function waitForLeaders(admin: Admin, topics: readonly string[]): Promise<void> {
    let failure: unknown = null;
    for (let attempt = 0; attempt < LEADER_WAIT_ATTEMPTS; attempt++) {
        try {
            const { topics: metadata } = await admin.fetchTopicMetadata({ topics: [...topics] });
            if (metadata.every(topic => topic.partitions.length > 0
                && topic.partitions.every(partition => partition.leader >= 0))) return;
        } catch (error) {
            if (!isUnknownTopic(error)) throw error;
            failure = error;
        }
        await new Promise(resolve => setTimeout(resolve, LEADER_WAIT_DELAY_MS));
    }
    throw failure ?? new Error(`The topics ${topics.join(', ')} have no leader.`);
}

/** Whether Kafka answered that it does not host the topic (`UNKNOWN_TOPIC_OR_PARTITION`), maybe after retries. */
export function isUnknownTopic(error: unknown): boolean {
    for (let current = error as { type?: unknown; originalError?: unknown; cause?: unknown } | null, depth = 0;
         current && depth < 5; depth++) {
        if (current.type === 'UNKNOWN_TOPIC_OR_PARTITION') return true;
        current = (current.originalError ?? current.cause) as typeof current;
    }
    return false;
}
