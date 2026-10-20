import type { MapContext } from './context.js';
import { InvalidProfileSelectorError } from './errors.js';
import { type DistributedKeyLike, keyName } from './keys.js';

/** A class, as a type: what a profile or an entity configuration is declared for. */
export type Constructor<T = unknown> = abstract new (...args: never[]) => T;

/** The names of the properties of a type, as strings. */
export type PropertyKeyOf<T> = Extract<keyof T, string>;

/** A value that may come later. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The model of a profile: a class, whose instances (and the instances of its subclasses) the mapper finds anywhere in
 * the objects it maps, or a name, for plain objects that are mapped with `mapper.mapAs(name, objects)`.
 */
export type ModelRef<T = unknown> = Constructor<T> | string;

/** An expression chosen when the mapping runs (FxMap's `If(...).Expression(...).Else(...)`). */
export interface ConditionalExpression {
    resolve(context: MapContext): Promise<string | null>;
}

/** Options of one rule. */
export interface RuleOptions {
    /**
     * Turns the value received, parsed from JSON, into the value written: a `Date` from an ISO string, an instance
     * of a class with its own profile (whose properties are then mapped in turn)...
     */
    readonly convert?: (value: unknown) => unknown;
}

/**
 * One rule of a profile: fill `targetProperty` with `expression` evaluated on the entity whose id is in
 * `selectorProperty`.
 */
export interface MappingRule {
    /** The distributed key of the entity. */
    readonly key: string;
    /** The property holding the id (the foreign key). */
    readonly selectorProperty: string;
    /** The property to fill. */
    readonly targetProperty: string;
    /** The expression, or `null` for the default property of the entity. */
    readonly expression: string | null;
    /** The expression chosen at mapping time, or `null` when `expression` is fixed. */
    readonly conditional: ConditionalExpression | null;
    readonly convert: ((value: unknown) => unknown) | null;
}

/** The rules of a model, as the mapper takes them. */
export interface ProfileDefinition<T = unknown> {
    readonly model: ModelRef<T>;
    readonly rules: readonly MappingRule[];
}

/**
 * Builds a {@link ConditionalExpression}:
 *
 * ```ts
 * .for('displayName', c => c
 *     .when(ctx => 'x-admin' in ctx.headers)
 *     .expression('UserEmail:upper')
 *     .otherwise('Name'))
 * ```
 *
 * Each step takes a value or a function of the {@link MapContext}, which may return a promise.
 */
export class ConditionalExpressionBuilder {
    private condition: ((context: MapContext) => MaybePromise<boolean>) | null = null;
    private thenExpression: ((context: MapContext) => MaybePromise<string | null>) | null = null;
    private elseExpression: ((context: MapContext) => MaybePromise<string | null>) | null = null;

    /** The condition, checked once per mapping call. */
    when(condition: (context: MapContext) => MaybePromise<boolean>): {
        expression(expression: string | null | ((context: MapContext) => MaybePromise<string | null>)): {
            otherwise(expression: string | null | ((context: MapContext) => MaybePromise<string | null>)): void;
        };
    } {
        this.condition = condition;
        return {
            expression: thenExpression => {
                this.thenExpression = asFunction(thenExpression);
                return {
                    otherwise: elseExpression => {
                        this.elseExpression = asFunction(elseExpression);
                    },
                };
            },
        };
    }

    /** @internal */
    build(modelName: string): ConditionalExpression {
        const { condition, thenExpression, elseExpression } = this;
        if (condition === null || thenExpression === null || elseExpression === null)
            throw new InvalidProfileSelectorError(modelName,
                'a conditional rule needs when(...).expression(...).otherwise(...).');
        return {
            async resolve(context) {
                return (await condition(context)) === true ? thenExpression(context) : elseExpression(context);
            },
        };
    }
}

function asFunction(expression: string | null | ((context: MapContext) => MaybePromise<string | null>)) {
    return typeof expression === 'function' ? expression : () => expression;
}

/** The step after `useDistributedKey(...)`: name the property that holds the id. */
export class DistributedKeyRuleBuilder<T> {
    /** @internal */
    constructor(private readonly modelName: string, private readonly key: string,
                private readonly sink: (rule: MappingRule) => void) {
    }

    /** The property of the model that holds the id of the entity (the foreign key), such as `'userId'`. */
    of(selector: PropertyKeyOf<T>): PropertyRuleBuilder<T> {
        if (typeof selector !== 'string' || selector.length === 0)
            throw new InvalidProfileSelectorError(this.modelName, 'of(...) needs the name of the key property.');
        return new PropertyRuleBuilder<T>(this.modelName, this.key, selector, this.sink);
    }
}

/** Declares the properties filled from one distributed key (FxMap's `.For(...)`). */
export class PropertyRuleBuilder<T> {
    /** @internal */
    constructor(private readonly modelName: string, private readonly key: string,
                private readonly selectorProperty: string, private readonly sink: (rule: MappingRule) => void) {
    }

