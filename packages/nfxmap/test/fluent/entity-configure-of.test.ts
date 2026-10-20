import { describe, expect, it } from 'vitest';
import {
    DistributedKey,
    DuplicatedNameByExposedNameError,
    EntityConfigureOf,
    EntityIdNotConfiguredError,
    InvalidDistributedKeyConfigurationError,
    InvalidEntitySelectorError,
} from '../../src/index.js';

class UserOf extends DistributedKey {
}

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string) {
    }
}

describe('EntityConfigureOf', () => {
    it('exposesItsConfiguration', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
                this.defaultProperty('name');
                this.useDistributedKey(UserOf);
                this.exposedName('email', 'UserEmail');
            }
        })();

        const definition = config.definition;
        expect(definition.entityType).toBe(User);
        expect(definition.idProperty).toBe('id');
        expect(definition.defaultProperty).toBe('name');
        expect(definition.key).toBe('UserOf');
        expect(definition.exposedNames).toEqual(new Map([['UserEmail', 'email']]));
    });

    it('needsAnId', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.useDistributedKey(UserOf);
            }
        })();

        expect(() => config.definition.key).toThrow(EntityIdNotConfiguredError);
    });

    it('needsADistributedKey', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
            }
        })();

        expect(() => config.definition.idProperty).toThrow(InvalidDistributedKeyConfigurationError);
    });

    it('rejectsAnIdDeclaredTwice', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
                this.id('name');
                this.useDistributedKey('UserOf');
            }
        })();

        expect(() => config.definition.key).toThrow(InvalidEntitySelectorError);
        expect(() => config.definition.key).toThrow('more than once');
    });

    it('rejectsAnExposedNameUsedTwice', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
                this.useDistributedKey('UserOf');
                this.exposedName('email', 'Alias');
                this.exposedName('name', 'Alias');
            }
        })();

        expect(() => config.definition.key).toThrow(DuplicatedNameByExposedNameError);
    });

    it('cannotBeChangedOutsideConfigure', () => {
        const config = new (class extends EntityConfigureOf<User> {
            constructor() {
                super(User);
            }

            protected configure(): void {
                this.id('id');
                this.useDistributedKey('UserOf');
            }

            later(): void {
                this.defaultProperty('name');
            }
        })();

        // JS: Java's IllegalStateException is a plain Error
        expect(() => config.later()).toThrow('only be configured inside configure()');
    });
});
