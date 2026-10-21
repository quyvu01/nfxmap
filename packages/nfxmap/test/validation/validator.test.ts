import { describe, expect, it } from 'vitest';
import {
    defineEntity,
    defineProfile,
    describeProblem,
    DistributedKey,
    DistributedMapError,
    EntityConfigureOf,
    isPlainName,
    NfxMapValidationError,
    ProfileOf,
    validateEntities,
    validateOrThrow,
    validateProfiles,
    type ValidationProblem,
} from '../../src/index.js';

/** Ported from jfxmap's JfxMapValidatorTest. */

class UserOf extends DistributedKey {
}

class Order {
    userId: string | null = null;
    countryId: string | null = null;
    userName: string | null = null;
    userEmail: string | null = null;
    countryName: string | null = null;
    displayName: string | null = null;
}

class User {
    id = '';
    name = '';
    email = '';
    countryId = '';
}

class ValidProfile extends ProfileOf<Order> {
    constructor() {
        super(Order);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf).of('userId')
            .for('userName')
            .for('userEmail', 'Email:upper')
            .for('countryName', 'Country?.Name')
            .for('displayName', c => c.when(() => true).expression('Name:invalid').otherwise('Email'));
    }
}

class InvalidExpressionsProfile extends ProfileOf<Order> {
    constructor() {
        super(Order);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf).of('userId')
            .for('userName', 'Name:invalid')
            .for('countryName', 'Country{Id, Name}')
            .for('userEmail', '   ');
    }
}

class ThrowingProfile extends ProfileOf<Order> {
    constructor() {
        super(Order);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf).of('' as never);
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

class MissingIdConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf);
    }
}

class DuplicatedExposedNameConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure(): void {
        this.id('id');
        this.useDistributedKey('DisplayOf');
        this.exposedName('name', 'Display');
        this.exposedName('email', 'Display');
    }
}

class UnusableExposedNamesConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure(): void {
        this.id('id');
        this.useDistributedKey('ContactOf');
        this.exposedName('email', 'User Email');
        this.exposedName('name', 'User.Name');
        this.exposedName('countryId', 'UserId');
    }
}

function summary(problems: readonly ValidationProblem[]): string[] {
    return problems.map(describeProblem);
}

describe('validateProfiles', () => {
    it('findsNothingInAValidProfile', () => {
        expect(validateProfiles([new ValidProfile()])).toEqual([]);
        expect(validateProfiles([defineProfile<Order>('OrderRow', p => p.useDistributedKey(UserOf).of('userId')
            .for('userName', 'Name'))])).toEqual([]);
    });

    it('reportsEachInvalidExpression', () => {
        const problems = validateProfiles([new InvalidExpressionsProfile()]);

        expect(problems).toEqual([
            {
                source: 'InvalidExpressionsProfile', property: 'userName', expression: 'Name:invalid',
                message: "Expression 'Name:invalid' is invalid: Unknown function 'invalid' at position 5",
            },
            {
                source: 'InvalidExpressionsProfile', property: 'countryName', expression: 'Country{Id, Name}',
                message: "Expression 'Country{Id, Name}' is invalid: Projection requires '.' before '{' at position 7",
            },
        ]);
    });

    it('namesAProfileOfDefineProfileByItsModel', () => {
        const problems = validateProfiles([defineProfile<Order>('OrderRow', p => p.useDistributedKey(UserOf)
            .of('userId').for('userEmail', 'Email:'))]);

        expect(summary(problems)).toEqual([
            "profile of OrderRow.userEmail: Expression 'Email:' is invalid: Expected function name after ':'. "
            + "Got 'EndOfExpression' at position 6",
        ]);
    });

    it('reportsAProfileThatCannotBeDeclared', () => {
        const problems = validateProfiles([new ThrowingProfile(), new ValidProfile()]);

        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatchObject({ source: 'ThrowingProfile', property: null, expression: null });
        expect(problems[0].message).toContain('of(...) needs the name of the key property.');
    });

    it('reportsTwoProfilesOfTheSameModel', () => {
        const problems = validateProfiles([new ValidProfile(), new InvalidExpressionsProfile()]);

        expect(problems[0]).toEqual({
            source: 'InvalidExpressionsProfile', property: null, expression: null,
            message: 'More than one profile is registered for Order.',
        });
    });

    it('reportsRulesWhoseKeysFillEachOther', () => {
        const problems = validateProfiles([defineProfile<Order>(Order, p => {
            p.useDistributedKey(UserOf).of('userId').for('countryId', 'CountryId');
            p.useDistributedKey('CountryOf').of('countryId').for('userId', 'OwnerId');
            p.useDistributedKey('CountryOf').of('countryId').for('countryName', 'Name');
            p.useDistributedKey(UserOf).of('userId').for('userName', 'Name');
        })]);

        expect(summary(problems)).toEqual([
            'profile of Order.countryId: The keys of countryId, userId are filled by each other: none of these rules '
            + 'can run first.',
        ]);
    });

    it('acceptsAChainOfKeys', () => {
        expect(validateProfiles([defineProfile<Order>(Order, p => {
            p.useDistributedKey('CountryOf').of('countryId').for('countryName', 'Name');
            p.useDistributedKey(UserOf).of('userId').for('countryId', 'CountryId');
        })])).toEqual([]);
    });

    it('needsAProfile', () => {
        expect(() => validateProfiles([null as never])).toThrow(TypeError);
    });
});

