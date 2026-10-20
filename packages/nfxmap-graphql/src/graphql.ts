import DataLoader from 'dataloader';
import {
    type GraphQLFieldResolver,
    type GraphQLSchema,
    isObjectType,
} from 'graphql';
import type { DistributedMapper, Headers, ModelRef } from 'nfxmap';

/** A field of an object: the object by identity, since mapping changes it. */
export interface FieldKey {
    readonly source: object;
    readonly property: string;
}

/** The data loader of a request: what {@link NfxMapGraphQL.createLoader} builds. */
export type FieldLoader = DataLoader<FieldKey, unknown>;

export interface NfxMapGraphQLOptions {
    /**
     * The GraphQL type of a profiled model, when it is not named after it (the name of its class, or the name its
     * profile was declared with).
     */
    readonly typeNames?: Iterable<readonly [ModelRef, string]>;
    /**
     * The headers of the requests of a GraphQL request, from its context; by default the
     * {@link NfxMapGraphQL.HEADERS} property of the context.
     */
    readonly headers?: (context: unknown) => Headers | null | undefined;
}

/**
 * Resolves the fields that the profiles declare through nfxmap, in graphql-js (FxMap.HotChocolate's counterpart): a
 * GraphQL object type named after a profiled model (the name of its class, the name its profile was declared with, or
 * the name given in `typeNames`) gets a resolver for each of its fields named after a property with a rule. The fields
 * of every object of a request are batched by a data loader: one call of {@link DistributedMapper.mapProperties} per
 * level of the query, which sends one request per distributed key with only the selected fields, whatever the number
 * of objects.
 *
 * ```ts
 * const nfxmap = new NfxMapGraphQL(mapper, { typeNames: [[OrderDto, 'Order']] });
 * // A schema built from SDL with graphql-tools or Apollo Server:
 * const schema = makeExecutableSchema({ typeDefs, resolvers: [queryResolvers, nfxmap.resolvers()] });
 * // Or any graphql-js schema:
 * nfxmap.instrument(schema);
 * ```
 *
 * The batching needs a context object per request (Apollo Server and graphql-yoga give one): the data loader is
 * created on its first mapped field, unless the application put one under {@link NfxMapGraphQL.LOADER}. Without a
 * context each field is mapped on its own. The headers of the requests are read from the context under
 * {@link NfxMapGraphQL.HEADERS}, or with the `headers` option.
 */
export class NfxMapGraphQL {
    /** The property of the context that holds the headers of the requests: a `Record<string, string>`. */
    static readonly HEADERS = 'nfxmapHeaders';
    /** The property of the context where the application may put the data loader of the request. */
    static readonly LOADER = 'nfxmapLoader';

    /** The fields resolved through nfxmap, by GraphQL type name. */
    readonly fields: ReadonlyMap<string, ReadonlySet<string>>;
    private readonly headersOf: (context: unknown) => Headers | null | undefined;
    private readonly loaders = new WeakMap<object, FieldLoader>();

    constructor(private readonly mapper: DistributedMapper, options: NfxMapGraphQLOptions = {}) {
        if (mapper === null || mapper === undefined) throw new TypeError('The mapper is required.');
        const typeNames = new Map<ModelRef, string>();
        for (const [model, typeName] of options.typeNames ?? []) {
            if (model === null || model === undefined) throw new TypeError('The model of a type name is required.');
            if (typeof typeName !== 'string' || typeName.trim() === '')
                throw new RangeError('The type name is blank.');
            typeNames.set(model, typeName);
        }
        const fields = new Map<string, Set<string>>();
        for (const [model, properties] of mapper.mappedProperties()) {
            const typeName = typeNames.get(model) ?? (typeof model === 'string' ? model : model.name);
            const union = fields.get(typeName) ?? new Set<string>();
            for (const property of properties) union.add(property);
            fields.set(typeName, union);
        }
        this.fields = fields;
        this.headersOf = options.headers ?? defaultHeaders;
    }

    /**
     * The resolvers of the mapped fields, by type and field: what `makeExecutableSchema` of graphql-tools and Apollo
     * Server take, merged with the resolvers of the application.
     */
    resolvers(): Record<string, Record<string, GraphQLFieldResolver<unknown, unknown>>> {
        const resolvers: Record<string, Record<string, GraphQLFieldResolver<unknown, unknown>>> = {};
        for (const [typeName, fields] of this.fields) {
            const typeResolvers: Record<string, GraphQLFieldResolver<unknown, unknown>> = {};
            for (const field of fields) typeResolvers[field] = this.resolver(field);
            resolvers[typeName] = typeResolvers;
        }
        return resolvers;
    }

    /**
     * Sets the resolvers of the mapped fields that the schema has, in place, and returns the schema: for a schema
     * built in code or with `buildSchema`. A type or field that the schema does not have is left out.
     */
    instrument(schema: GraphQLSchema): GraphQLSchema {
        for (const [typeName, fields] of this.fields) {
            const type = schema.getType(typeName);
            if (!isObjectType(type)) continue;
            const definitions = type.getFields();
            for (const field of fields) {
                const definition = definitions[field];
                if (definition !== undefined) definition.resolve = this.resolver(field);
            }
        }
        return schema;
    }

    /** The resolver of a mapped property: its value once the objects of the level are mapped. */
    resolver(property: string): GraphQLFieldResolver<unknown, unknown> {
        if (typeof property !== 'string') throw new TypeError('The property is required.');
        return async (source, _args, context) => {
            if (source === null || typeof source !== 'object') return null;
            const loader = this.loaderOf(context);
            if (loader === null) {
                // No context to keep a data loader in: this field alone
                await this.mapper.mapProperties([source], [property], { headers: this.headers(context) });
                return read(source, property);
            }
            return loader.load({ source, property });
        };
    }

    /**
     * A data loader for one GraphQL request, sending `headers`: what the resolvers create in the context, for an
     * application that creates it itself (`{ [NfxMapGraphQL.LOADER]: nfxmap.createLoader(headers) }`).
     */
    createLoader(headers?: Headers | null): FieldLoader {
        return new DataLoader<FieldKey, unknown>(keys => this.load(keys, headers), { cache: false });
    }

    /**
     * The values of fields, in the order of `keys`, once their objects are mapped together (`null` for a field without
     * a value): what the data loader of a request does, for a framework that creates its data loaders itself.
     */
    async load(keys: readonly FieldKey[], headers?: Headers | null): Promise<unknown[]> {
        const sources = new Set<object>();
        const properties = new Set<string>();
        for (const key of keys) {
            sources.add(key.source);
            properties.add(key.property);
        }
        await this.mapper.mapProperties(sources, properties, { headers: headers ?? {} });
        return keys.map(key => read(key.source, key.property));
    }

    private loaderOf(context: unknown): FieldLoader | null {
        if (context === null || typeof context !== 'object') return null;
        const registered = (context as Record<string, unknown>)[NfxMapGraphQL.LOADER];
        if (typeof (registered as FieldLoader | undefined)?.load === 'function') return registered as FieldLoader;
        let loader = this.loaders.get(context);
        if (loader === undefined) {
            loader = this.createLoader(this.headers(context));
            this.loaders.set(context, loader);
        }
        return loader;
    }

    private headers(context: unknown): Headers {
        return this.headersOf(context) ?? {};
    }
}

function defaultHeaders(context: unknown): Headers | null {
    if (context === null || typeof context !== 'object') return null;
    return ((context as Record<string, unknown>)[NfxMapGraphQL.HEADERS] as Headers | undefined) ?? null;
}

function read(source: object, property: string): unknown {
    return (source as Record<string, unknown>)[property] ?? null;
}
