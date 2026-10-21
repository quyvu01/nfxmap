import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Server as GrpcServer, ServerCredentials } from '@grpc/grpc-js';
import { FxMapGrpcService } from 'nfxmap-grpc';
import { TypeOrmQueryHandler } from 'nfxmap-typeorm';
import { DataSource } from 'typeorm';
import { Address, Country, User } from './entities.js';
import { seedUsers } from './sample-users.js';
import { UserConfig } from './user-config.js';

export interface UserServiceOptions {
    /** The port of GET /users (8081 by default; 0 for a free one). */
    readonly httpPort?: number;
    /** The port of the gRPC server that answers the key UserOf (9091 by default; 0 for a free one). */
    readonly grpcPort?: number;
}

export interface UserService {
    readonly httpPort: number;
    readonly grpcPort: number;
    close(): Promise<void>;
}

/**
 * The user service: its users in a SQLite database through TypeORM, the key UserOf answered from it on gRPC by
 * nfxmap-typeorm and nfxmap-grpc, and GET /users to see them.
 */
export async function startUserService(options: UserServiceOptions = {}): Promise<UserService> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [User, Country, Address],
        synchronize: true,
    });
    await dataSource.initialize();
    await seedUsers(dataSource);

    const grpc = new GrpcServer();
    new FxMapGrpcService([new TypeOrmQueryHandler(new UserConfig(), dataSource)]).addTo(grpc);
    const grpcPort = await new Promise<number>((resolve, reject) =>
        grpc.bindAsync(`0.0.0.0:${options.grpcPort ?? 9091}`, ServerCredentials.createInsecure(),
            (error, port) => error ? reject(error) : resolve(port)));

    const http = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/users') {
            void listUsers(dataSource).then(users => send(response, 200, users),
                (error: unknown) => send(response, 500, { error: String(error) }));
        } else {
            send(response, 404, { error: 'Not found' });
        }
    });
    const httpPort = await listen(http, options.httpPort ?? 8081);

    return {
        httpPort,
        grpcPort,
        async close() {
            await new Promise<void>(resolve => http.close(() => resolve()));
            await new Promise<void>(resolve => grpc.tryShutdown(() => resolve()));
            await dataSource.destroy();
        },
    };
}

/** The users, to see what the order service will show next to its orders. */
async function listUsers(dataSource: DataSource) {
    const users = await dataSource.getRepository(User).find({ relations: { country: true }, order: { name: 'ASC' } });
    return users.map(user => ({ id: user.id, name: user.name, email: user.email, country: user.country?.name ?? null }));
}

function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function listen(server: HttpServer, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            const address = server.address();
            resolve(typeof address === 'object' && address !== null ? address.port : port);
        });
    });
}
