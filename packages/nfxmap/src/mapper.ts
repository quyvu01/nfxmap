import { type Headers, MapContext, type ServiceLookup } from './context.js';
import {
    AmbiguousProfileConfigurationError,
    ExpressionsFailedError,
    MaxNestingDepthReachedError,
    NoProfileError,
    NoRequestClientError,
    ValueWriteFailedError,
} from './errors.js';
import { type DistributedKeyLike, keyName } from './keys.js';
import { type SendBehavior, sendPipeline } from './pipeline.js';
import {
    type MappingRule,
    type ModelRef,
    type ProfileLike,
    modelName,
    profileDefinition,
} from './profile.js';
import { emptyItemsResponse, type DataResponse, type ItemsResponse, type MapRequest } from './responses.js';
import type { RetryPolicy } from './retry.js';
import type { RequestClient } from './transport.js';

/** Where the mapper reports what it does not throw. */
export interface Logger {
    warn(message: string, error?: unknown): void;
}

export interface DistributedMapperOptions {
    /** The profiles of the models to map. */
    readonly profiles?: readonly ProfileLike<any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    /** The transport that sends the requests; {@link LocalRequestClient} answers in the same process. */
    readonly requestClient?: RequestClient;
    /**
     * Throws the failures (failed requests, expressions the owner could not evaluate, values that cannot be written)
     * instead of logging them and leaving the properties alone. False by default, as in FxMap.
     */
    readonly throwIfException?: boolean;
    /** How many levels of mapped objects inside mapped objects are followed (default 128). */
    readonly maxNestingDepth?: number;
    /** Where conditional expressions find services, through `MapContext.service(...)`. */
    readonly services?: ServiceLookup;
    /** Behaviors around each request sent (FxMap's `AddSendPipelines`), in their order, inside the retries. */
    readonly sendBehaviors?: readonly SendBehavior[];
    /** Sends the failed requests again (FxMap's `SetRetryPolicy`); none by default. */
    readonly retryPolicy?: RetryPolicy;
    /** Where failures are logged when they are not thrown; `console` by default. */
    readonly logger?: Logger;
}

export interface MapOptions {
    /** Headers sent with every request of this call. */
    readonly headers?: Headers;
}

/**
 * Fills the properties declared by the profiles, on an object, an array or a whole object graph. Created with
 * {@link createDistributedMapper}.
 *
 * The ids of every object are batched: one request per distributed key and dependency level, whatever the number of
 * objects, carrying each distinct id once and each distinct expression once.
 */
export interface DistributedMapper {
    /**
     * Maps a value: an object whose class has a profile, an array, a `Set` or a `Map` of them, and the objects with
     * profiles that their properties hold. Plain objects without a profile (`{ data: orders }`) are looked into.
     */
    map(value: unknown, options?: MapOptions): Promise<void>;

    /**
     * Maps plain objects (or arrays of them) with the profile of `model`, a class or the name a profile was declared
     * with, whatever their own class; the objects they hold are then mapped by their own classes.
     */
    mapAs(model: ModelRef, value: unknown, options?: MapOptions): Promise<void>;

    /**
     * Maps only `properties` of `objects`, with the rules that fill them and the rules that fill the keys they read:
     * what a GraphQL field needs. The objects the values hold are left alone. `model` names the profile for plain
     * objects; by default each object's class gives it.
     */
    mapProperties(objects: Iterable<unknown>, properties: Iterable<string>,
                  options?: MapOptions & { readonly model?: ModelRef }): Promise<void>;

    /** The properties that have a rule, by model. */
    mappedProperties(): ReadonlyMap<ModelRef, ReadonlySet<string>>;

    /** Sends one request to the owner of `key`, without a profile. */
    fetch(key: DistributedKeyLike, request: MapRequest, options?: MapOptions): Promise<ItemsResponse>;
}

/** FxMap's default maximum nesting depth. */
export const DEFAULT_MAX_NESTING_DEPTH = 128;

/**
 * Builds the mapper:
 *
 * ```ts
 * const mapper = createDistributedMapper({
 *     profiles: [new OrderResponseProfile()],
 *     requestClient: natsClient,
 *     retryPolicy: RetryPolicy.retries(3).delay(200),
 *     throwIfException: true,
 * });
 *
 * await mapper.map(orders);
 * ```
 *
 * The profiles are read now: two profiles for the same model fail here rather than while mapping.
 */
