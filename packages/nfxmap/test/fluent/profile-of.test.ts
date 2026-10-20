import { describe, expect, it } from 'vitest';
import {
    AmbiguousProfileConfigurationError,
    createDistributedMapper,
    DistributedKey,
    type DistributedKeyLike,
    type DistributedKeyRuleBuilder,
    InvalidDistributedKeyNameError,
    InvalidProfileSelectorError,
    NoRequestClientError,
    ProfileOf,
} from '../../src/index.js';
import { FakeRequestClient } from '../fake-request-client.js';

class UserOf extends DistributedKey {
}

class Dto {
    userId: number | null = null;
    countryId: number | null = null;
    userName: string | null = null;
    countryName: string | null = null;
    readonly readOnly: string = '';
    children: Dto[] | null = null;
}

type Configure = (profile: { useDistributedKey(key: DistributedKeyLike): DistributedKeyRuleBuilder<Dto> }) => void;

/** JS: Java's anonymous `new ProfileOf<Dto>() { ... }`. */
function profileOf(configure: Configure): ProfileOf<Dto> {
    return new (class extends ProfileOf<Dto> {
        constructor() {
            super(Dto);
        }

        protected configure(): void {
            configure({ useDistributedKey: key => this.useDistributedKey(key) });
        }
    })();
}

describe('ProfileOf', () => {
    it('collectsTheRulesOfEachKey', () => {
        const profile = profileOf(p => {
            p.useDistributedKey(UserOf)
                .of('userId')
                .for('userName')
                .for('countryId', 'CountryId');
            p.useDistributedKey('CountryOf')
                .of('countryId')
                .for('countryName', 'Name');
        });

        expect(profile.model).toBe(Dto);
        expect(profile.definition.rules.map(r => [r.key, r.selectorProperty, r.targetProperty, r.expression])).toEqual([
            ['UserOf', 'userId', 'userName', null],
            ['UserOf', 'userId', 'countryId', 'CountryId'],
            ['CountryOf', 'countryId', 'countryName', 'Name'],
        ]);
    });

    it('ordersTheRulesByTheirDependencies', async () => {
        // JS: the plan of a profile is internal; its order is seen in the requests, and the walk in a child mapped
        // with its parent
        const profile = profileOf(p => {
            p.useDistributedKey('CountryOf').of('countryId').for('countryName', 'Name');
            p.useDistributedKey(UserOf).of('userId').for('countryId', 'CountryId');
        });
        const client = new FakeRequestClient()
            .value(UserOf, 1, 'CountryId', '5')
            .value('CountryOf', 5, 'Name', '"Vietnam"');
        const child = Object.assign(new Dto(), { userId: 1 });
        const dto = Object.assign(new Dto(), { userId: 1, children: [child] });

        await createDistributedMapper({ profiles: [profile], requestClient: client, throwIfException: true }).map(dto);

        expect(client.sent.map(s => s.key)).toEqual(['UserOf', 'CountryOf']);
        expect(dto.countryName).toBe('Vietnam');
        expect(child.countryName).toBe('Vietnam');
    });

    it('theLastRuleForAPropertyWins', () => {
        const profile = profileOf(p => p.useDistributedKey(UserOf).of('userId')
            .for('userName', 'First')
            .for('userName', 'Second'));

        expect(profile.definition.rules).toHaveLength(1);
        expect(profile.definition.rules[0].expression).toBe('Second');
    });

    it('rejectsALambdaSelector', () => {
        // JS: properties are named by strings, not method references; a selector that names no property is rejected
        const profile = profileOf(p => p.useDistributedKey(UserOf).of('' as 'userId'));

        expect(() => profile.definition).toThrow(InvalidProfileSelectorError);
        expect(() => profile.definition).toThrow('needs the name of the key property');
    });

    // Not ported: rejectsATargetThatCannotBeWritten. Without declared types, a profile is not checked against its
    // model when the mapper is built.

    it('rejectsTwoProfilesForOneType', () => {
        class First extends ProfileOf<Dto> {
            constructor() {
                super(Dto);
            }

            protected configure(): void {
            }
        }
        class Second extends ProfileOf<Dto> {
            constructor() {
                super(Dto);
            }

            protected configure(): void {
            }
        }

        expect(() => createDistributedMapper({ profiles: [new First(), new Second()] }))
            .toThrow(AmbiguousProfileConfigurationError);
    });

    it('rejectsAnInvalidStringKey', () => {
        const profile = profileOf(p => p.useDistributedKey('not a key'));

        expect(() => profile.definition).toThrow(InvalidDistributedKeyNameError);
    });

    it('needsARequestClientOnceItHasProfiles', () => {
        const profile = profileOf(() => {});

        expect(() => createDistributedMapper({ profiles: [profile] })).toThrow(NoRequestClientError);
    });
});