    /**
     * Fills `target` with an expression evaluated on the entity, such as `'Country.Name'`; with the default property
     * of the entity when there is none; or with an expression chosen when the mapping runs.
     */
    for(target: PropertyKeyOf<T>,
        expression?: string | null | ((builder: ConditionalExpressionBuilder) => void),
        options: RuleOptions = {}): this {
        if (typeof target !== 'string' || target.length === 0)
            throw new InvalidProfileSelectorError(this.modelName, 'for(...) needs the name of the target property.');
        let fixed: string | null = null;
        let conditional: ConditionalExpression | null = null;
        if (typeof expression === 'function') {
            const builder = new ConditionalExpressionBuilder();
            expression(builder);
            conditional = builder.build(this.modelName);
        } else {
            fixed = expression ?? null;
        }
        this.sink({
            key: this.key,
            selectorProperty: this.selectorProperty,
            targetProperty: target,
            expression: fixed,
            conditional,
            convert: options.convert ?? null,
        });
        return this;
    }
}

/** The steps of a profile declaration, given to `defineProfile`. */
export interface ProfileBuilder<T> {
    /** Starts the rules of an entity identified by a distributed key. */
    useDistributedKey(key: DistributedKeyLike): DistributedKeyRuleBuilder<T>;
}

/**
 * Declares how the properties of a model are filled from distributed keys (consumer side):
 *
 * ```ts
 * class OrderResponseProfile extends ProfileOf<OrderResponse> {
 *     constructor() {
 *         super(OrderResponse);
 *     }
 *
 *     protected configure() {
 *         this.useDistributedKey(UserOf)
 *             .of('userId')
 *             .for('userName')                       // the default property of the entity
 *             .for('userEmail', 'Email')             // a property or an exposed name
 *             .for('countryName', 'Country.Name');   // a navigation
 *     }
 * }
 * ```
 *
 * A rule may read a key that another rule fills (`.of('provinceId')` after `.for('provinceId', ...)`): the rules are
 * ordered by these dependencies, whatever their order in `configure()`. The last rule for a property wins.
 */
export abstract class ProfileOf<T> {
    private collected: MappingRule[] | null = null;
    private declared: ProfileDefinition<T> | null = null;

    protected constructor(readonly model: ModelRef<T>) {
        modelName(model);
    }

    /** Declares the rules with {@link useDistributedKey}. */
    protected abstract configure(): void;

    /** Starts the rules of an entity identified by a distributed key. */
    protected useDistributedKey(key: DistributedKeyLike): DistributedKeyRuleBuilder<T> {
        return new DistributedKeyRuleBuilder<T>(modelName(this.model), keyName(key), rule => this.add(rule));
    }

    /** The rules declared in `configure()`, which runs once, on the first call. */
    get definition(): ProfileDefinition<T> {
        if (this.declared === null) {
            this.collected = [];
            try {
                this.configure();
                this.declared = Object.freeze({ model: this.model, rules: Object.freeze([...this.collected]) });
            } finally {
                this.collected = null;
            }
        }
        return this.declared;
    }

    private add(rule: MappingRule): void {
        if (this.collected === null) throw new Error('Rules can only be declared inside configure().');
        addRule(this.collected, rule);
    }
}

/**
 * Declares a profile without a class:
 *
 * ```ts
 * const orderProfile = defineProfile(OrderResponse, p => p
 *     .useDistributedKey('UserOf')
 *     .of('userId')
 *     .for('userName')
 *     .for('userEmail', 'Email'));
 * ```
 */
export function defineProfile<T>(model: ModelRef<T>, configure: (profile: ProfileBuilder<T>) => unknown):
    ProfileDefinition<T> {
    const name = modelName(model);
    const rules: MappingRule[] = [];
    let open = true;
    configure({
        useDistributedKey: key => new DistributedKeyRuleBuilder<T>(name, keyName(key), rule => {
            if (!open) throw new Error('Rules can only be declared inside the configure function of defineProfile.');
            addRule(rules, rule);
        }),
    });
    open = false;
    return Object.freeze({ model, rules: Object.freeze(rules) });
}

/** A profile as the mapper takes it: a {@link ProfileOf} or a {@link defineProfile} result. */
export type ProfileLike<T = unknown> = ProfileOf<T> | ProfileDefinition<T>;

export function profileDefinition<T>(profile: ProfileLike<T>): ProfileDefinition<T> {
    return profile instanceof ProfileOf ? profile.definition : profile;
}

/** The name of a model, for messages. */
export function modelName(model: ModelRef): string {
    if (typeof model === 'function' && model.name) return model.name;
    if (typeof model === 'string' && model.length > 0) return model;
    throw new TypeError('A profile needs a model: a named class, or a name for plain objects.');
}

// The last rule for a property wins, as in FxMap
function addRule(rules: MappingRule[], rule: MappingRule): void {
    const index = rules.findIndex(r => r.targetProperty === rule.targetProperty);
    if (index >= 0) rules.splice(index, 1);
    rules.push(Object.freeze(rule));
}