export function createDistributedMapper(options: DistributedMapperOptions = {}): DistributedMapper {
    const plans = new Map<ModelRef, Plan>();
    for (const profile of options.profiles ?? []) {
        const definition = profileDefinition(profile);
        if (plans.has(definition.model)) throw new AmbiguousProfileConfigurationError(modelName(definition.model));
        plans.set(definition.model, planOf(definition.model, definition.rules));
    }

    const maxNestingDepth = options.maxNestingDepth ?? DEFAULT_MAX_NESTING_DEPTH;
    if (!Number.isInteger(maxNestingDepth) || maxNestingDepth < 1)
        throw new RangeError('maxNestingDepth must be a whole number, at least 1');
    if (options.requestClient === undefined && plans.size > 0) throw new NoRequestClientError();

    // As in FxMap, the retries are outside the other behaviors
    const behaviors: SendBehavior[] = [];
    if (options.retryPolicy !== undefined && options.retryPolicy.retries > 0)
        behaviors.push(options.retryPolicy.asBehavior());
    behaviors.push(...(options.sendBehaviors ?? []));
    const client = options.requestClient === undefined ? null : sendPipeline(options.requestClient, behaviors);

    return new Mapper(plans, client, options.throwIfException ?? false, maxNestingDepth, options.services,
        options.logger ?? console);
}

// A rule ready to run: `order` is 0 when its key is a plain property, n when its key is filled by a rule of order n-1
interface PlannedRule extends MappingRule {
    readonly order: number;
}

interface Plan {
    readonly model: ModelRef;
    readonly name: string;
    readonly rules: readonly PlannedRule[];
    /** The properties that rules read or write: the other properties may hold objects to map. */
    readonly ruleProperties: ReadonlySet<string>;
}

function planOf(model: ModelRef, rules: readonly MappingRule[]): Plan {
    const byTarget = new Map(rules.map(rule => [rule.targetProperty, rule] as const));
    // The number of rules to run before this one: its key may be the target of another rule, whose key may be the
    // target of yet another... A cycle stops the chain.
    const orderOf = (rule: MappingRule, visited: Set<string>): number => {
        if (visited.has(rule.targetProperty)) return 0;
        visited.add(rule.targetProperty);
        const dependency = byTarget.get(rule.selectorProperty);
        if (dependency === undefined || dependency === rule) return 0;
        return 1 + orderOf(dependency, visited);
    };
    const planned = rules.map(rule => Object.freeze({ ...rule, order: orderOf(rule, new Set()) }));
    const ruleProperties = new Set(rules.flatMap(rule => [rule.selectorProperty, rule.targetProperty]));
    return { model, name: modelName(model), rules: planned, ruleProperties };
}

// One property to fill on one object
interface Descriptor {
    readonly rule: PlannedRule;
    readonly plan: Plan;
    readonly model: Record<string, unknown>;
    // The expression for this call: the rule's own, or the one its condition chose
    expression: string | null;
}

interface KeyResponse {
    readonly key: string;
    readonly response: ItemsResponse;
}

class Mapper implements DistributedMapper {
    private readonly plansByClass = new Map<Function, Plan | null>(); // eslint-disable-line @typescript-eslint/ban-types

    constructor(private readonly plans: ReadonlyMap<ModelRef, Plan>,
                private readonly client: RequestClient | null,
                private readonly throwIfException: boolean,
                private readonly maxNestingDepth: number,
                private readonly services: ServiceLookup | undefined,
                private readonly logger: Logger) {
    }

    async map(value: unknown, options: MapOptions = {}): Promise<void> {
        await this.mapLevel(this.discover(value, null), this.context(options), 0);
    }

    async mapAs(model: ModelRef, value: unknown, options: MapOptions = {}): Promise<void> {
        await this.mapLevel(this.discover(value, this.requirePlan(model)), this.context(options), 0);
    }

    async mapProperties(objects: Iterable<unknown>, properties: Iterable<string>,
                        options: MapOptions & { readonly model?: ModelRef } = {}): Promise<void> {
        const plan = options.model === undefined ? null : this.requirePlan(options.model);
        const targets = new Set(properties);
        const descriptors: Descriptor[] = [];
        const visited = new Set<unknown>();
        for (const object of objects) {
            if (object === null || typeof object !== 'object' || visited.has(object)) continue;
            visited.add(object);
            const objectPlan = plan ?? this.planOfClass(object);
            if (objectPlan === null) continue;
            for (const rule of rulesFor(objectPlan, targets))
                descriptors.push({ rule, plan: objectPlan, model: object as Record<string, unknown>, expression: null });
        }
        await this.mapOrders(descriptors, this.context(options));
    }

    mappedProperties(): ReadonlyMap<ModelRef, ReadonlySet<string>> {
        const mapped = new Map<ModelRef, ReadonlySet<string>>();
        for (const [model, plan] of this.plans) mapped.set(model, new Set(plan.rules.map(rule => rule.targetProperty)));
        return mapped;
    }

