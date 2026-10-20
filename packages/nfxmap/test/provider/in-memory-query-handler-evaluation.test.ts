import { describe, expect, it } from 'vitest';
import {
    DistributedKey,
    EntityConfigureOf,
    InMemoryQueryHandler,
    type ItemsResponse,
    MapContext,
} from '../../src/index.js';

/** How InMemoryQueryHandler parses and evaluates the expressions of a request. */

class MemberOf extends DistributedKey {
}

class Member {
    constructor(readonly id: number, readonly name: string, readonly email: string, readonly joined: Date,
                readonly manager: Member | null) {
    }
}

class MemberConfig extends EntityConfigureOf<Member> {
    constructor() {
        super(Member);
    }

    protected configure(): void {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey(MemberOf);
        this.exposedName('email', 'MemberEmail');
    }
}

class Faulty {
    get id(): number {
        return 1;
    }

    get name(): string {
        throw new Error('database is down');
    }
}

class FaultyConfig extends EntityConfigureOf<Faulty> {
    constructor() {
        super(Faulty);
    }

    protected configure(): void {
        this.id('id');
        this.useDistributedKey('FaultyOf');
    }
}

// JS: dates are Dates at midnight UTC where Java has LocalDates
const BOSS = new Member(1, 'Ann', 'ann@example.com', new Date(Date.UTC(2026, 0, 1)), null);
const DEV = new Member(2, 'Ben', 'ben@example.com', new Date(Date.UTC(2026, 0, 8)), BOSS);

function ask(handler: InMemoryQueryHandler<unknown>, ids: string[], expressions: string[]): Promise<ItemsResponse> {
    return handler.handle({ selectorIds: ids, expressions }, MapContext.empty());
}

describe('InMemoryQueryHandlerEvaluation', () => {
    it('givesTodayForDaysAgoFromTheClock', async () => {
        // JS: Java's Clock is a `now` function
        const handler = new InMemoryQueryHandler(new MemberConfig(), () => [BOSS, DEV],
            { now: () => new Date('2026-01-10T12:00:00Z') });

        const response = await ask(handler, ['1', '2'], ['Joined:daysAgo']);

        expect(response.errors).toEqual([]);
        expect(response.items.map(item => item.values[0].value)).toEqual(['9', '2']);
    });

    it('readsTheEntitiesOnEachRequest', async () => {
        const members: Member[] = [];
        const handler = new InMemoryQueryHandler(new MemberConfig(), () => members);

        expect((await ask(handler, ['1'], ['Name'])).items).toEqual([]);
        members.push(BOSS);
        const items = (await ask(handler, ['1'], ['Name'])).items;
        expect(items).toHaveLength(1);
        expect(items[0].values).toEqual([{ expression: 'Name', value: '"Ann"' }]);
    });

    it('reportsAnExpressionThatDoesNotTokenize', async () => {
        const handler = new InMemoryQueryHandler(new MemberConfig(), [BOSS]);

        const response = await ask(handler, ['1'], ["Name = 'Ann", 'Name']);

        expect(response.errors).toHaveLength(1);
        expect(response.errors[0].expression).toBe("Name = 'Ann");
        expect(response.errors[0].message).toContain('Unterminated string');
        expect(response.items).toHaveLength(1);
        expect(response.items[0].values).toEqual([{ expression: 'Name', value: '"Ann"' }]);
    });

    it('resolvesExposedNamesOnNestedEntitiesOfTheSameType', async () => {
        const handler = new InMemoryQueryHandler(new MemberConfig(), [BOSS, DEV]);

        const response = await ask(handler, ['2'], ['Manager.MemberEmail', 'Manager?.Manager?.MemberEmail']);

        expect(response.errors).toEqual([]);
        expect(response.items).toHaveLength(1);
        expect(response.items[0].values).toEqual([
            { expression: 'Manager.MemberEmail', value: '"ann@example.com"' },
            { expression: 'Manager?.Manager?.MemberEmail', value: null },
        ]);
    });

    it('failsTheRequestWhenAPropertyThrows', async () => {
        const handler = new InMemoryQueryHandler(new FaultyConfig(), [new Faulty()]);

        await expect(ask(handler, ['1'], ['Name'])).rejects.toThrow(new Error('database is down'));
    });
});
