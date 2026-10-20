import {
    type EntityConfig,
    type EntityDefinition,
    EntityExpressionEvaluator,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    type QueryHandler,
} from 'nfxmap';
import { parseExpression, referencedNames } from 'nfxmap/expressions';
import { type Collection, type Document, ObjectId, UUID } from 'mongodb';

/**
 * The type the requested ids, which are strings, are converted to: `auto` (the default) tries each type the id can be
 * read as, ObjectId, UUID, number and string.
 */
export type MongoIdType = 'auto' | 'string' | 'objectId' | 'uuid' | 'number';

export interface MongoQueryHandlerOptions<T> {
    /** The stored name of the id: `_id` when the configured id property is `id`, the property name otherwise. */
    readonly idField?: string;
    /** The type of the stored ids (default `auto`). */
    readonly idType?: MongoIdType;
    /**
     * Turns a document into the entity, such as an instance of its class. Without it the expressions read the
     * documents, and only the fields they name are loaded; with it, whole documents are loaded, since the entity may
     * read any field.
     */
    readonly map?: (document: Document) => T;
    /** How many ids one query asks for (default 1000). */
    readonly batchSize?: number;
    /** Gives now, for `:daysAgo`; the system clock by default. */
    readonly now?: () => Date;
}

export const DEFAULT_BATCH_SIZE = 1000;

/**
 * Answers the requests for one entity from a MongoDB collection (FxMap's MongoDbQueryHandler, jfxmap's
 * MongoQueryHandler).
 *
 * Each chunk of ids is one `find({<id field>: {$in: [...]}})`, then the expressions are evaluated on the loaded
 * documents by the evaluator of the in-memory handler: the whole expression language is supported, with the answers of
 * the in-memory handler. Only the top-level fields the expressions name are loaded (in the spelling of the expression,
 * and in camelCase and PascalCase, so that the documents written by FxMap's .NET services are read too), unless a
 * `map` turns the documents into entities.
 *
 * ```ts
 * const users = new MongoQueryHandler(new UserConfig(), database.collection('users'));
 * ```
 */
export class MongoQueryHandler<T> implements QueryHandler {
    readonly key: string;
    readonly entityName: string;
    readonly dbSystem = 'mongodb';
    /** The stored name of the id. */
    readonly idField: string;
    private readonly definition: EntityDefinition<T>;
    private readonly evaluator: EntityExpressionEvaluator<T>;
    private readonly idType: MongoIdType;
    private readonly map: ((document: Document) => T) | undefined;
    private readonly batchSize: number;

    /**
     * @param config     the entity configuration
     * @param collection the collection that holds the entity
     */
    constructor(config: EntityConfig<T>, readonly collection: Collection<Document>,
                options: MongoQueryHandlerOptions<T> = {}) {
        if (collection === null || collection === undefined) throw new TypeError('The collection is required.');
        this.evaluator = new EntityExpressionEvaluator(config, { now: options.now });
        this.definition = this.evaluator.definition;
        this.key = this.definition.key;
        this.entityName = this.definition.name;
        if (options.idField !== undefined && options.idField.trim().length === 0)
            throw new RangeError('The id field is blank.');
        this.idField = options.idField ?? (this.definition.idProperty === 'id' ? '_id' : this.definition.idProperty);
        this.idType = options.idType ?? 'auto';
        if (!ID_TYPES.includes(this.idType)) throw new RangeError(`Unknown id type ${this.idType}.`);
        this.map = options.map;
        this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
        if (!Number.isInteger(this.batchSize) || this.batchSize < 1)
            throw new RangeError('The batch size must be a whole number, at least 1.');
    }

