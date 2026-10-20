import { ExpressionEvaluationError } from './errors.js';

/** Collections, numbers and comparisons of evaluated values. */

/** Whether a value is a collection: an array, a Set or another iterable object. A string and a Map are not. */
export function isCollection(value: unknown): value is Iterable<unknown> {
    if (value === null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return true;
    if (value instanceof Map) return false;
    return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function';
}

/** The items of a collection, as a new array. */
export function items(value: Iterable<unknown>): unknown[] {
    return Array.from(value);
}

export function isNumber(value: unknown): value is number | bigint {
    return typeof value === 'number' || typeof value === 'bigint';
}

export function number(value: unknown, what: string): number | bigint {
    if (isNumber(value)) return value;
    throw new ExpressionEvaluationError(`${what} requires a number, got ${describe(value)}`);
}

/** A whole number for an argument (substring, round): the fraction is dropped, as a conversion to int does. */
export function wholeNumber(value: unknown, what: string): number {
    return Math.trunc(Number(number(value, what)));
}

export type Operator = '+' | '-' | '*' | '/' | '%';

/**
 * An operation of two numbers. Two bigints give a bigint (with the integer division of .NET's long); otherwise the
 * operation is done on JavaScript numbers.
 */
export function arithmetic(operator: Operator, left: number | bigint, right: number | bigint): number | bigint {
    if (typeof left === 'bigint' && typeof right === 'bigint') {
        if ((operator === '/' || operator === '%') && right === 0n)
            throw new ExpressionEvaluationError('Attempted to divide by zero.');
        switch (operator) {
            case '+': return left + right;
            case '-': return left - right;
            case '*': return left * right;
            case '/': return left / right;
            default: return left % right;
        }
    }
    const l = Number(left);
    const r = Number(right);
    switch (operator) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        default: return l % r;
    }
}

/**
 * Equality of two values: null and undefined are null, numbers by value (2024n and 2024 are equal), dates by their
 * time, the rest by identity.
 */
export function areEqual(left: unknown, right: unknown): boolean {
    const l = left ?? null;
    const r = right ?? null;
    if (l === null || r === null) return l === r;
    if (isNumber(l) && isNumber(r)) return l == r; // eslint-disable-line eqeqeq -- 1n == 1
    if (l instanceof Date && r instanceof Date) return l.getTime() === r.getTime();
    return l === r;
}

/** Orders two values that are not null: numbers by value, strings by their code units, dates, booleans. */
export function compare(left: unknown, right: unknown): number {
    if (isNumber(left) && isNumber(right)) return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
    if (left instanceof Date && right instanceof Date) return Math.sign(left.getTime() - right.getTime());
    if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
    throw new ExpressionEvaluationError(`Cannot compare ${describe(left)} with ${describe(right)}`);
}

/** The order of :orderBy, :min and :max: null comes first. */
export function compareNullsFirst(left: unknown, right: unknown): number {
    const l = left ?? null;
    const r = right ?? null;
    if (l === null) return r === null ? 0 : -1;
    if (r === null) return 1;
    return compare(l, r);
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/**
 * A key under which values that are equal (as {@link areEqual}) are the same: the keys of :groupBy and the values of
 * :distinct.
 */
export function equalityKey(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    switch (typeof value) {
        case 'number':
            return Number.isInteger(value) ? `n:${BigInt(value)}` : `n:${value}`;
        case 'bigint':
            return `n:${value}`;
        case 'string':
            return `s:${value}`;
        case 'boolean':
            return `b:${value}`;
        default:
            break;
    }
    if (value instanceof Date) return `d:${value.getTime()}`;
    if (typeof value === 'object' || typeof value === 'function') {
        let id = identities.get(value as object);
        if (id === undefined) identities.set(value as object, (id = nextIdentity++));
        return `o:${id}`;
    }
    return `${typeof value}:${String(value)}`;
}

export function describe(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return `string '${value}'`;
    if (typeof value === 'object') {
        const name = (value as object).constructor?.name ?? 'Object';
        return value instanceof Date ? `Date '${value.toISOString()}'` : `${name}`;
    }
    return `${typeof value} '${String(value)}'`;
}
