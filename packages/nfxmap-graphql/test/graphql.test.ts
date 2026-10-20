import { makeExecutableSchema } from '@graphql-tools/schema';
import DataLoader from 'dataloader';
import { buildSchema, type ExecutionResult, graphql, type GraphQLSchema } from 'graphql';
import {
    createDistributedMapper,
    defineEntity,
    defineProfile,
    type DistributedMapper,
    InMemoryQueryHandler,
    LocalRequestClient,
    type MapContext,
    type MapRequest,
    type RequestClient,
} from 'nfxmap';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FieldKey, NfxMapGraphQL } from '../src/index.js';

/** Ported from jfxmap's JfxMapGraphQlTest. */

interface User {
    id: number;
    name: string;
    email: string;
    provinceId: number;
}

interface Province {
    id: number;
    name: string;
}

class OrderDto {
    userName: string | null = null;
    userEmail: string | null = null;
    provinceId: number | null = null;
    provinceName: string | null = null;

    constructor(readonly id: number, readonly userId: number) {
    }
}

const orderProfile = defineProfile(OrderDto, profile => {
    profile.useDistributedKey('UserOf')
        .of('userId')
        .for('userName')
        .for('userEmail', 'UserEmail')
        .for('provinceId', 'ProvinceId');
    profile.useDistributedKey('ProvinceOf')
        .of('provinceId')
        .for('provinceName');
});

/** Answers in process and records every request. */
class Recording implements RequestClient {
    readonly keys: string[] = [];
    readonly sent: MapRequest[] = [];
    readonly contexts: MapContext[] = [];
    private readonly local = new LocalRequestClient(
        new InMemoryQueryHandler(defineEntity<User>('User', {
            key: 'UserOf', id: 'id', defaultProperty: 'name',
            exposedNames: { UserEmail: 'email', ProvinceId: 'provinceId' },
        }), [
            { id: 1, name: 'Alice', email: 'alice@example.com', provinceId: 7 },
            { id: 2, name: 'Bob', email: 'bob@example.com', provinceId: 8 },
        ]),
        new InMemoryQueryHandler(defineEntity<Province>('Province', { key: 'ProvinceOf', id: 'id', defaultProperty: 'name' }),
            [{ id: 7, name: 'Hanoi' }, { id: 8, name: 'Osaka' }]));

    request(key: string, request: MapRequest, context: MapContext) {
        this.keys.push(key);
        this.sent.push(request);
        this.contexts.push(context);
        return this.local.request(key, request, context);
    }
}

const SDL = `
    type Query { orders: [Order] customers: [Customer] }
    type Customer { name: String orders: [Order] }
    type Order { id: Int userId: Int userName: String userEmail: String provinceName: String }
`;

const orders = () => [new OrderDto(1, 1), new OrderDto(2, 2), new OrderDto(3, 1), new OrderDto(4, 3)];

const queryResolvers = {
    Query: {
        orders: () => orders(),
        customers: () => [
            { name: 'a', orders: [new OrderDto(1, 1), new OrderDto(2, 2)] },
            { name: 'b', orders: [new OrderDto(3, 2)] },
        ],
    },
};

let client: Recording;
let mapper: DistributedMapper;

beforeEach(() => {
    client = new Recording();
    mapper = createDistributedMapper({ profiles: [orderProfile], requestClient: client, throwIfException: true });
});

function schemaOf(nfxmap: NfxMapGraphQL): GraphQLSchema {
    return nfxmap.instrument(makeExecutableSchema({ typeDefs: SDL, resolvers: queryResolvers }));
}

function execute(schema: GraphQLSchema, source: string, contextValue: unknown = {}): Promise<ExecutionResult> {
    return Promise.resolve(graphql({ schema, source, contextValue }));
}

function list(result: ExecutionResult, field: string): Record<string, unknown>[] {
    expect(result.errors).toBeUndefined();
    return (result.data as Record<string, Record<string, unknown>[]>)[field];
}

const named = () => new NfxMapGraphQL(mapper, { typeNames: [[OrderDto, 'Order']] });

