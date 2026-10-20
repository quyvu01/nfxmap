import {
    type EntityConfig,
    type EntityDefinition,
    EntityExpressionEvaluator,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    type QueryHandler,
} from 'nfxmap';
import { type ExpressionNode, parseExpression } from 'nfxmap/expressions';
import { type DataSource, type EntityMetadata, In } from 'typeorm';
type EmbeddedMetadata = EntityMetadata['embeddeds'][number];
import { EntityNotManagedError, IdColumnNotFoundError, UnsupportedIdTypeError } from './errors.js';

export interface TypeOrmQueryHandlerOptions {
    /** How many ids one query asks for (default 1000). */
    readonly batchSize?: number;
    /** Gives now, for `:daysAgo`; the system clock by default. */
    readonly now?: () => Date;
    /** How deep the associations named in the expressions are followed (default 5). */
    readonly maxJoinDepth?: number;
}

export const DEFAULT_BATCH_SIZE = 1000;
export const DEFAULT_MAX_JOIN_DEPTH = 5;

type Select = { [property: string]: true | Select };
type Relations = { [property: string]: true | Relations };
type Order = { [property: string]: 'ASC' | Order };

/** What a request loads. */
export interface LoadPlan {
    readonly select: Select;
    readonly relations: Relations;
    /** The items of the collections are in the order of their primary key, as in jfxmap's JPA handler. */
    readonly order: Order;
}

/**
 * Answers the requests for one entity from a TypeORM data source (FxMap's EntityFrameworkQueryHandler, jfxmap's
 * JpaQueryHandler).
 *
 * Each chunk of ids is one `find`, `where <id> in (...)`, that loads only what the expressions read: the columns whose
 * names appear in them, and the associations they navigate (`Country.Name`, `Orders:where(Status = 'Done'):sum(Total)`),
 * each association with one more query. The expressions are then evaluated on the loaded entities by the evaluator of
 * the in-memory handler, so every expression of the language is answered as the in-memory handler answers it, with
 * one difference taken from FxMap's database handlers: a navigation through a null association (`Country.Name`) is
 * null instead of an error.
 *
 * The requested ids travel as strings; they are converted to the type of the id column (string, number, bigint or
 * uuid), and an id that does not convert is not found.
 */
export class TypeOrmQueryHandler<T> implements QueryHandler {
    readonly key: string;
    readonly entityName: string;
    private readonly definition: EntityDefinition<T>;
    private readonly evaluator: EntityExpressionEvaluator<T>;
    private readonly batchSize: number;
    private readonly maxJoinDepth: number;
    private resolved: Resolved | undefined;

    /**
     * @param config     the entity configuration; its id must be a column of the entity
     * @param dataSource the data source that holds the entity; it may be initialized later, before the first request
     * @throws TypeOrmMapError when the data source is initialized and the entity, its id column or the id type does
     *                         not fit; otherwise on the first request
     */
    constructor(config: EntityConfig<T>, private readonly dataSource: DataSource,
                options: TypeOrmQueryHandlerOptions = {}) {
        if (dataSource === null || dataSource === undefined) throw new TypeError('The data source is required.');
        this.evaluator = new EntityExpressionEvaluator(config, { now: options.now, nullNavigation: 'null' });
        this.definition = this.evaluator.definition;
        this.key = this.definition.key;
        this.entityName = this.definition.name;
        this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
        if (!Number.isInteger(this.batchSize) || this.batchSize < 1)
            throw new RangeError('The batch size must be a whole number, at least 1.');
        this.maxJoinDepth = options.maxJoinDepth ?? DEFAULT_MAX_JOIN_DEPTH;
        if (dataSource.isInitialized) this.resolve();
    }

    /** Whether the data source holds the entity, so that a `TypeOrmQueryHandler` can answer for it. */
    static isManaged(dataSource: DataSource, entity: Function | string): boolean {
        return dataSource.hasMetadata(entity);
    }

    /** The database, as FxMap names it in its telemetry. */
    get dbSystem(): string {
        const type = String(this.dataSource.options.type);
        return DB_SYSTEMS[type] ?? type;
    }

