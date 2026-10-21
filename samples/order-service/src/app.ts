import { createServer, type Server, type ServerResponse } from 'node:http';
import { createDistributedMapper, validateOrThrow } from 'nfxmap';
import { GrpcRequestClient } from 'nfxmap-grpc';
import { OrderResponse, OrderResponseProfile } from './order-response.js';
import { SAMPLE_ORDERS } from './orders.js';

export interface OrderServiceOptions {
    /** The port of GET /orders (8082 by default; 0 for a free one). */
    readonly httpPort?: number;
    /** Where the owners of the keys it maps are: the gRPC server of the user service (`http://localhost:9091`). */
    readonly userService?: string;
}

export interface OrderService {
    readonly httpPort: number;
    close(): Promise<void>;
}

/**
 * The order service: GET /orders and GET /orders/:id show its orders with the fields of their users, which nfxmap
 * reads from the user service over gRPC, all the orders of a response in one call.
 */
export async function startOrderService(options: OrderServiceOptions = {}): Promise<OrderService> {
    const profiles = [new OrderResponseProfile()];
    // An invalid expression in a profile fails here, not on the first request
    validateOrThrow({ profiles });
    const client = new GrpcRequestClient({ hosts: [options.userService ?? 'http://localhost:9091'] });
    const mapper = createDistributedMapper({ profiles, requestClient: client, throwIfException: true });

    const http = createServer((request, response) => {
        const one = /^\/orders\/(\d+)$/.exec(request.url ?? '');
        if (request.method !== 'GET' || (request.url !== '/orders' && one === null)) {
            send(response, 404, { error: 'Not found' });
            return;
        }
        const orders = SAMPLE_ORDERS.filter(order => one === null || order.id === Number(one[1]))
            .map(order => new OrderResponse(order));
        if (one !== null && orders.length === 0) {
            send(response, 404, { error: 'Not found' });
            return;
        }
        mapper.map(orders).then(() => send(response, 200, one === null ? orders : orders[0]),
            (error: unknown) => send(response, 502, { error: error instanceof Error ? error.message : String(error) }));
    });
    const httpPort = await listen(http, options.httpPort ?? 8082);

    return {
        httpPort,
        async close() {
            await new Promise<void>(resolve => http.close(() => resolve()));
            client.close();
        },
    };
}

function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            const address = server.address();
            resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
    });
}
