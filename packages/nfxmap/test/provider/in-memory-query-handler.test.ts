import { describe, expect, it } from 'vitest';
import {
    createDistributedMapper,
    DistributedKey,
    DistributedKeyAssignedToMultipleEntitiesError,
    EntityConfigureOf,
    InMemoryQueryHandler,
    LocalRequestClient,
    MapContext,
    NoHandlerForDistributedKeyError,
    ProfileOf,
} from '../../src/index.js';

/** The engine end to end: a profile on one side, an entity configuration on the other, in one process. */

class UserOf extends DistributedKey {
}

class Country {
    constructor(readonly name: string) {
    }
}

class Order {
    constructor(readonly id: string, readonly status: string, readonly total: number) {
    }
}

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string, readonly country: Country | null,
                readonly orders: Order[]) {
    }
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure(): void {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey(UserOf);
        this.exposedName('email', 'UserEmail');
    }
}

class OrderDto {
    userId: number;
    userName: string | null = null;
    userEmail: string | null = null;
    countryName: string | null = null;
    country: Country | null = null;

    constructor(userId = 0) {
        this.userId = userId;
    }
}

class OrderProfile extends ProfileOf<OrderDto> {
    constructor() {
        super(OrderDto);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('userName')
            .for('userEmail', 'UserEmail')
            .for('countryName', 'Country?.Name')
            // JS: the parsed JSON becomes a Country through convert
            .for('country', 'Country', { convert: value => new Country((value as { name: string }).name) });
    }
}

const users = [
    new User(1, 'Alice', 'alice@example.com', new Country('Vietnam'), [
        new Order('A1', 'Done', 10.5), new Order('A2', 'Open', 4), new Order('A3', 'Done', 20)]),
    new User(2, 'Bob', 'bob@example.com', null, []),
];

class OrderSummary {
    constructor(readonly id: string, readonly total: number) {
    }
}

class StatsDto {
    userId: number;
    upperName: string | null = null;
    emailDomain: string | null = null;
    doneTotal = 0;
    orderCount = 0;
    label: string | null = null;
    doneOrders: OrderSummary[] | null = null;

    constructor(userId = 0) {
        this.userId = userId;
    }
}

class StatsProfile extends ProfileOf<StatsDto> {
    constructor() {
        super(StatsDto);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('upperName', 'Name:upper')
            .for('emailDomain', 'UserEmail:lower:substring(6)')
            .for('doneTotal', "Orders:where(Status = 'Done'):sum(Total)")
            .for('orderCount', 'Orders:count')
            .for('label', "Orders:any ? 'customer' : 'none'")
            .for('doneOrders', "Orders:where(Status = 'Done'):orderBy(Total desc).{Id, Total}", {
                convert: value => (value as { Id: string; Total: number }[]).map(o => new OrderSummary(o.Id, o.Total)),
            });
    }
}

