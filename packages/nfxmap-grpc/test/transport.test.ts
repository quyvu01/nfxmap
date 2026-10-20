import {
    type Client,
    credentials,
    makeGenericClientConstructor,
    Metadata,
    Server,
    ServerCredentials,
    type ServerUnaryCall,
    type ServiceError,
    status,
} from '@grpc/grpc-js';
import {
    createDistributedMapper,
    DistributedKeyAssignedToMultipleEntitiesError,
    EntityConfigureOf,
    InMemoryQueryHandler,
    type ItemsResponse,
    MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    ProfileOf,
    type QueryHandler,
    ReceivedFaultError,
    RequestTimedOutError,
} from 'nfxmap';
import { afterEach, describe, expect, it } from 'vitest';
import { FxMapGrpcService, GrpcRequestClient } from '../src/index.js';
import { serviceDefinition } from '../src/server.js';

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('UserOf');
        this.exposedName('email', 'UserEmail');
    }
}

class Product {
    constructor(readonly id: string, readonly title: string) {}
}

class ProductConfig extends EntityConfigureOf<Product> {
    constructor() {
        super(Product);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('title');
        this.useDistributedKey('Catalog.ProductOf');
    }
}

class OrderDto {
    userName: string | null = null;
    userEmail: string | null = null;
    productTitle: string | null = null;

    constructor(readonly userId: number, readonly productId: string) {}
}

class OrderDtoProfile extends ProfileOf<OrderDto> {
    constructor() {
        super(OrderDto);
    }

    protected configure() {
        this.useDistributedKey('UserOf')
            .of('userId')
            .for('userName')
            .for('userEmail', 'UserEmail');
        this.useDistributedKey('Catalog.ProductOf')
            .of('productId')
            .for('productTitle');
    }
}

const users = () => new InMemoryQueryHandler(new UserConfig(),
    [new User(1, 'Alice', 'alice@example.com'), new User(2, 'Bob', 'bob@example.com')]);
const products = () => new InMemoryQueryHandler(new ProductConfig(), [new Product('p1', 'Pen')]);

const silentLogger = { error: () => undefined };
const ASSEMBLY_QUALIFIED_USER_OF =
    'UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null';

type Raw = Client & Record<string, (request: unknown, metadata: Metadata,
                                    callback: (error: ServiceError | null, response?: unknown) => void) => void>;

