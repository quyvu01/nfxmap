import type { Kafka } from 'kafkajs';
import { describe, expect, it } from 'vitest';
import { createTopics, isUnknownTopic } from '../src/topics.js';

const unknownTopic = () => Object.assign(new Error('This server does not host this topic-partition'),
    { type: 'UNKNOWN_TOPIC_OR_PARTITION' });

function kafkaWith(admin: Record<string, unknown>): Kafka {
    return { admin: () => ({ connect: async () => undefined, disconnect: async () => undefined, ...admin }) } as unknown as Kafka;
}

describe('createTopics', () => {
    it('waits for the leaders itself when the broker does not know the new topic yet', async () => {
        let fetches = 0;
        const kafka = kafkaWith({
            createTopics: async () => {
                throw unknownTopic();
            },
            fetchTopicMetadata: async () => {
                if (++fetches === 1) throw unknownTopic();
                if (fetches === 2) return { topics: [{ name: 't', partitions: [{ partitionId: 0, leader: -1 }] }] };
                return { topics: [{ name: 't', partitions: [{ partitionId: 0, leader: 1 }] }] };
            },
        });

        await createTopics(kafka, ['t'], 1, 1);

        expect(fetches).toBe(3);
    });

    it('lets other failures through', async () => {
        const kafka = kafkaWith({
            createTopics: async () => {
                throw new Error('not authorized');
            },
        });

        await expect(createTopics(kafka, ['t'], 1, 1)).rejects.toThrow('not authorized');
    });

    it('knows the error of an unknown topic, also wrapped by the retries of kafkajs', () => {
        expect(isUnknownTopic(unknownTopic())).toBe(true);
        expect(isUnknownTopic({ name: 'KafkaJSNumberOfRetriesExceeded', originalError: unknownTopic() })).toBe(true);
        expect(isUnknownTopic(new Error('other'))).toBe(false);
        expect(isUnknownTopic(null)).toBe(false);
    });
});
