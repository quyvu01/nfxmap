import type { MapContext } from './context.js';
import { type EntityConfig, type EntityDefinition, entityDefinition } from './entity.js';
import { DistributedKeyAssignedToMultipleEntitiesError, NoHandlerForDistributedKeyError } from './errors.js';
import { ExpressionEvaluationError } from './expressions/errors.js';
import { type PropertyAccessor, defaultPropertyAccessor, ExpressionEvaluator } from './expressions/evaluator.js';
import type { ExpressionNode } from './expressions/nodes.js';
import { ExpressionParseError, parseExpression } from './expressions/parser.js';
import { ExpressionTokenizeError } from './expressions/tokenizer.js';
import { writeJson } from './json.js';
import type { DataResponse, ExpressionError, ItemsResponse, MapRequest, ValueResponse } from './responses.js';
import type { QueryHandler, RequestClient } from './transport.js';

export interface EvaluationOptions {
    /** Gives now, for `:daysAgo`; the system clock by default. */
    readonly now?: () => Date;
}

/**
 * Answers a {@link MapRequest} from entities already loaded, as configured by an entity configuration. The
 * {@link InMemoryQueryHandler} and the data providers share it, so that every owner evaluates expressions the same way.
 *
 * A `null` expression gives the default property. An exposed name (`UserEmail`) stands for its property on the entity,
 * and on every instance of the entity class in the expression. An expression that does not parse or cannot be
 * evaluated on one of the entities is reported as an {@link ExpressionError}; the other expressions are still
 * answered.
 */
export class EntityExpressionEvaluator<T> {
    readonly definition: EntityDefinition<T>;
    private readonly now: (() => Date) | undefined;

    constructor(config: EntityConfig<T>, options: EvaluationOptions = {}) {
        this.definition = entityDefinition(config);
        this.now = options.now;
    }

    /**
     * Evaluates the expressions of the request on the entity of each requested id.
     *
     * @param lookup gives the entity of a requested id, or null/undefined when there is none; the ids without an entity
     *               are left out of the response
     */
    answer(request: MapRequest, lookup: (id: string) => T | null | undefined): ItemsResponse {
        const { defaultProperty, name } = this.definition;
        const errors = new Map<string | null, ExpressionError>();
        // Each expression is parsed once per request; null stands for the default property
        const parsed = new Map<string, ExpressionNode>();
        for (const expression of request.expressions) {
            if (expression === null) {
                if (defaultProperty === null)
                    errors.set(null, { expression: null, message: `${name} has no default property: give the rule an expression.` });
                continue;
            }
            try {
                parsed.set(expression, parseExpression(expression));
            } catch (e) {
                if (!(e instanceof ExpressionParseError || e instanceof ExpressionTokenizeError)) throw e;
                errors.set(expression, { expression, message: e.message });
            }
        }

        const items: DataResponse[] = [];
        for (const id of request.selectorIds) {
            const entity = lookup(id);
            if (entity === null || entity === undefined) continue;
            const evaluator = new ExpressionEvaluator({ accessor: this.accessorFor(entity), now: this.now });
            const values: ValueResponse[] = [];
            for (const expression of request.expressions) {
                if (errors.has(expression)) continue;
                try {
                    const value = expression === null
                        ? (entity as Record<string, unknown>)[defaultProperty!]
                        : evaluator.evaluate(parsed.get(expression)!, entity);
                    values.push({ expression, value: value === null || value === undefined ? null : writeJson(value) });
                } catch (e) {
                    if (!(e instanceof ExpressionEvaluationError)) throw e;
                    errors.set(expression, { expression, message: e.message });
                }
            }
            items.push({ id, values });
        }

        // An expression that failed on a later entity is dropped from the earlier ones too
        const answered = errors.size === 0 ? items
            : items.map(item => ({ id: item.id, values: item.values.filter(v => !errors.has(v.expression)) }));
        return { items: answered, errors: [...errors.values()] };
    }

    // The exposed names apply to the entity, and to the instances of its class anywhere in the expression
    private accessorFor(entity: T): PropertyAccessor {
        const { entityType, exposedNames } = this.definition;
        if (exposedNames.size === 0) return defaultPropertyAccessor;
        return (target, name) => {
            if (target === entity || (entityType !== null && target instanceof entityType)) {
                const property = exposedNames.get(name);
                if (property !== undefined) return defaultPropertyAccessor(target, property);
            }
            return defaultPropertyAccessor(target, name);
        };
    }
}

/** Gives the entities on each request. */
export type EntitySource<T> = Iterable<T> | (() => Iterable<T> | Promise<Iterable<T>>);

/**
 * Answers requests from entities held in memory, as configured by an entity configuration: for tests, samples, and
 * services whose data fits in memory. The whole expression language is supported.
 */
export class InMemoryQueryHandler<T> implements QueryHandler {
    readonly key: string;
    readonly entityName: string;
    private readonly evaluator: EntityExpressionEvaluator<T>;

    constructor(config: EntityConfig<T>, private readonly entities: EntitySource<T>, options: EvaluationOptions = {}) {
        this.evaluator = new EntityExpressionEvaluator(config, options);
        this.key = this.evaluator.definition.key;
        this.entityName = this.evaluator.definition.name;
    }

    async handle(request: MapRequest, _context?: MapContext): Promise<ItemsResponse> {
        const entities = typeof this.entities === 'function' ? await this.entities() : this.entities;
        const idProperty = this.evaluator.definition.idProperty;
        const byId = new Map<string, T>();
        for (const entity of entities) {
            const id = (entity as Record<string, unknown>)[idProperty];
            if (id === null || id === undefined) continue;
            const text = String(id);
            if (!byId.has(text)) byId.set(text, entity);
        }
        return this.evaluator.answer(request, id => byId.get(id));
    }
}

/**
 * A {@link RequestClient} that answers in the same process, from registered {@link QueryHandler}s: for tests, and for a
 * service that is both the consumer and the owner of an entity.
 */
export class LocalRequestClient implements RequestClient {
    readonly transport = 'local';
    private readonly handlers = new Map<string, QueryHandler>();

    constructor(...handlers: QueryHandler[]) {
        for (const handler of handlers) this.register(handler);
    }

    /**
     * Registers a handler.
     *
     * @throws DistributedKeyAssignedToMultipleEntitiesError when its key already has a handler
     */
    register(handler: QueryHandler): this {
        const existing = this.handlers.get(handler.key);
        if (existing !== undefined)
            throw new DistributedKeyAssignedToMultipleEntitiesError(handler.key, [existing.entityName, handler.entityName]);
        this.handlers.set(handler.key, handler);
        return this;
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        const handler = this.handlers.get(key);
        if (handler === undefined) throw new NoHandlerForDistributedKeyError(key);
        return handler.handle(request, context);
    }
}
