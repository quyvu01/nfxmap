import 'reflect-metadata';
import {
    createDistributedMapper,
    EntityConfigureOf,
    EntityExpressionEvaluator,
    type ItemsResponse,
    LocalRequestClient,
    MapContext,
    ProfileOf,
} from 'nfxmap';
import type { DataSource } from 'typeorm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    EntityNotManagedError,
    IdColumnNotFoundError,
    TypeOrmQueryHandler,
    UnsupportedIdTypeError,
} from '../src/index.js';
import { ALICE, BOB, DATABASES, NOBODY, Product, seededDataSource, Unmapped, User } from './entities.js';

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

class ProductConfig extends EntityConfigureOf<Product> {
    constructor() {
        super(Product);
    }

    protected configure() {
        this.id('code');
        this.defaultProperty('title');
        this.useDistributedKey('ProductOf');
    }
}

const NOW = new Date('2026-10-20T08:00:00Z');

/** Expressions of every kind: the handler answers them as the in-memory evaluator does on whole entities. */
const EXPRESSIONS = [
    // properties, exposed names, navigations
    'Name', 'UserEmail', 'Email', 'Age', 'Level', 'Country?.Name', 'Address.City', "Country?.Name ?? 'none'",
    'Country.Name', 'Country.{Id, Name}', '{Id, Country.Name as CountryName}',
    // functions
    'Name:upper', 'Name:substring(1, 2)', "Name:concat(' <', Email, '>')", 'Age:add(1)', 'Age:divide(4)',
    'Score:round(1)', 'Score:pow(2)', "Name:split('i')",
    // conditions and conditionals
    "Email endswith '.com'", "Name contains 'li'", 'Score > 5', 'Score = null', "Level = 'GOLD' ? 1 : 0",
    "Age >= 30 && Name != 'Bob' ? 'senior' : 'junior'",
    // collections
    'Orders:count', 'Orders:sum(Total)', 'Orders:avg(Total)', 'Orders:max(Status)',
    "Orders:where(Status = 'Done'):sum(Total)", "Orders:any(Status = 'Open')", 'Orders:all(Total > 1)',
    '{Id, Name, Orders:count as OrderCount}', 'Orders.{Id, Total}',
    "Orders:where(Status = 'Done'):orderBy(Total desc).{Id, Total}", 'Orders:orderBy(Total desc):first.{Id, Total}',
    "Orders:orderBy('Quantity'):limit(2).{Id}", "Orders:distinct('Status')", 'Orders:distinct(Status)',
    'Orders:groupBy(Status).{Status, :count as Count}', "Orders:where(Product.Code = 'P-7'):count",
    'Orders:orderBy(Id).{Id, Product.Title as Title}', 'Orders:first.Total', 'Tags', 'Tags:count',
    // a getter, which may read any column
    'Nickname', 'Nickname:upper',
    // failures, reported as the evaluator reports them
    'Name:', 'Missing', 'Orders:distinct(Missing)', "Name:format('yyyy')", 'Age:upper',
];