    async handle(request: MapRequest, _context?: MapContext): Promise<ItemsResponse> {
        const { metadata, id } = this.resolve();
        const keys = new Map<string, unknown>();
        for (const requested of request.selectorIds) {
            const converted = id.convert(requested);
            if (converted !== null && !keys.has(converted.key)) keys.set(converted.key, converted.value);
        }
        // Nothing to query: the expressions are still checked
        if (keys.size === 0) return this.evaluator.answer(request, () => null);

        const { select, relations, order } = this.plan(metadata, request.expressions);
        const repository = this.dataSource.getRepository<T & object>(metadata.target);
        const values = [...keys.values()];
        const byKey = new Map<string, T>();
        for (let start = 0; start < values.length; start += this.batchSize) {
            const entities = await repository.find({
                select: select as never,
                relations: relations as never,
                relationLoadStrategy: 'query',
                order: order as never,
                where: { [this.definition.idProperty]: In(values.slice(start, start + this.batchSize)) } as never,
            });
            for (const entity of entities) {
                const key = id.keyOf((entity as Record<string, unknown>)[this.definition.idProperty]);
                if (key !== null && !byKey.has(key)) byKey.set(key, entity);
            }
        }
        return this.evaluator.answer(request, requested => {
            const converted = id.convert(requested);
            return converted === null ? null : byKey.get(converted.key);
        });
    }

    /**
     * What a request loads: the columns and associations whose names appear in its expressions (the names of the
     * language, the string arguments, the exposed names they stand for), and all the columns of an entity whose class
     * has a getter of such a name, since a getter may read any column.
     */
    plan(metadata: EntityMetadata, expressions: readonly (string | null)[]): LoadPlan {
        const names = new Set<string>();
        const add = (name: string) => names.add(name.toLowerCase());
        add(this.definition.idProperty);
        for (const expression of expressions) {
            if (expression === null) {
                if (this.definition.defaultProperty !== null) add(this.definition.defaultProperty);
                continue;
            }
            let node: ExpressionNode;
            try {
                node = parseExpression(expression);
            } catch {
                // The evaluator reports it
                continue;
            }
            collectNames(node, add);
        }
        for (const [exposed, property] of this.definition.exposedNames)
            if (names.has(exposed.toLowerCase())) add(property);

        const visit = (entity: EntityMetadata, depth: number): LoadPlan => {
            const full = hasGetterNamed(entity.target, names);
            const select: Select = {};
            const relations: Relations = {};
            const order: Order = {};
            for (const column of entity.columns) {
                if (column.embeddedMetadata || column.relationMetadata) continue;
                if (column.isPrimary || full || names.has(column.propertyName.toLowerCase()))
                    select[column.propertyName] = true;
            }
            for (const embedded of entity.embeddeds) {
                if (full || names.has(embedded.propertyName.toLowerCase()))
                    select[embedded.propertyName] = embeddedSelect(embedded);
            }
            if (depth < this.maxJoinDepth) {
                for (const relation of entity.relations) {
                    if (relation.isLazy || !names.has(relation.propertyName.toLowerCase())) continue;
                    const target = relation.inverseEntityMetadata;
                    const inner = visit(target, depth + 1);
                    select[relation.propertyName] = inner.select;
                    relations[relation.propertyName] = Object.keys(inner.relations).length === 0 ? true : inner.relations;
                    const innerOrder: Order = { ...inner.order };
                    if (relation.isOneToMany || relation.isManyToMany)
                        for (const primary of target.primaryColumns) innerOrder[primary.propertyName] = 'ASC';
                    if (Object.keys(innerOrder).length > 0) order[relation.propertyName] = innerOrder;
                }
            }
            return { select, relations, order };
        };
        return visit(metadata, 0);
    }

    private resolve(): Resolved {
        if (this.resolved !== undefined) return this.resolved;
        const target = this.definition.entityType ?? this.definition.name;
        if (!this.dataSource.hasMetadata(target)) throw new EntityNotManagedError(this.definition.name);
        const metadata = this.dataSource.getMetadata(target);
        const column = metadata.columns.find(c => c.propertyName === this.definition.idProperty && !c.embeddedMetadata);
        if (column === undefined) throw new IdColumnNotFoundError(this.definition.name, this.definition.idProperty);
        const id = IdConverter.of(column.type);
        if (id === null) throw new UnsupportedIdTypeError(this.definition.name, typeName(column.type));
        this.resolved = { metadata, id };
        return this.resolved;
    }
}

interface Resolved {
    readonly metadata: EntityMetadata;
    readonly id: IdConverter;
}

