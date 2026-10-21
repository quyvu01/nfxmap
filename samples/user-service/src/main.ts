import { startUserService } from './app.js';

// PORT and GRPC_PORT change the ports (8081 and 9091)
const service = await startUserService({
    httpPort: Number(process.env.PORT ?? 8081),
    grpcPort: Number(process.env.GRPC_PORT ?? 9091),
});
console.log(`user-service: GET http://localhost:${service.httpPort}/users, UserOf on gRPC port ${service.grpcPort}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void service.close().then(() => process.exit(0));
    });
}
