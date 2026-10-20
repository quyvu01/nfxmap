/**
 * A canonical form of an evaluated value, to compare a result with the expected JSON of the tests (the Canonical helper
 * of the Java tests): numbers are compared by value, with 12 significant digits so that the binary error of JS numbers
 * (10.456 * 3 = 31.368000000000002) does not count; bigints are numbers; dates are their ISO text; the properties of an
 * object are written with the first letter in upper case, as the properties of the C# models; Sets and other
 * iterables are arrays; Maps are objects.
 */
export function canonical(value: unknown): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number') return Number(value.toPrecision(12)) + 0;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of value) out[String(key)] = canonical(item);
        return out;
    }
    if (Array.isArray(value) || (typeof value === 'object' && Symbol.iterator in value))
        return Array.from(value as Iterable<unknown>, canonical);
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value))
            out[key.length === 0 ? key : key[0].toUpperCase() + key.slice(1)] = canonical(item);
        return out;
    }
    return String(value);
}

/** The canonical form of a JSON text. */
export function canonicalJson(json: string): unknown {
    return canonical(JSON.parse(json));
}
