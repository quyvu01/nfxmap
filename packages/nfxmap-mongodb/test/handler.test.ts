import { type Document, type Db, MongoClient, ObjectId, UUID } from 'mongodb';
import {
    createDistributedMapper,
    defineEntity,
    EntityConfigureOf,
    EntityExpressionEvaluator,
    LocalRequestClient,
    MapContext,
    ProfileOf,
} from 'nfxmap';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoQueryHandler } from '../src/index.js';

const NOW = new Date('2026-10-20T08:00:00Z');
const ALICE = new ObjectId('6566f1a2b3c4d5e6f7a8b9c0');
const BOB = new ObjectId('6566f1a2b3c4d5e6f7a8b9c1');
const NOBODY = '6566f1a2b3c4d5e6f7a8b9ff';

interface User {
    id: string;
    name: string;
    email: string;
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super('User');
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('UserOf');
        this.exposedName('email', 'UserEmail');
    }
}

/** Expressions of every kind, on documents with sub-documents and arrays. */
const EXPRESSIONS = [
    'Name', 'UserEmail', 'Age', 'Country.Name', 'Country?.Name', "Country?.Name ?? 'none'", '{Id, Name}',
    'Name:upper', "Name:concat(' <', Email, '>')", 'Age:add(1)', 'CreatedAt:year', "CreatedAt:format('yyyy-MM-dd')",
    "Email endswith '.com'", "Age >= 30 ? 'senior' : 'junior'",
    'Orders:count', 'Orders:sum(Total)', "Orders:where(Status = 'Done'):sum(Total)", "Orders:any(Status = 'Open')",
    'Orders:orderBy(Total desc):first.{Id, Total}', "Orders:distinct('Status')",
    'Orders:groupBy(Status).{Status, :count as Count}', 'Tags', 'Tags:count',
    'Name:', 'Missing', "Name:format('yyyy')",
];

const MONGO_URL = process.env.MONGO_URL;

