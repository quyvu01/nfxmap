import { DistributedMapError } from 'nfxmap';

/** An entity configuration that does not fit the TypeORM data source. */
export class TypeOrmMapError extends DistributedMapError {
}

/** The entity of the configuration is not an entity of the data source. */
export class EntityNotManagedError extends TypeOrmMapError {
    constructor(readonly entity: string, options?: { cause?: unknown }) {
        super(`${entity} is not an entity of the TypeORM data source.`, options);
    }
}

/** The id of the configuration is not a column of the entity. */
export class IdColumnNotFoundError extends TypeOrmMapError {
    constructor(readonly entity: string, readonly idProperty: string) {
        super(`The id '${idProperty}' of ${entity} is not a column of the entity.`);
    }
}

/** The id column has a type that the requested ids, which are strings, are not converted to. */
export class UnsupportedIdTypeError extends TypeOrmMapError {
    constructor(readonly entity: string, readonly idType: string) {
        super(`The id of ${entity} has the type ${idType}, which requested ids are not converted to: use a string, `
            + 'number, bigint or uuid id.');
    }
}
