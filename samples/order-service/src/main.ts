import { startOrderService } from './app.js';

// PORT changes the port (8082), USER_SERVICE where the user service's gRPC server is (http://localhost:9091)
const service = await startOrderService({
    httpPort: Number(process.env.PORT ?? 8082),
    userService: process.env.USER_SERVICE ?? 'http://localhost:9091',
});
console.log(`order-service: GET http://localhost:${service.httpPort}/orders`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        void service.close().then(() => process.exit(0));
    });
}
