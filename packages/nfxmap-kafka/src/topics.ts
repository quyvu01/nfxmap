import type { Kafka } from 'kafkajs';

/** Creates topics, as FxMap does: a topic that already exists is left as it is. */
export async function createTopics(kafka: Kafka, topics: readonly string[], partitions: number,
                                   replicationFactor: number): Promise<void> {
    const admin = kafka.admin();
    await admin.connect();
    try {
        await admin.createTopics({
            waitForLeaders: true,
            topics: topics.map(topic => ({ topic, numPartitions: partitions, replicationFactor })),
        });
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