/** Against a real MongoDB: `MONGO_URL` (CI runs one); skipped without it. */
describe.skipIf(!MONGO_URL)('MongoQueryHandler', () => {
    let client: MongoClient;
    let db: Db;
    let handler: MongoQueryHandler<User>;
    let documents: Document[];

    beforeAll(async () => {
        client = await MongoClient.connect(MONGO_URL!);
        db = client.db(`nfxmap_test_${process.pid}`);
        documents = [
            {
                _id: ALICE, name: 'Alice', email: 'alice@example.com', age: 30, country: { name: 'Vietnam' },
                createdAt: new Date('2024-12-25T14:30:45Z'), tags: ['a', 'b'],
                orders: [
                    { id: 1, status: 'Done', total: 10.5 },
                    { id: 2, status: 'Done', total: 4.5 },
                    { id: 3, status: 'Open', total: 100 },
                ],
            },
            {
                _id: BOB, name: 'Bob', email: 'bob@example.org', age: 25, country: null,
                createdAt: new Date('2025-06-01T08:00:00Z'), tags: [], orders: [],
            },
        ];
        await db.collection('users').insertMany(documents.map(d => ({ ...d })));
        handler = new MongoQueryHandler(new UserConfig(), db.collection('users'), { now: () => NOW });
    });

    afterAll(async () => {
        await db?.dropDatabase();
        await client?.close();
    });

    const ids = [ALICE.toHexString(), BOB.toHexString()];

    // The answer of the in-memory evaluator on the whole documents
    function inMemory(selectorIds: string[], ...expressions: (string | null)[]) {
        const evaluator = new EntityExpressionEvaluator(new UserConfig(), { now: () => NOW });
        return evaluator.answer({ selectorIds, expressions }, id => {
            const document = documents.find(d => (d._id as ObjectId).toHexString() === id.toLowerCase());
            return document === undefined ? null : { ...document, id: document._id } as unknown as User;
        });
    }

    const handle = (selectorIds: string[], ...expressions: (string | null)[]) =>
        handler.handle({ selectorIds, expressions }, new MapContext());

    it.each(EXPRESSIONS)('answers %s as the evaluator does on whole documents', async expression => {
        expect(await handle(ids, expression)).toEqual(inMemory(ids, expression));
    });

    it('answers all the expressions of a request together', async () => {
        const expressions = [null, ...EXPRESSIONS];

        expect(await handle([BOB.toHexString(), ALICE.toHexString()], ...expressions))
            .toEqual(inMemory([BOB.toHexString(), ALICE.toHexString()], ...expressions));
    });

    it('answers the default property and exposed names in the requested order, by any spelling of an ObjectId', async () => {
        const upper = ALICE.toHexString().toUpperCase();

        const response = await handle([BOB.toHexString(), NOBODY, upper, 'not-an-id'], null, 'UserEmail');

        expect(response).toEqual({
            items: [
                { id: BOB.toHexString(), values: [{ expression: null, value: '"Bob"' }, { expression: 'UserEmail', value: '"bob@example.org"' }] },
                { id: upper, values: [{ expression: null, value: '"Alice"' }, { expression: 'UserEmail', value: '"alice@example.com"' }] },
            ],
            errors: [],
        });
        expect(handler.key).toBe('UserOf');
        expect(handler.idField).toBe('_id');
        expect(handler.dbSystem).toBe('mongodb');
    });

    it('loads only the fields the expressions name, in each spelling', () => {
        expect(handler.projection([null, 'UserEmail', 'Country.Name'])).toEqual({
            _id: 1, id: 1, Id: 1, name: 1, Name: 1, UserEmail: 1, userEmail: 1, email: 1, Email: 1, Country: 1,
            country: 1,
        });
    });

    it('reads the documents of FxMap\'s .NET services: PascalCase fields and UUID ids', async () => {
        const id = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
        await db.collection('people').insertOne({ _id: new UUID(id) as never, Name: 'Carol', Address: { City: 'Hanoi' } });
        const people = new MongoQueryHandler(defineEntity<Document>('Person', { key: 'PersonOf', id: 'Id', defaultProperty: 'Name' }),
            db.collection('people'), { idField: '_id' });

        const response = await people.handle({ selectorIds: [id.toUpperCase()], expressions: [null, 'Address.City'] },
            new MapContext());

        expect(response.items).toEqual([{ id: id.toUpperCase(), values: [
            { expression: null, value: '"Carol"' }, { expression: 'Address.City', value: '"Hanoi"' }] }]);
    });

    it('finds by another field, with ids of a given type', async () => {
        await db.collection('products').insertMany([{ code: 7, title: 'Pen' }, { code: 8, title: 'Ink' }]);
        const products = new MongoQueryHandler(
            defineEntity<Document>('Product', { key: 'ProductOf', id: 'code', defaultProperty: 'title' }),
            db.collection('products'), { idType: 'number', batchSize: 1 });

        const response = await products.handle({ selectorIds: ['8', 'x', '7'], expressions: [null] }, new MapContext());

        expect(response.items).toEqual([
            { id: '8', values: [{ expression: null, value: '"Ink"' }] },
            { id: '7', values: [{ expression: null, value: '"Pen"' }] },
        ]);
        expect(products.idField).toBe('code');
    });

    it('maps the documents to entities, which read whole documents', async () => {
        class Person {
            name = '';
            email = '';

            get display(): string {
                return `${this.name} <${this.email}>`;
            }
        }
        const people = new MongoQueryHandler(defineEntity(Person, { key: 'PersonOf', id: 'name' }),
            db.collection('users'), { map: document => Object.assign(new Person(), document) });

        const response = await people.handle({ selectorIds: ['Alice'], expressions: ['Display'] }, new MapContext());

        expect(response.items).toEqual([{ id: 'Alice', values: [{ expression: 'Display', value: '"Alice <alice@example.com>"' }] }]);
    });

    it('maps a DTO end to end through the engine', async () => {
        class OrderDto {
            userName: string | null = null;
            countryName: string | null = null;

            constructor(readonly userId: string) {}
        }

        class OrderDtoProfile extends ProfileOf<OrderDto> {
            constructor() {
                super(OrderDto);
            }

            protected configure() {
                this.useDistributedKey('UserOf').of('userId').for('userName').for('countryName', 'Country?.Name');
            }
        }

        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: new LocalRequestClient(handler),
            throwIfException: true,
        });
        const dtos = [new OrderDto(ALICE.toHexString()), new OrderDto(BOB.toHexString())];

        await mapper.map(dtos);

        expect(dtos.map(d => [d.userName, d.countryName])).toEqual([['Alice', 'Vietnam'], ['Bob', null]]);
    });
});

describe('the options of MongoQueryHandler', () => {
    const collection = {} as never;

    it('are checked before anything is read', () => {
        expect(() => new MongoQueryHandler(new UserConfig(), undefined as never)).toThrow(TypeError);
        expect(() => new MongoQueryHandler(new UserConfig(), collection, { idField: ' ' })).toThrow(RangeError);
        expect(() => new MongoQueryHandler(new UserConfig(), collection, { idType: 'date' as never })).toThrow(RangeError);
        expect(() => new MongoQueryHandler(new UserConfig(), collection, { batchSize: 0 })).toThrow(RangeError);
        expect(new MongoQueryHandler(new UserConfig(), collection, { idField: 'user_id' }).idField).toBe('user_id');
    });
});