    async fetch(key: DistributedKeyLike, request: MapRequest, options: MapOptions = {}): Promise<ItemsResponse> {
        if (this.client === null) throw new NoRequestClientError();
        const ids = [...new Set(request.selectorIds.filter(id => id !== null && id !== undefined))];
        const distinct: MapRequest = { selectorIds: ids, expressions: [...new Set(request.expressions)] };
        return this.send(keyName(key), distinct, this.context(options));
    }

    private context(options: MapOptions): MapContext {
        return new MapContext(options.headers ?? {}, this.services);
    }

    private requirePlan(model: ModelRef): Plan {
        const plan = this.plans.get(model);
        if (plan === undefined) throw new NoProfileError(modelName(model));
        return plan;
    }

    private async mapLevel(descriptors: Descriptor[], context: MapContext, depth: number): Promise<void> {
        // Nothing left to map (the next level only holds empty arrays...): done, whatever the depth
        if (descriptors.length === 0) return;
        if (depth >= this.maxNestingDepth) {
            if (this.throwIfException) throw new MaxNestingDepthReachedError(this.maxNestingDepth);
            return;
        }

        await this.mapOrders(descriptors, context);

        const next: unknown[] = [];
        for (const descriptor of descriptors) {
            const value = descriptor.model[descriptor.rule.targetProperty];
            if (isWalkable(value)) next.push(value);
        }
        if (next.length > 0) await this.mapLevel(this.discover(next, null), context, depth + 1);
    }

    // The rules of one level of objects, by dependency order: an order reads the keys the previous one wrote
    private async mapOrders(descriptors: Descriptor[], context: MapContext): Promise<void> {
        const byOrder = new Map<number, Descriptor[]>();
        for (const descriptor of descriptors) {
            const level = byOrder.get(descriptor.rule.order);
            if (level === undefined) byOrder.set(descriptor.rule.order, [descriptor]);
            else level.push(descriptor);
        }
        for (const order of [...byOrder.keys()].sort((a, b) => a - b)) await this.mapOrder(byOrder.get(order)!, context);
    }

    private async mapOrder(descriptors: Descriptor[], context: MapContext): Promise<void> {
        const byKey = new Map<string, Descriptor[]>();
        for (const descriptor of descriptors) {
            const group = byKey.get(descriptor.rule.key);
            if (group === undefined) byKey.set(descriptor.rule.key, [descriptor]);
            else group.push(descriptor);
        }
        const responses = await Promise.all([...byKey].map(([key, group]) => this.fetchGroup(key, group, context)));
        this.writeBack(descriptors, responses);
    }

    private async fetchGroup(key: string, group: Descriptor[], context: MapContext): Promise<KeyResponse> {
        // Each distinct id once, whatever the number of objects that share it
        const ids = new Set<string>();
        for (const descriptor of group) {
            const id = idOf(descriptor);
            if (id !== null) ids.add(id);
        }

        await Promise.all(group.map(async descriptor => {
            descriptor.expression = descriptor.rule.conditional === null
                ? descriptor.rule.expression
                : await descriptor.rule.conditional.resolve(context);
        }));

        if (ids.size === 0) return { key, response: emptyItemsResponse };
        const expressions = [...new Set(group.map(descriptor => descriptor.expression))];
        return { key, response: await this.send(key, { selectorIds: [...ids], expressions }, context) };
    }

    private async send(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        try {
            if (this.client === null) throw new NoRequestClientError();
            return (await this.client.request(key, request, context)) ?? emptyItemsResponse;
        } catch (error) {
            if (this.throwIfException) throw error;
            this.logger.warn(`The request for the distributed key ${key} failed; its properties are not mapped.`, error);
            return emptyItemsResponse;
        }
    }

    private writeBack(descriptors: Descriptor[], responses: KeyResponse[]): void {
        // The owner could not evaluate some expressions: throw with all of them, or log them and leave the properties
        // of these expressions alone
        const failed = new Set<string>();
        const rows = new Map<string, Map<string, DataResponse>>();
        for (const { key, response } of responses) {
            if (response.errors.length > 0) {
                if (this.throwIfException) throw new ExpressionsFailedError(key, response.errors);
                for (const error of response.errors) {
                    failed.add(failureKey(key, error.expression));
                    this.logger.warn(`${error.message} (distributed key ${key}); the properties of this expression are `
                        + 'not mapped.');
                }
            }
            let byId = rows.get(key);
            if (byId === undefined) rows.set(key, (byId = new Map()));
            for (const item of response.items) if (!byId.has(item.id)) byId.set(item.id, item);
        }

        // The keys are read before any value is written: a rule may fill a property that the key of another rule of
        // the same level reads
        const ids = descriptors.map(idOf);

        descriptors.forEach((descriptor, i) => {
            const id = ids[i];
            if (id === null) return;
            const { rule } = descriptor;
            if (failed.has(failureKey(rule.key, descriptor.expression))) return;
            const row = rows.get(rule.key)?.get(id);
            const value = row?.values.find(v => (v.expression ?? null) === descriptor.expression)?.value ?? null;
            if (value === null) return;
            try {
                const parsed: unknown = JSON.parse(value);
                descriptor.model[rule.targetProperty] = rule.convert === null ? parsed : rule.convert(parsed);
            } catch (error) {
                const failure = new ValueWriteFailedError(descriptor.plan.name, rule.targetProperty, error);
                if (this.throwIfException) throw failure;
                this.logger.warn(failure.message, error);
            }
        });
    }

