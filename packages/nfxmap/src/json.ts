/**
 * The JSON of a value, as it travels in a response: a `Date` as its ISO string, a `Map` as an object, a `Set` as an
 * array, a `bigint` as a number (as a string when it is beyond the safe integers).
 */
export function writeJson(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) => {
        if (typeof v === 'bigint')
            return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
        if (v instanceof Map) return Object.fromEntries(v);
        if (v instanceof Set) return [...v];
        return v;
    });
}