describe('validateEntities', () => {
    it('findsNothingInValidConfigurations', () => {
        expect(validateEntities([new UserConfig(),
            defineEntity(User, { key: 'CountryOf', id: 'countryId', exposedNames: { CountryName: 'name' } })]))
            .toEqual([]);
    });

    it('reportsAConfigurationThatCannotBeDeclared', () => {
        expect(summary(validateEntities([new MissingIdConfig(), new DuplicatedExposedNameConfig()]))).toEqual([
            expect.stringMatching(/^MissingIdConfig: .*User/),
            expect.stringMatching(/^DuplicatedExposedNameConfig: .*Display/),
        ]);
    });

    it('reportsTheExposedNamesAnExpressionCannotUse', () => {
        expect(validateEntities([new UnusableExposedNamesConfig()])).toEqual([
            {
                source: 'UnusableExposedNamesConfig', property: 'email', expression: 'User Email',
                message: "The exposed name 'User Email' cannot be used in an expression: it must be a name such as "
                    + 'UserEmail.',
            },
            {
                source: 'UnusableExposedNamesConfig', property: 'name', expression: 'User.Name',
                message: "The exposed name 'User.Name' cannot be used in an expression: it must be a name such as "
                    + 'UserEmail.',
            },
        ]);
    });

    it('reportsTwoConfigurationsOfTheSameKey', () => {
        const problems = validateEntities([new UserConfig(), defineEntity('Customer', { key: UserOf, id: 'id' })]);

        expect(summary(problems)).toEqual([
            'Customer: The distributed key UserOf is assigned to several entities: User, Customer.',
        ]);
    });

    it('needsAConfiguration', () => {
        expect(() => validateEntities([undefined as never])).toThrow(TypeError);
    });
});

describe('validateOrThrow', () => {
    it('passesWhenAllIsValid', () => {
        expect(() => validateOrThrow({ profiles: [new ValidProfile()], entities: [new UserConfig()] })).not.toThrow();
        expect(() => validateOrThrow({})).not.toThrow();
    });

    it('throwsWithEveryProblem', () => {
        let error: unknown;
        try {
            validateOrThrow({
                profiles: [new InvalidExpressionsProfile()],
                entities: [new UserConfig(), new UnusableExposedNamesConfig()],
            });
        } catch (thrown) {
            error = thrown;
        }

        expect(error).toBeInstanceOf(NfxMapValidationError);
        expect(error).toBeInstanceOf(DistributedMapError);
        const validation = error as NfxMapValidationError;
        expect(validation.problems).toHaveLength(4);
        expect(validation.message).toBe([
            'nfxmap found 4 problem(s):',
            " - InvalidExpressionsProfile.userName: Expression 'Name:invalid' is invalid: Unknown function 'invalid' "
            + 'at position 5',
            " - InvalidExpressionsProfile.countryName: Expression 'Country{Id, Name}' is invalid: Projection requires "
            + "'.' before '{' at position 7",
            " - UnusableExposedNamesConfig.email: The exposed name 'User Email' cannot be used in an expression: it "
            + 'must be a name such as UserEmail.',
            " - UnusableExposedNamesConfig.name: The exposed name 'User.Name' cannot be used in an expression: it "
            + 'must be a name such as UserEmail.',
        ].join('\n'));
    });
});

describe('isPlainName', () => {
    it.each([
        ['UserEmail', true], ['user_email', true], ['User.Email', false], ['Email?', false], ['Email:upper', false],
        ['true', false], ['', false], ['User Email', false],
    ])('%j is plain: %s', (name, plain) => {
        expect(isPlainName(name)).toBe(plain);
    });
});