describe.each(DATABASES)('TypeOrmQueryHandler on %s', (_, options) => {
    let dataSource: DataSource;
    let handler: TypeOrmQueryHandler<User>;

    beforeAll(async () => {
        dataSource = await seededDataSource(options);
        handler = new TypeOrmQueryHandler(new UserConfig(), dataSource, { now: () => NOW });
    });

    afterAll(async () => {
        await dataSource?.destroy();
    });

    const handle = (ids: string[], ...expressions: (string | null)[]): Promise<ItemsResponse> =>
        handler.handle({ selectorIds: ids, expressions }, new MapContext());

    // The answer of the in-memory evaluator on whole entities, with all their associations
    async function inMemory(ids: string[], ...expressions: (string | null)[]): Promise<ItemsResponse> {
        const users = await dataSource.getRepository(User).find({
            relations: { country: true, orders: { product: true } },
            order: { orders: { id: 'ASC' } },
        });
        const evaluator = new EntityExpressionEvaluator(new UserConfig(), { now: () => NOW, nullNavigation: 'null' });
        return evaluator.answer({ selectorIds: ids, expressions }, id => users.find(u => u.id === id));
    }

    it.each(EXPRESSIONS)('answers %s as the evaluator does on whole entities', async expression => {
        expect(await handle([ALICE, BOB], expression)).toEqual(await inMemory([ALICE, BOB], expression));
    });

    it('answers all the expressions of a request together', async () => {
        const expressions = [null, ...EXPRESSIONS];

        expect(await handle([BOB, ALICE], ...expressions)).toEqual(await inMemory([BOB, ALICE], ...expressions));
    });

    it('answers the default property and exposed names in the requested order', async () => {
        const response = await handle([BOB, NOBODY, ALICE], null, 'UserEmail');

        expect(response).toEqual({
            items: [
                { id: BOB, values: [{ expression: null, value: '"Bob"' }, { expression: 'UserEmail', value: '"bob@example.org"' }] },
                { id: ALICE, values: [{ expression: null, value: '"Alice"' }, { expression: 'UserEmail', value: '"alice@example.com"' }] },
            ],
            errors: [],
        });
        expect(handler.key).toBe('UserOf');
        expect(handler.entityName).toBe('User');
    });

    it('reads a null association as null, as FxMap\'s database handlers do', async () => {
        const response = await handle([ALICE, BOB], 'Country.Name', 'Country.Name:upper');

        expect(response.errors).toEqual([]);
        expect(response.items.map(item => item.values.map(v => v.value))).toEqual([
            ['"Vietnam"', '"VIETNAM"'],
            [null, null],
        ]);
    });

    it('keeps the requested spelling of an id', async () => {
        const upper = ALICE.toUpperCase();

        const response = await handle([upper, 'not-a-uuid'], null);

        expect(response.items.map(item => item.id)).toEqual([upper]);
    });

    it('finds by the configured id when it is not the primary key', async () => {
        const products = new TypeOrmQueryHandler(new ProductConfig(), dataSource);

        const response = await products.handle({ selectorIds: ['P-7', '7'], expressions: [null] }, new MapContext());

        expect(response.items).toEqual([{ id: 'P-7', values: [{ expression: null, value: '"Pen"' }] }]);
    });

    it('reports an expression that fails and answers the others', async () => {
        const response = await handle([ALICE], 'Name', 'Name:', 'Missing');

        expect(response.items[0].values).toEqual([{ expression: 'Name', value: '"Alice"' }]);
        expect(response.errors.map(e => e.expression)).toEqual(['Name:', 'Missing']);
    });

    it('answers an empty request without querying', async () => {
        expect(await handle([], 'Name')).toEqual({ items: [], errors: [] });
        expect(await handle(['not-a-uuid'], 'Name:')).toEqual({
            items: [],
            errors: [expect.objectContaining({ expression: 'Name:' })],
        });
    });

    it('queries many ids in chunks', async () => {
        const small = new TypeOrmQueryHandler(new UserConfig(), dataSource, { batchSize: 3 });
        const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-0000-0000-${String(i + 100).padStart(12, '0')}`);

        const response = await small.handle({ selectorIds: [...ids, ALICE, BOB], expressions: [null, 'Orders:count'] },
            new MapContext());

        expect(response.items).toEqual([
            { id: ALICE, values: [{ expression: null, value: '"Alice"' }, { expression: 'Orders:count', value: '3' }] },
            { id: BOB, values: [{ expression: null, value: '"Bob"' }, { expression: 'Orders:count', value: '0' }] },
        ]);
    });

    it('maps a DTO end to end through the engine', async () => {
        class OrderDto {
            userName: string | null = null;
            userEmail: string | null = null;
            countryName: string | null = null;

            constructor(readonly userId: string) {}
        }

        class OrderDtoProfile extends ProfileOf<OrderDto> {
            constructor() {
                super(OrderDto);
            }

            protected configure() {
                this.useDistributedKey('UserOf')
                    .of('userId')
                    .for('userName')
                    .for('userEmail', 'UserEmail')
                    .for('countryName', 'Country.Name');
            }
        }

        const mapper = createDistributedMapper({
            profiles: [new OrderDtoProfile()],
            requestClient: new LocalRequestClient(handler),
            throwIfException: true,
        });
        const dtos = [new OrderDto(ALICE), new OrderDto(BOB)];

        await mapper.map(dtos);

        expect(dtos.map(d => [d.userName, d.userEmail, d.countryName])).toEqual([
            ['Alice', 'alice@example.com', 'Vietnam'],
            ['Bob', 'bob@example.org', null],
        ]);
    });

    it('loads only the columns and associations the expressions read', () => {
        const metadata = dataSource.getMetadata(User);

        expect(handler.plan(metadata, [null, 'UserEmail'])).toEqual({
            select: { id: true, name: true, email: true },
            relations: {},
            order: {},
        });
        expect(handler.plan(metadata, ["Orders:where(Product.Code = 'P-7'):count", 'Country?.Name'])).toEqual({
            select: {
                id: true,
                name: true,
                country: { id: true, name: true },
                orders: { id: true, product: { id: true, code: true } },
            },
            relations: { country: true, orders: { product: true } },
            order: { orders: { id: 'ASC' } },
        });
        // A getter may read any column
        expect(Object.keys(handler.plan(metadata, ['Nickname']).select)).toEqual(
            ['id', 'name', 'email', 'age', 'score', 'level', 'tags', 'address']);
    });

    it('rejects a configuration that does not fit the data source', () => {
        expect(() => new TypeOrmQueryHandler(new class extends EntityConfigureOf<Unmapped> {
            constructor() {
                super(Unmapped);
            }

            protected configure() {
                this.id('id');
                this.useDistributedKey('UnmappedOf');
            }
        }(), dataSource)).toThrow(EntityNotManagedError);
        expect(() => new TypeOrmQueryHandler(new class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure() {
                this.id('nickname');
                this.useDistributedKey('NicknameOf');
            }
        }(), dataSource)).toThrow(IdColumnNotFoundError);
        expect(TypeOrmQueryHandler.isManaged(dataSource, User)).toBe(true);
        expect(TypeOrmQueryHandler.isManaged(dataSource, Unmapped)).toBe(false);
        expect(UnsupportedIdTypeError).toBeDefined();
    });

    it('names its database as FxMap does', () => {
        expect(handler.dbSystem).toBe(options.type === 'postgres' ? 'postgresql' : 'sqlite');
    });
});