    /**
     * Every property with a rule in the object graph below `root`. Iterative, so the depth of the graph is not
     * limited by the call stack; each object is visited once, whatever the number of paths leading to it. `rootPlan`
     * is the plan of the root objects, when it is not given by their class.
     */
    private discover(root: unknown, rootPlan: Plan | null): Descriptor[] {
        const descriptors: Descriptor[] = [];
        const visited = new Set<object>();
        const pending: { value: unknown; plan: Plan | null }[] = [];
        if (isWalkable(root)) pending.push({ value: root, plan: rootPlan });

        while (pending.length > 0) {
            const { value: current, plan: given } = pending.pop()!;
            const object = current as object;
            if (isContainer(object)) {
                for (const item of containerValues(object))
                    if (isWalkable(item)) pending.push({ value: item, plan: given });
                continue;
            }
            if (visited.has(object)) continue;
            visited.add(object);

            const plan = given ?? this.planOfClass(object);
            if (plan === null) {
                // A plain object without a profile (a response envelope...) may hold objects with profiles
                if (isPlainObject(object))
                    for (const value of Object.values(object)) if (isWalkable(value)) pending.push({ value, plan: null });
                continue;
            }
            const model = object as Record<string, unknown>;
            for (const rule of plan.rules) descriptors.push({ rule, plan, model, expression: null });
            // The other properties may hold objects with profiles of their own
            for (const property of Object.keys(model)) {
                if (plan.ruleProperties.has(property)) continue;
                const value = model[property];
                if (isWalkable(value)) pending.push({ value, plan: null });
            }
        }
        return descriptors;
    }

    // The profile of the class of the object, or else of its nearest superclass that has one
    private planOfClass(object: object): Plan | null {
        const type = object.constructor;
        if (typeof type !== 'function' || type === Object) return null;
        let plan = this.plansByClass.get(type);
        if (plan === undefined) {
            plan = null;
            for (let c: unknown = type; typeof c === 'function' && c !== Function.prototype; c = Object.getPrototypeOf(c)) {
                const found = this.plans.get(c as ModelRef);
                if (found !== undefined) {
                    plan = found;
                    break;
                }
            }
            this.plansByClass.set(type, plan);
        }
        return plan;
    }
}

/** The rules of `targets`, and the rules that fill the keys they read, transitively. */
function rulesFor(plan: Plan, targets: ReadonlySet<string>): PlannedRule[] {
    const byTarget = new Map(plan.rules.map(rule => [rule.targetProperty, rule] as const));
    const needed = new Set<PlannedRule>();
    const pending = [...targets].map(target => byTarget.get(target)).filter(rule => rule !== undefined);
    while (pending.length > 0) {
        const rule = pending.pop()!;
        if (needed.has(rule)) continue;
        needed.add(rule);
        const dependency = byTarget.get(rule.selectorProperty);
        if (dependency !== undefined) pending.push(dependency);
    }
    return plan.rules.filter(rule => needed.has(rule));
}

function idOf(descriptor: Descriptor): string | null {
    const id = descriptor.model[descriptor.rule.selectorProperty];
    return id === null || id === undefined ? null : String(id);
}

function failureKey(key: string, expression: string | null): string {
    return JSON.stringify([key, expression]);
}

/** Whether a value can hold an object to map: not a primitive, a date, a buffer, a function... */
function isWalkable(value: unknown): value is object {
    if (value === null || typeof value !== 'object') return false;
    return !(value instanceof Date || value instanceof RegExp || value instanceof Promise || ArrayBuffer.isView(value)
        || value instanceof ArrayBuffer || value instanceof Error);
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function isContainer(value: object): boolean {
    return Array.isArray(value) || value instanceof Set || value instanceof Map;
}

function containerValues(value: object): Iterable<unknown> {
    if (value instanceof Map) return value.values();
    return value as Iterable<unknown>;
}