describe('InMemoryQueryHandler', () => {
    it('mapsFromEntitiesInMemory', async () => {
        const client = new LocalRequestClient(new InMemoryQueryHandler(new UserConfig(), users));
        const mapper = createDistributedMapper({
            profiles: [new OrderProfile()], requestClient: client, throwIfException: true,
        });
        const orders = [new OrderDto(1), new OrderDto(2), new OrderDto(3)];

        await mapper.map(orders);

        const alice = orders[0];
        expect(alice.userName).toBe('Alice');
        expect(alice.userEmail).toBe('alice@example.com');
        expect(alice.countryName).toBe('Vietnam');
        expect(alice.country).toEqual(new Country('Vietnam'));
        const bob = orders[1];
        expect(bob.userName).toBe('Bob');
        expect(bob.countryName).toBeNull();
        expect(orders[2].userName).toBeNull();
    });

    it('evaluatesTheExpressionLanguage', async () => {
        const client = new LocalRequestClient(new InMemoryQueryHandler(new UserConfig(), users));
        const mapper = createDistributedMapper({
            profiles: [new StatsProfile()], requestClient: client, throwIfException: true,
        });
        const alice = new StatsDto(1);
        const bob = new StatsDto(2);

        await mapper.map([alice, bob]);

        expect(alice.upperName).toBe('ALICE');
        expect(alice.emailDomain).toBe('example.com');
        expect(alice.doneTotal).toBe(30.5);
        expect(alice.orderCount).toBe(3);
        expect(alice.label).toBe('customer');
        expect(alice.doneOrders).toEqual([new OrderSummary('A3', 20), new OrderSummary('A1', 10.5)]);
        expect(bob.upperName).toBe('BOB');
        expect(bob.doneTotal).toBe(0);
        expect(bob.orderCount).toBe(0);
        expect(bob.label).toBe('none');
        expect(bob.doneOrders).toEqual([]);
    });

    it('reportsExpressionsItCannotEvaluateAndAnswersTheOthers', async () => {
        const handler = new InMemoryQueryHandler(new UserConfig(), users);

        const response = await handler.handle({
            selectorIds: ['1', '2'],
            expressions: [null, 'Name:upper', 'Missing', 'Name:(', 'Country.Name', 'Country?.Name'],
        }, MapContext.empty());

        // Country.Name fails on Bob, who has no country, so it is dropped for Alice too
        expect(response.errors.map(e => e.expression)).toEqual(['Name:(', 'Missing', 'Country.Name']);
        expect(response.items.map(item => item.values)).toEqual([
            [{ expression: null, value: '"Alice"' }, { expression: 'Name:upper', value: '"ALICE"' },
                { expression: 'Country?.Name', value: '"Vietnam"' }],
            [{ expression: null, value: '"Bob"' }, { expression: 'Name:upper', value: '"BOB"' },
                { expression: 'Country?.Name', value: null }],
        ]);
    });

    it('reportsTheDefaultPropertyWhenThereIsNone', async () => {
        class NoDefaultConfig extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
                this.useDistributedKey(UserOf);
            }
        }
        const handler = new InMemoryQueryHandler(new NoDefaultConfig(), users);

        const response = await handler.handle({ selectorIds: ['1'], expressions: [null, 'Name'] }, MapContext.empty());

        expect(response.errors).toHaveLength(1);
        expect(response.errors[0].expression).toBeNull();
        expect(response.errors[0].message).toContain('no default property');
        expect(response.items).toHaveLength(1);
        expect(response.items[0].values).toEqual([{ expression: 'Name', value: '"Alice"' }]);
    });

    it('resolvesExposedNamesOnTheEntityTypeOnly', async () => {
        const handler = new InMemoryQueryHandler(new UserConfig(), users);

        const response = await handler.handle({
            selectorIds: ['1'],
            expressions: ['UserEmail:upper', 'Email', '{Id, UserEmail}', 'Country.UserEmail'],
        }, MapContext.empty());

        expect(response.errors.map(e => e.expression)).toEqual(['Country.UserEmail']);
        expect(response.items).toHaveLength(1);
        expect(response.items[0].values).toEqual([
            { expression: 'UserEmail:upper', value: '"ALICE@EXAMPLE.COM"' },
            { expression: 'Email', value: '"alice@example.com"' },
            { expression: '{Id, UserEmail}', value: '{"Id":1,"UserEmail":"alice@example.com"}' },
        ]);
    });

    it('routesByKeyAndRejectsTwoEntitiesForOneKey', async () => {
        const client = new LocalRequestClient(new InMemoryQueryHandler(new UserConfig(), users));

        expect(() => client.register(new InMemoryQueryHandler(new UserConfig(), [])))
            .toThrow(DistributedKeyAssignedToMultipleEntitiesError);
        await expect(client.request('Nobody', { selectorIds: ['1'], expressions: ['Name'] }, MapContext.empty()))
            .rejects.toBeInstanceOf(NoHandlerForDistributedKeyError);
    });
});
