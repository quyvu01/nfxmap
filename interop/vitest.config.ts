import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (name: string) => fileURLToPath(new URL(`../packages/${name}/src/index.ts`, import.meta.url));

// The tests run against the sources of the packages, not their builds. A probe can take minutes to start the first
// time (the .NET runtime, the JVM, the topics of Kafka)
export default defineConfig({
    resolve: {
        alias: {
            'nfxmap-nats': source('nfxmap-nats'),
            'nfxmap-rabbitmq': source('nfxmap-rabbitmq'),
            'nfxmap-kafka': source('nfxmap-kafka'),
            'nfxmap-sqs': source('nfxmap-sqs'),
            'nfxmap-azure-servicebus': source('nfxmap-azure-servicebus'),
            'nfxmap-opentelemetry': source('nfxmap-opentelemetry'),
            nfxmap: source('nfxmap'),
        },
    },
    test: {
        testTimeout: 300_000,
        hookTimeout: 60_000,
    },
});
