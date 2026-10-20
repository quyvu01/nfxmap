import {
    DuplicatedNameByExposedNameError,
    EntityIdNotConfiguredError,
    InvalidDistributedKeyConfigurationError,
    InvalidEntitySelectorError,
} from './errors.js';
import { type DistributedKeyLike, keyName } from './keys.js';
import type { Constructor, PropertyKeyOf } from './profile.js';

/** How an entity is exposed to the mapping engine, as the handlers take it. */
export interface EntityDefinition<T = unknown> {
    /** The class of the entity, when it has one: the exposed names apply to its instances wherever they are. */
    readonly entityType: Constructor<T> | null;
    /** A name for messages. */
    readonly name: string;
    readonly key: string;
    readonly idProperty: string;
    /** The property returned when a rule has no expression, or `null` when there is none. */
    readonly defaultProperty: string | null;
    /** The exposed names, each mapped to the property it stands for. */
    readonly exposedNames: ReadonlyMap<string, string>;
}

/**
 * Declares how an entity is exposed to the mapping engine (owner side):
 *
 * ```ts
 * class UserConfig extends EntityConfigureOf<User> {
 *     constructor() {
 *         super(User);
 *     }
 *
 *     protected configure() {
 *         this.id('id');                         // required
 *         this.defaultProperty('name');          // returned when a rule has no expression
 *         this.useDistributedKey(UserOf);        // required: a class or a string ('UserOf')
 *         this.exposedName('email', 'UserEmail');
 *     }
 * }
 * ```
 */
export abstract class EntityConfigureOf<T> {
    private draft: Draft | null = null;
    private resolved: EntityDefinition<T> | null = null;

    /**
     * @param entityType the class of the entity, or a name for plain objects
     */
    protected constructor(private readonly entityType: Constructor<T> | string) {
    }

    /** Declares the id, the distributed key, and optionally the default property and the exposed names. */
    protected abstract configure(): void;

    /** The property that identifies the entity. Required, once. */
    protected id(property: PropertyKeyOf<T>): void {
        this.current().id(property);
    }

    /** The property returned when a rule has no expression. */
    protected defaultProperty(property: PropertyKeyOf<T>): void {
        this.current().defaultProperty(property);
    }

    /** Exposes a property under another name, which expressions may use. */
    protected exposedName(property: PropertyKeyOf<T>, exposedName: string): void {
        this.current().exposedName(property, exposedName);
    }

    /** Links the entity to a distributed key. Required, once. */
    protected useDistributedKey(key: DistributedKeyLike): void {
        this.current().useDistributedKey(key);
    }

    /** The configuration, declared by `configure()` on the first call. */
    get definition(): EntityDefinition<T> {
        if (this.resolved === null) {
            const draft = new Draft(this.entityType, this.constructor.name);
            this.draft = draft;
            try {
                this.configure();
            } finally {
                this.draft = null;
            }
            this.resolved = draft.build<T>();
        }
        return this.resolved;
    }

    private current(): Draft {
        if (this.draft === null) throw new Error('The entity can only be configured inside configure().');
        return this.draft;
    }
}

/** What {@link defineEntity} takes. */
export interface EntityOptions<T> {
    readonly key: DistributedKeyLike;
    readonly id: PropertyKeyOf<T>;
    readonly defaultProperty?: PropertyKeyOf<T>;
    /** The exposed names, each with the property it stands for: `{ UserEmail: 'email' }`. */
    readonly exposedNames?: Readonly<Record<string, PropertyKeyOf<T>>>;
}

/**
 * Declares an entity without a class:
 *
 * ```ts
 * const userConfig = defineEntity(User, { key: 'UserOf', id: 'id', defaultProperty: 'name',
 *                                         exposedNames: { UserEmail: 'email' } });
 * ```
 */
export function defineEntity<T>(entityType: Constructor<T> | string, options: EntityOptions<T>): EntityDefinition<T> {
    const draft = new Draft(entityType, 'defineEntity');
    draft.id(options.id);
    if (options.defaultProperty !== undefined) draft.defaultProperty(options.defaultProperty);
    draft.useDistributedKey(options.key);
    for (const [exposed, property] of Object.entries(options.exposedNames ?? {})) draft.exposedName(property, exposed);
    return draft.build<T>();
}

/** An entity configuration as the handlers take it: an {@link EntityConfigureOf} or a {@link defineEntity} result. */
export type EntityConfig<T = unknown> = EntityConfigureOf<T> | EntityDefinition<T>;

export function entityDefinition<T>(config: EntityConfig<T>): EntityDefinition<T> {
    return config instanceof EntityConfigureOf ? config.definition : config;
}

class Draft {
    private readonly name: string;
    private idProperty: string | null = null;
    private defaultPropertyName: string | null = null;
    private key: string | null = null;
    private readonly exposedNames = new Map<string, string>();

    constructor(private readonly entityType: Constructor | string, private readonly configName: string) {
        this.name = typeof entityType === 'string' ? entityType : entityType.name || 'entity';
    }

    id(property: string): void {
        this.idProperty = this.selector(property, 'id', this.idProperty);
    }

    defaultProperty(property: string): void {
        this.defaultPropertyName = this.selector(property, 'defaultProperty', this.defaultPropertyName);
    }

    exposedName(property: string, exposedName: string): void {
        if (typeof exposedName !== 'string' || exposedName.length === 0)
            throw new InvalidEntitySelectorError(this.name, 'exposedName', 'the exposed name is empty.');
        const name = this.selector(property, 'exposedName', null);
        if (this.exposedNames.has(exposedName)) throw new DuplicatedNameByExposedNameError(this.name, exposedName);
        this.exposedNames.set(exposedName, name);
    }

    useDistributedKey(key: DistributedKeyLike): void {
        if (this.key !== null) throw new InvalidDistributedKeyConfigurationError(this.configName);
        this.key = keyName(key);
    }

    build<T>(): EntityDefinition<T> {
        if (this.idProperty === null) throw new EntityIdNotConfiguredError(this.name);
        if (this.key === null) throw new InvalidDistributedKeyConfigurationError(this.configName);
        return Object.freeze({
            entityType: typeof this.entityType === 'function' ? this.entityType as Constructor<T> : null,
            name: this.name,
            key: this.key,
            idProperty: this.idProperty,
            defaultProperty: this.defaultPropertyName,
            exposedNames: this.exposedNames,
        });
    }

    private selector(property: string, selectorName: string, alreadyDeclared: string | null): string {
        if (alreadyDeclared !== null)
            throw new InvalidEntitySelectorError(this.name, selectorName, 'it is declared more than once.');
        if (typeof property !== 'string' || property.length === 0)
            throw new InvalidEntitySelectorError(this.name, selectorName, 'the property name is empty.');
        return property;
    }
}
