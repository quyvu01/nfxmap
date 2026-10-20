/**
 * One request to the owner of a distributed key: the ids to look up and the expressions to evaluate on each of them.
 * A `null` expression asks for the default property of the entity.
 */
export interface MapRequest {
    /** The distinct ids, as strings. */
    readonly selectorIds: readonly string[];
    /** The distinct expressions. */
    readonly expressions: readonly (string | null)[];
}

/** The value of one expression for one entity. */
export interface ValueResponse {
    /** The expression as it was requested (`null` for the default property). */
    readonly expression: string | null;
    /** The value serialized as JSON, or `null` when there is none. */
    readonly value: string | null;
}

/** The values of the requested expressions for one entity. */
export interface DataResponse {
    /** The id as it was requested. */
    readonly id: string;
    /** One value per expression. */
    readonly values: readonly ValueResponse[];
}

/** An expression the owner could not evaluate. The other expressions of the same request are still answered. */
export interface ExpressionError {
    readonly expression: string | null;
    /** Why it failed. */
    readonly message: string;
}

/** The answer to a {@link MapRequest}: one item per id found, and the expressions that failed. */
export interface ItemsResponse {
    readonly items: readonly DataResponse[];
    readonly errors: readonly ExpressionError[];
}

export const emptyItemsResponse: ItemsResponse = Object.freeze({ items: Object.freeze([]), errors: Object.freeze([]) });