/** The client and the service over real gRPC connections, and the messages they exchange with FxMap's. */
describe('gRPC transport', () => {
    const closeables: (() => unknown)[] = [];

    afterEach(async () => {
        for (const close of closeables.splice(0).reverse()) await close();
    });

    async function listen(add: (server: Server) => void): Promise<string> {
        const server = new Server();
        add(server);
        const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0',
            ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound)));
        closeables.push(() => new Promise<void>(resolve => server.tryShutdown(() => resolve())));
        return `http://127.0.0.1:${port}`;
    }

    const serve = (handlers: QueryHandler[]) =>
        listen(server => new FxMapGrpcService(handlers, { logger: silentLogger }).addTo(server));

    function client(hosts: string[], timeoutMs = 5000): GrpcRequestClient {
        const created = new GrpcRequestClient({ hosts, timeoutMs });
        closeables.push(() => created.close());
        return created;
    }

    function raw(host: string): Raw {
        const Constructor = makeGenericClientConstructor(serviceDefinition(), 'FxMapTransportService');
        const created = new Constructor(host.replace('http://', ''), credentials.createInsecure()) as unknown as Raw;
        closeables.push(() => created.close());
        return created;
    }

    const rawCall = (client: Raw, method: string, request: unknown, metadata = new Metadata()) =>
        new Promise<unknown>((resolve, reject) =>
            client[method](request, metadata, (error, response) => error ? reject(error) : resolve(response)));

    const request = (requestClient: GrpcRequestClient, key: string, headers: Record<string, string>,
                     ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        requestClient.request(key, { selectorIds: ['1', '2'], expressions }, new MapContext(headers));

    it('maps a DTO from the hosts that own its keys', async () => {
        const userHost = await serve([users()]);
        const productHost = await serve([products()]);
        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: client([productHost, userHost]),
            throwIfException: true,
        });
        const dtos = [new OrderDto(1, 'p1'), new OrderDto(2, 'p2'), new OrderDto(3, 'p1')];

        await mapper.map(dtos);

        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob', null]);
        expect(dtos.map(d => d.userEmail)).toEqual(['alice@example.com', 'bob@example.com', null]);
        expect(dtos.map(d => d.productTitle)).toEqual(['Pen', null, 'Pen']);
    });

    it('carries the headers as metadata', async () => {
        let seen: MapContext | undefined;
        const recording: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: async (_: MapRequest, context: MapContext) => {
                seen = context;
                return { items: [], errors: [] };
            },
        };
        const host = await serve([recording]);

        await request(client([host]), 'UserOf', { authorization: 'Bearer x', 'Bad Name': 'dropped' }, null);

        expect(seen?.headers.authorization).toBe('Bearer x');
        expect(seen?.headers).not.toHaveProperty('Bad Name');
    });

    it('brings an owner failure back as a received fault', async () => {
        const failing = new InMemoryQueryHandler(new UserConfig(), () => {
            throw new Error('database down');
        });
        const host = await serve([failing]);

        const failure = request(client([host]), 'UserOf', {}, 'Name');

        await expect(failure).rejects.toBeInstanceOf(ReceivedFaultError);
        await expect(failure).rejects.toThrow('database down');
    });

    it('fails for a key that no host owns', async () => {
        const host = await serve([users()]);

        await expect(request(client([host]), 'NobodyOf', {}, 'Name')).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
    });

    it('times out when the owner does not answer in time', async () => {
        const slow: QueryHandler = {
            key: 'UserOf',
            entityName: 'User',
            handle: () => new Promise(resolve => setTimeout(() => resolve({ items: [], errors: [] }), 2000)),
        };
        const host = await serve([slow]);
        const requestClient = client([host], 300);

        await expect(request(requestClient, 'UserOf', {}, null)).rejects.toBeInstanceOf(RequestTimedOutError);
    });

    it('asks a host that was down again on the next unknown key', async () => {
        const server = new Server();
        new FxMapGrpcService([users()], { logger: silentLogger }).addTo(server);
        // A port that nobody listens on yet
        const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0',
            ServerCredentials.createInsecure(), (error, bound) => error ? reject(error) : resolve(bound)));
        await new Promise<void>(resolve => server.tryShutdown(() => resolve()));
        const requestClient = client([`127.0.0.1:${port}`], 500);

        await expect(request(requestClient, 'UserOf', {}, null)).rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);

        const restarted = new Server();
        new FxMapGrpcService([users()], { logger: silentLogger }).addTo(restarted);
        await new Promise<void>((resolve, reject) => restarted.bindAsync(`127.0.0.1:${port}`,
            ServerCredentials.createInsecure(), error => error ? reject(error) : resolve()));
        closeables.push(() => new Promise<void>(resolve => restarted.tryShutdown(() => resolve())));
        const response = await request(requestClient, 'UserOf', {}, null);
        expect(response.items).toHaveLength(2);
    });

    it('sends what an FxMap server reads and reads what it replies', async () => {
        let received: unknown;
        let headers: Metadata | undefined;
        // What FxMap's GrpcServer would do
        const host = await listen(server => server.addService(serviceDefinition(), {
            GetDistributedKeys: (_: unknown, callback: (error: null, response: unknown) => void) =>
                callback(null, { distributed_key_types: [ASSEMBLY_QUALIFIED_USER_OF] }),
            GetItems: (call: ServerUnaryCall<unknown, unknown>, callback: (error: null, response: unknown) => void) => {
                received = call.request;
                headers = call.metadata;
                callback(null, {
                    items: [{ id: '1', fxmap_values: [{ expression: { value: 'UserEmail' }, value: { value: '"alice@example.com"' } }] }],
                    errors: [{ expression: { value: 'Bad(' }, message: { value: 'Unexpected end' } }],
                });
            },
        }));

        const response = await request(client([host]), 'UserOf', { tenant: 'a' }, null, 'UserEmail');

        expect(received).toEqual({
            selector_ids: ['1', '2'],
            expression: { value: '[null,"UserEmail"]' },
            distributed_key_assembly_type: { value: ASSEMBLY_QUALIFIED_USER_OF },
        });
        expect(headers?.get('tenant')).toEqual(['a']);
        expect(response).toEqual({
            items: [{ id: '1', values: [{ expression: 'UserEmail', value: '"alice@example.com"' }] }],
            errors: [{ expression: 'Bad(', message: 'Unexpected end' }],
        });
    });

    it('answers what an FxMap client sends', async () => {
        const host = await serve([users(), products()]);
        const fxmap = raw(host);

        expect(await rawCall(fxmap, 'GetDistributedKeys', {})).toEqual({
            distributed_key_types: [
                'Catalog.ProductOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',
                ASSEMBLY_QUALIFIED_USER_OF,
            ],
        });
        // What FxMap's GrpcRequestClient sends: the expressions as one JSON array, the key as its .NET type
        const metadata = new Metadata();
        metadata.add('tenant', 'a');
        expect(await rawCall(fxmap, 'GetItems', {
            selector_ids: ['2'],
            expression: { value: '[null,"UserEmail"]' },
            distributed_key_assembly_type: { value: ASSEMBLY_QUALIFIED_USER_OF },
        }, metadata)).toEqual({
            items: [{
                id: '2',
                // The default property's expression is null: absent on the wire
                fxmap_values: [
                    { value: { value: '"Bob"' } },
                    { expression: { value: 'UserEmail' }, value: { value: '"bob@example.com"' } },
                ],
            }],
        });
    });

    it('refuses a key it does not own and expressions that are not JSON', async () => {
        const fxmap = raw(await serve([users()]));

        await expect(rawCall(fxmap, 'GetItems', {
            selector_ids: ['1'],
            expression: { value: '[null]' },
            distributed_key_assembly_type: { value: 'NobodyOf' },
        })).rejects.toMatchObject({ code: status.NOT_FOUND });
        await expect(rawCall(fxmap, 'GetItems', {
            selector_ids: ['1'],
            expression: { value: 'Email' },
            distributed_key_assembly_type: { value: ASSEMBLY_QUALIFIED_USER_OF },
        })).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    });
});

describe('what the client and the service check', () => {
    it('the client needs hosts and a positive timeout', () => {
        expect(() => new GrpcRequestClient({ hosts: [] })).toThrow(RangeError);
        expect(() => new GrpcRequestClient({ hosts: [' '] })).toThrow(RangeError);
        expect(() => new GrpcRequestClient({ hosts: ['ftp://x:1'] })).toThrow(RangeError);
        expect(() => new GrpcRequestClient({ hosts: ['x:1'], timeoutMs: 0 })).toThrow(RangeError);
        const client = new GrpcRequestClient({ hosts: ['http://a:1', ' http://a:1 ', 'https://b'] });
        expect(client.hosts).toEqual(['http://a:1', 'https://b']);
        expect(client.timeoutMs).toBe(3000);
        expect(client.transport).toBe('grpc');
        client.close();
    });

    it('the service refuses shared keys', () => {
        expect(() => new FxMapGrpcService([users(), users()])).toThrow(DistributedKeyAssignedToMultipleEntitiesError);
        expect(new FxMapGrpcService([users(), products()]).keys).toEqual(['UserOf', 'Catalog.ProductOf']);
    });
});