    async handle(request: MapRequest, _context?: MapContext): Promise<ItemsResponse> {
        const values = new Map<string, unknown>();
        for (const id of request.selectorIds)
            for (const candidate of candidates(id, this.idType)) values.set(candidate.key, candidate.value);

        const projection = this.map === undefined ? this.projection(request.expressions) : undefined;
        const byKey = new Map<string, T>();
        const all = [...values.values()];
        for (let start = 0; start < all.length; start += this.batchSize) {
            const cursor = this.collection.find({ [this.idField]: { $in: all.slice(start, start + this.batchSize) } },
                projection === undefined ? {} : { projection });
            for await (const document of cursor) {
                const key = keyOf(document[this.idField]);
                if (key === null || byKey.has(key)) continue;
                byKey.set(key, this.entity(document));
            }
        }
        return this.evaluator.answer(request, id => {
            for (const candidate of candidates(id, this.idType)) {
                const entity = byKey.get(candidate.key);
                if (entity !== undefined) return entity;
            }
            return null;
        });
    }

    /** The fields a request loads: the id, and the top-level fields its expressions name. */
    projection(expressions: readonly (string | null)[]): Record<string, 1> {
        const names = new Set<string>([this.definition.idProperty]);
        for (const expression of expressions) {
            if (expression === null) {
                if (this.definition.defaultProperty !== null) names.add(this.definition.defaultProperty);
                continue;
            }
            try {
                for (const name of referencedNames(parseExpression(expression))) names.add(name);
            } catch {
                // The evaluator reports it
            }
        }
        for (const [exposed, property] of this.definition.exposedNames)
            if ([...names].some(name => name.toLowerCase() === exposed.toLowerCase())) names.add(property);

        const projection: Record<string, 1> = { [this.idField]: 1 };
        for (const name of names) {
            for (const spelling of [name, name[0].toLowerCase() + name.slice(1), name[0].toUpperCase() + name.slice(1)])
                if (!spelling.startsWith('$')) projection[spelling] = 1;
        }
        return projection;
    }

    private entity(document: Document): T {
        if (this.map !== undefined) return this.map(document);
        // The id is read under the name of the configured property (id for _id)
        const property = this.definition.idProperty;
        if (this.idField !== property && !(property in document)) document[property] = document[this.idField];
        return document as T;
    }
}

const ID_TYPES: readonly MongoIdType[] = ['auto', 'string', 'objectId', 'uuid', 'number'];
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMBER = /^-?(\d+\.?\d*|\.\d+)$/;

/** The values a requested id is queried as, each with the key its document is found by. */
function candidates(id: string, type: MongoIdType): { value: unknown; key: string }[] {
    const result: { value: unknown; key: string }[] = [];
    if ((type === 'auto' || type === 'objectId') && OBJECT_ID.test(id))
        result.push({ value: new ObjectId(id), key: `oid:${id.toLowerCase()}` });
    if ((type === 'auto' || type === 'uuid') && UUID_TEXT.test(id))
        result.push({ value: new UUID(id), key: `uuid:${id.toLowerCase()}` });
    if ((type === 'auto' || type === 'number') && NUMBER.test(id) && Number.isFinite(Number(id)))
        result.push({ value: Number(id), key: `n:${Number(id)}` });
    if (type === 'auto' || type === 'string') result.push({ value: id, key: `s:${id}` });
    return result;
}

/** The key of a stored id. */
function keyOf(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return `s:${value}`;
    if (typeof value === 'number' || typeof value === 'bigint') return `n:${Number(value)}`;
    if (value instanceof ObjectId) return `oid:${value.toHexString()}`;
    const bson = value as { _bsontype?: string; sub_type?: number; toUUID?: () => UUID; toNumber?: () => number };
    if (bson._bsontype === 'ObjectId') return `oid:${String(value).toLowerCase()}`;
    if (bson._bsontype === 'Binary' && bson.sub_type === 4 && bson.toUUID) return `uuid:${bson.toUUID().toHexString()}`;
    if (bson._bsontype === 'Long' || bson._bsontype === 'Int32' || bson._bsontype === 'Double')
        return `n:${Number(value.valueOf())}`;
    return `s:${String(value)}`;
}