describe('NfxMapGraphQL', () => {
    it('resolves the selected fields in one request per key', async () => {
        const result = list(await execute(schemaOf(named()), '{ orders { id userName } }'), 'orders');

        expect(result.map(o => o.userName)).toEqual(['Alice', 'Bob', 'Alice', null]);
        expect(client.sent).toHaveLength(1);
        expect([...client.sent[0].selectorIds].sort()).toEqual(['1', '2', '3']);
        expect(client.sent[0].expressions).toEqual([null]);
    });

    it('fills first the key of a field that another rule fills', async () => {
        const result = list(await execute(schemaOf(named()), '{ orders { provinceName } }'), 'orders');

        expect(result.map(o => o.provinceName)).toEqual(['Hanoi', 'Osaka', 'Hanoi', null]);
        expect(client.keys).toEqual(['UserOf', 'ProvinceOf']);
        expect(client.sent[0].expressions).toEqual(['ProvinceId']);
    });

    it('batches the objects of every parent of a level', async () => {
        const result = await execute(schemaOf(named()), '{ customers { name orders { userName userEmail } } }');

        expect(list(result, 'customers')).toEqual([
            { name: 'a', orders: [{ userName: 'Alice', userEmail: 'alice@example.com' },
                                  { userName: 'Bob', userEmail: 'bob@example.com' }] },
            { name: 'b', orders: [{ userName: 'Bob', userEmail: 'bob@example.com' }] },
        ]);
        expect(client.sent).toHaveLength(1);
        expect([...client.sent[0].expressions].sort()).toEqual(['UserEmail', null].sort());
    });

    it('sends the headers of the context', async () => {
        await execute(schemaOf(named()), '{ orders { userName } }',
            { [NfxMapGraphQL.HEADERS]: { authorization: 'Bearer x' } });

        expect(client.contexts[0].headers).toEqual({ authorization: 'Bearer x' });
    });

    it('reads the headers with the headers option', async () => {
        const nfxmap = new NfxMapGraphQL(mapper, {
            typeNames: [[OrderDto, 'Order']],
            headers: context => (context as { request: { headers: Record<string, string> } }).request.headers,
        });

        await execute(schemaOf(nfxmap), '{ orders { userName } }', { request: { headers: { tenant: 'a' } } });

        expect(client.contexts[0].headers).toEqual({ tenant: 'a' });
    });

    it('creates a data loader per request', async () => {
        const schema = schemaOf(named());

        await execute(schema, '{ orders { userName } }');
        await execute(schema, '{ orders { userEmail } }');

        expect(client.sent.map(request => request.expressions)).toEqual([[null], ['UserEmail']]);
    });

    it('maps each field on its own without a context', async () => {
        const result = await execute(schemaOf(named()), '{ orders { userName } }', null);

        expect(list(result, 'orders').map(o => o.userName)).toEqual(['Alice', 'Bob', 'Alice', null]);
        expect(client.sent).toHaveLength(4);
    });

    it('gives the resolvers of the mapped fields for graphql-tools', async () => {
        // The profile also maps provinceId, which this schema does not have
        const schema = makeExecutableSchema({
            typeDefs: SDL, resolvers: [queryResolvers, named().resolvers()],
            resolverValidationOptions: { requireResolversToMatchSchema: 'ignore' },
        });

        const result = list(await execute(schema, '{ orders { userName provinceName } }'), 'orders');

        expect(result).toEqual([
            { userName: 'Alice', provinceName: 'Hanoi' }, { userName: 'Bob', provinceName: 'Osaka' },
            { userName: 'Alice', provinceName: 'Hanoi' }, { userName: null, provinceName: null },
        ]);
        expect(client.keys).toEqual(['UserOf', 'ProvinceOf']);
        expect(Object.keys(named().resolvers().Order).sort())
            .toEqual(['provinceId', 'provinceName', 'userEmail', 'userName']);
    });

    it('instruments a schema built with buildSchema', async () => {
        const schema = buildSchema('type Query { orders: [Order] } type Order { id: Int userEmail: String }');

        const result = await graphql({
            schema: named().instrument(schema), source: '{ orders { id userEmail } }', rootValue: { orders },
            contextValue: {},
        });

        expect(list(result, 'orders').map(o => o.userEmail))
            .toEqual(['alice@example.com', 'bob@example.com', 'alice@example.com', null]);
        expect(client.sent).toHaveLength(1);
    });

    it('leaves a schema without the type as it is', async () => {
        const schema = buildSchema('type Query { orderDto: OrderDto } type OrderDto { id: Int }');

        const result = await graphql({
            schema: new NfxMapGraphQL(mapper).instrument(schema), source: '{ orderDto { id } }',
            rootValue: { orderDto: () => new OrderDto(1, 1) }, contextValue: {},
        });

        expect(result.errors).toBeUndefined();
        expect(client.sent).toHaveLength(0);
    });

    it('turns a failed mapping into an error of the field', async () => {
        const failing = createDistributedMapper({
            profiles: [orderProfile], throwIfException: true,
            requestClient: { request: () => Promise.reject(new Error('owner down')) },
        });

        const result = await execute(schemaOf(new NfxMapGraphQL(failing, { typeNames: [[OrderDto, 'Order']] })),
            '{ orders { id userName } }');

        expect(result.errors?.length).toBeGreaterThan(0);
        expect(result.errors?.[0].message).toContain('owner down');
    });

    it('names the types after the models unless told otherwise', () => {
        expect(new NfxMapGraphQL(mapper).fields).toEqual(new Map([
            ['OrderDto', new Set(['userName', 'userEmail', 'provinceId', 'provinceName'])],
        ]));
        expect([...named().fields.keys()]).toEqual(['Order']);

        const plain = createDistributedMapper({
            profiles: [defineProfile<{ userId: number; userName?: string }>('PlainOrder',
                profile => profile.useDistributedKey('UserOf').of('userId').for('userName'))],
            requestClient: client,
        });
        expect(new NfxMapGraphQL(plain).fields).toEqual(new Map([['PlainOrder', new Set(['userName'])]]));
    });

    it('rejects missing values', () => {
        expect(() => new NfxMapGraphQL(null as unknown as DistributedMapper)).toThrow(TypeError);
        expect(() => new NfxMapGraphQL(mapper, { typeNames: [[null as unknown as string, 'Order']] }))
            .toThrow(TypeError);
        expect(() => new NfxMapGraphQL(mapper, { typeNames: [[OrderDto, ' ']] })).toThrow(RangeError);
        expect(() => new NfxMapGraphQL(mapper).resolver(null as unknown as string)).toThrow(TypeError);
    });

    it('loads the values of fields in their order, null for a field without a value', async () => {
        const alice = new OrderDto(1, 1);
        const nobody = new OrderDto(2, 9);
        const keys: FieldKey[] = [
            { source: alice, property: 'userName' },
            { source: alice, property: 'userEmail' },
            { source: nobody, property: 'userName' },
        ];

        const values = await new NfxMapGraphQL(mapper).load(keys);

        expect(values).toEqual(['Alice', 'alice@example.com', null]);
        expect(client.sent).toHaveLength(1);
        expect(client.contexts[0].headers).toEqual({});
    });

    it('uses the data loader the application put in the context', async () => {
        const nfxmap = named();
        let batches = 0;
        const loader = new DataLoader<FieldKey, unknown>(keys => {
            batches++;
            return nfxmap.load(keys, { from: 'application' });
        });

        const result = await execute(schemaOf(nfxmap), '{ orders { userName } }', { [NfxMapGraphQL.LOADER]: loader });

        expect(list(result, 'orders').map(o => o.userName)).toEqual(['Alice', 'Bob', 'Alice', null]);
        expect(batches).toBe(1);
        expect(client.contexts[0].headers).toEqual({ from: 'application' });
    });

    it('creates the data loader of a request with its headers', async () => {
        const nfxmap = named();

        await execute(schemaOf(nfxmap), '{ orders { userName } }',
            { [NfxMapGraphQL.LOADER]: nfxmap.createLoader({ tenant: 'b' }) });

        expect(client.sent).toHaveLength(1);
        expect(client.contexts[0].headers).toEqual({ tenant: 'b' });
    });
});