const DB_SYSTEMS: Record<string, string> = {
    postgres: 'postgresql',
    cockroachdb: 'cockroachdb',
    mysql: 'mysql',
    mariadb: 'mariadb',
    sqlite: 'sqlite',
    'better-sqlite3': 'sqlite',
    sqljs: 'sqlite',
    mssql: 'mssql',
    oracle: 'oracle',
};

/** Converts a requested id to the type of the id column, and gives the key both sides are compared by. */
class IdConverter {
    private constructor(private readonly kind: 'string' | 'number' | 'bigint' | 'uuid') {
    }

    static of(type: unknown): IdConverter | null {
        if (type === String) return new IdConverter('string');
        if (type === Number) return new IdConverter('number');
        if (typeof type !== 'string') return null;
        const name = type.toLowerCase();
        if (name === 'uuid' || name === 'uniqueidentifier') return new IdConverter('uuid');
        if (name === 'bigint' || name === 'int8' || name === 'unsigned big int') return new IdConverter('bigint');
        if (NUMBER_TYPES.has(name)) return new IdConverter('number');
        if (STRING_TYPES.has(name)) return new IdConverter('string');
        return null;
    }

    /** The value queried and the key of a requested id; null when it does not convert. */
    convert(id: string): { value: unknown; key: string } | null {
        switch (this.kind) {
            case 'string':
                return { value: id, key: id };
            case 'uuid':
                return UUID.test(id) ? { value: id.toLowerCase(), key: id.toLowerCase() } : null;
            case 'bigint':
                if (!/^-?\d+$/.test(id)) return null;
                return { value: BigInt(id).toString(), key: BigInt(id).toString() };
            case 'number': {
                if (!/^-?(\d+\.?\d*|\.\d+)$/.test(id)) return null;
                const value = Number(id);
                return Number.isFinite(value) ? { value, key: String(value) } : null;
            }
        }
    }

    /** The key of the id of a loaded entity. */
    keyOf(value: unknown): string | null {
        if (value === null || value === undefined) return null;
        switch (this.kind) {
            case 'string':
                return String(value);
            case 'uuid':
                return String(value).toLowerCase();
            case 'bigint':
                return BigInt(value as string | number | bigint).toString();
            case 'number':
                return String(Number(value));
        }
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER_TYPES = new Set(['int', 'integer', 'int2', 'int4', 'smallint', 'tinyint', 'mediumint', 'number',
    'numeric', 'decimal', 'float', 'float4', 'float8', 'double', 'double precision', 'real', 'smallserial', 'serial']);
const STRING_TYPES = new Set(['varchar', 'character varying', 'char', 'character', 'nvarchar', 'nchar', 'text',
    'ntext', 'tinytext', 'mediumtext', 'longtext', 'string', 'citext', 'varchar2', 'nvarchar2']);

function typeName(type: unknown): string {
    return typeof type === 'function' ? type.name : String(type);
}

// All the columns of an embedded object, and of the embedded objects inside it
function embeddedSelect(embedded: EmbeddedMetadata): Select {
    const select: Select = {};
    for (const column of embedded.columns) select[column.propertyName] = true;
    for (const inner of embedded.embeddeds) select[inner.propertyName] = embeddedSelect(inner);
    return select;
}

// Keys of the nodes that are not names of the language
const NOT_NAMES = new Set(['kind', 'literalType', 'functionName', 'operator', 'direction', 'aggregationType']);

/** Every name an expression may read: its identifiers, and its string arguments (`:orderBy('Name')`). */
function collectNames(node: unknown, add: (name: string) => void): void {
    if (typeof node === 'string') {
        // A path may be written as one name, as in a projection (Country.Name)
        for (const part of node.split('.')) if (part.length > 0) add(part);
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectNames(item, add);
        return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
        if (!NOT_NAMES.has(key)) collectNames(value, add);
    }
}

/** Whether the class declares a getter (or another non-column property on its prototype) of one of the names. */
function hasGetterNamed(target: Function | string, names: ReadonlySet<string>): boolean {
    if (typeof target !== 'function') return false;
    for (let prototype = target.prototype; prototype && prototype !== Object.prototype;
         prototype = Object.getPrototypeOf(prototype)) {
        for (const property of Object.getOwnPropertyNames(prototype)) {
            if (property === 'constructor') continue;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
            if (descriptor?.get !== undefined && names.has(property.toLowerCase())) return true;
        }
    }
    return false;
}
