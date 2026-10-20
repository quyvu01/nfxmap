import { daysAgo, formatDate } from './dates.js';
import { ExpressionEvaluationError } from './errors.js';
import {
    type AggregationNode,
    type AggregationType,
    type BinaryConditionNode,
    type BooleanFunctionNode,
    type ConditionNode,
    type ExpressionNode,
    type FilterNode,
    type FunctionNode,
    type GroupByNode,
    type NavigationNode,
    type ProjectionNode,
    type ProjectionProperty,
    type PropertyNode,
    functionArguments,
    outputKey,
    pathSegments,
} from './nodes.js';
import { roundHalfEven } from './numbers.js';
import { parseExpression } from './parser.js';
import * as Values from './values.js';

/** A property found on an object: its value. */
export interface FoundProperty {
    readonly value: unknown;
}

/**
 * Reads a property of an object by the name written in an expression; `undefined` when the object has no property of
 * that name. A `Map` is read by key by the evaluator and does not go through the accessor.
 */
export type PropertyAccessor = (target: object, name: string) => FoundProperty | undefined;

/**
 * The default accessor: the property as written, then with its first letter in lower case, then in upper case, so that
 * the PascalCase names of FxMap expressions (`Orders:sum(Total)`) find the camelCase properties of JavaScript objects
 * (`orders`, `total`). Getters are read; methods and the members of `Object.prototype` are not properties.
 */
export const defaultPropertyAccessor: PropertyAccessor = (target, name) => {
    if (name.length === 0) return undefined;
    const lower = name[0].toLowerCase() + name.slice(1);
    const upper = name[0].toUpperCase() + name.slice(1);
    for (const candidate of name === lower ? [name, upper] : [name, lower, upper]) {
        if (!(candidate in target)) continue;
        if (!Object.prototype.hasOwnProperty.call(target, candidate) && candidate in Object.prototype) continue;
        const value = (target as Record<string, unknown>)[candidate];
        if (typeof value === 'function') continue;
        return { value };
    }
    return undefined;
};

/** A group of `:groupBy(...)` that has no projection after it. */
export interface Grouping {
    /** The value of the key property, or the values of the key properties of a multi-key groupBy. */
    readonly key: unknown;
    /** The items of the group, in the order of the source. */
    readonly items: unknown[];
}

export interface ExpressionEvaluatorOptions {
    /** Reads the properties of the objects; {@link defaultPropertyAccessor} by default. */
    readonly accessor?: PropertyAccessor;
    /** Gives now, for `:daysAgo`; the system clock by default. */
    readonly now?: () => Date;
    /**
     * Whether a navigation through null (`Country.Name` when Country is null) fails, as by default, or gives null, as
     * when FxMap's database handlers translate it into a left join.
     */
    readonly nullNavigation?: 'error' | 'null';
}

const MAX_GROUP_KEYS = 5;

interface GroupContext {
    readonly keyProperties: readonly string[];
    readonly keyValues: readonly unknown[];
    readonly items: unknown[];
}

// The object that properties are read from, and the group of a projection after groupBy
interface Context {
    readonly current: unknown;
    readonly group: GroupContext | null;
}

const NULL_SAFE_HINT = "(a null-safe navigation is written with '?', as in Address?.City)";

/**
 * Evaluates FxMap expressions on objects in memory: class instances, plain objects, `Map`s, arrays, `Set`s and other
 * iterables. It is the counterpart of FxMap's LINQ expressions run over objects.
 *
 * The values it gives:
 * - a projection (`{Id, Name}`, `Country.{Id, Name}`) is a plain object with its properties in order; the projection
 *   of a collection (`Orders.{Id, Total}`) is an array of them;
 * - the filter and the collection functions (`:where`, `:orderBy`, `:offset`, `:limit`, `:distinct`, `:split`) give
 *   arrays; `:first` and `:last` give an item, or null for an empty collection;
 * - `:sum` and `:count` of an empty collection are 0; `:avg`, `:min` and `:max` of an empty collection are null;
 * - `:groupBy(...)` without a projection gives an array of {@link Grouping}s.
 *
 * Null values: `Address.City` fails when Address is null, and `Address?.City` gives null. A function of a null value
 * gives null, and the projection of a missing item (`Orders:first.{Id}` of no order) gives its properties as null.
 * `undefined` is read as null.
 */
export class ExpressionEvaluator {
    private readonly accessor: PropertyAccessor;
    private readonly now: () => Date;
    private readonly nullNavigation: boolean;

    constructor(options: ExpressionEvaluatorOptions = {}) {
        this.accessor = options.accessor ?? defaultPropertyAccessor;
        this.now = options.now ?? (() => new Date());
        this.nullNavigation = options.nullNavigation === 'null';
    }

    /** Evaluates an expression, given as text or parsed, on an object. */
    evaluate(expression: string | ExpressionNode, root: unknown): unknown {
        const node = typeof expression === 'string' ? parseExpression(expression) : expression;
        return this.visit(node, { current: root ?? null, group: null }) ?? null;
    }

    private visit(node: ExpressionNode, context: Context): unknown {
        switch (node.kind) {
            case 'Property': return this.visitProperty(node, context);
            case 'Navigation': return this.visitNavigation(node, context);
            case 'Filter': return this.visitFilter(node, context);
            case 'Projection': return this.visitProjection(node, context);
            case 'RootProjection': return this.project(node.properties, context);
            case 'Function': return this.visitFunction(node, context);
            case 'BooleanFunction': return this.visitBooleanFunction(node, context);
            case 'BinaryCondition': return this.visitBinaryCondition(node, context);
            case 'LogicalCondition': {
                const left = this.test(node.left, context);
                if (node.operator === 'And' && !left) return false;
                if (node.operator === 'Or' && left) return true;
                return this.test(node.right, context);
            }
            case 'Literal': return node.value;
            case 'Aggregation': return this.visitAggregation(node, context);
            case 'Coalesce': return this.visit(node.left, context) ?? this.visit(node.right, context);
            case 'Ternary':
                return this.test(node.condition, context)
                    ? this.visit(node.whenTrue, context)
                    : this.visit(node.whenFalse, context);
            case 'GroupBy': return this.visitGroupBy(node, context);
            case 'GroupElements':
                if (context.group === null)
                    throw new ExpressionEvaluationError('The items of a group can only be used within a GroupBy '
                        + 'projection. Use syntax like: Orders:groupBy(Status).{Status, :count as Count}');
                return context.group.items;
            case 'SortKey':
                throw new ExpressionEvaluationError('A sort key is only valid as an argument of the orderBy function');
        }
    }

    private visitProperty(node: PropertyNode, context: Context): unknown {
        // After groupBy, a key property is the key of the group
        if (context.group !== null) {
            const index = keyIndex(context.group, node.name);
            if (index >= 0) return context.group.keyValues[index];
        }
        return this.readProperty(context.current, node.name);
    }

    private visitNavigation(node: NavigationNode, context: Context): unknown {
        let current = context;
        let result: unknown = null;
        for (let i = 0; i < node.segments.length; i++) {
            const segment = node.segments[i];
            result = this.visit(segment, current) ?? null;
            if (result === null && i < node.segments.length - 1) {
                // Address?.City stops when Address is null; Address.City cannot go on
                if ((segment.kind === 'Property' && segment.isNullSafe) || this.nullNavigation) return null;
                throw new ExpressionEvaluationError(`Cannot navigate from ${describeSegment(segment)}: it is null `
                    + NULL_SAFE_HINT);
            }
            current = { current: result, group: current.group };
        }
        return result;
    }

    private visitFilter(node: FilterNode, context: Context): unknown {
        const source = this.visit(node.source, context);
        if (source === null || source === undefined) return null;
        return this.collection(source, 'where').filter(item => this.test(node.condition, itemContext(item)));
    }

    private visitProjection(node: ProjectionNode, context: Context): unknown {
        if (node.source.kind === 'GroupBy') return this.projectGroups(node, node.source, context);

        const source = this.visit(node.source, context) ?? null;
        // A collection: each item is projected
        if (Values.isCollection(source))
            return Values.items(source).map(item => this.project(node.properties, itemContext(item)));
        // A missing item of :first or :last has its properties as null; another null source has no projection
        if (source === null && !isFirstOrLast(node.source)) return null;
        return this.project(node.properties, { current: source, group: context.group });
    }

    private project(properties: readonly ProjectionProperty[], context: Context): Record<string, unknown> {
        const result: Record<string, unknown> = {};
        for (const property of properties) {
            let value: unknown;
            if ((context.current === null || context.current === undefined) && context.group === null) {
                // The projection of a null item: its properties are null
                value = null;
            } else if (property.expression !== null) {
                value = this.visit(property.expression, context);
            } else {
                value = this.readPath(pathSegments(property), context);
            }
            put(result, outputKey(property), value);
        }
        return result;
    }

    private readPath(segments: string[], context: Context): unknown {
        let current: unknown = context.current;
        for (let i = 0; i < segments.length; i++) {
            if ((current === null || current === undefined) && i > 0) {
                if (this.nullNavigation) return null;
                throw new ExpressionEvaluationError(`Cannot navigate from '${segments[i - 1]}': it is null `
                    + NULL_SAFE_HINT);
            }
            current = this.readProperty(current, segments[i]);
        }
        return current;
    }

    // Orders:groupBy(Status).{Status, :count as Count}
    private projectGroups(node: ProjectionNode, groupBy: GroupByNode, context: Context): unknown {
        const groups = this.group(groupBy, context);
        if (groups === null) return null;

        return groups.map(group => {
            const groupContext: Context = { current: context.current, group };
            const row: Record<string, unknown> = {};
            for (const property of node.properties) {
                let value: unknown;
                if (property.expression !== null) {
                    value = this.visit(property.expression, groupContext);
                } else {
                    const keyName = pathSegments(property)[0];
                    const index = keyIndex(group, keyName);
                    if (index < 0)
                        throw new ExpressionEvaluationError(`Property '${keyName}' is not a key property in GroupBy. `
                            + `Available keys: ${groupBy.keyProperties.join(', ')}`);
                    value = group.keyValues[index];
                }
                put(row, outputKey(property), value);
            }
            return row;
        });
    }

    private visitGroupBy(node: GroupByNode, context: Context): unknown {
        const groups = this.group(node, context);
        if (groups === null) return null;
        return groups.map((group): Grouping => ({
            key: node.keyProperties.length === 1 ? group.keyValues[0] : [...group.keyValues],
            items: group.items,
        }));
    }

    // The groups of the source, in the order their first item comes in it
    private group(node: GroupByNode, context: Context): GroupContext[] | null {
        if (node.keyProperties.length > MAX_GROUP_KEYS)
            throw new ExpressionEvaluationError(`GroupBy with more than ${MAX_GROUP_KEYS} keys is not supported. `
                + `Found ${node.keyProperties.length} keys.`);

        const source = this.visit(node.source, context);
        if (source === null || source === undefined) return null;

        const groups = new Map<string, { keyValues: unknown[]; items: unknown[] }>();
        for (const item of this.collection(source, 'groupBy')) {
            const keyValues = node.keyProperties.map(property => this.readProperty(item, property) ?? null);
            const key = keyValues.map(Values.equalityKey).join('|');
            let group = groups.get(key);
            if (group === undefined) groups.set(key, (group = { keyValues, items: [] }));
            group.items.push(item);
        }
        return [...groups.values()].map(group => ({ keyProperties: node.keyProperties, ...group }));
    }

    private visitFunction(node: FunctionNode, context: Context): unknown {
        const source = this.visit(node.source, context) ?? null;
        switch (node.functionName) {
            // Aggregates
            case 'Count': return this.count(source);
            case 'Sum': return this.aggregate(source, 'Sum', node.argument);
            case 'Avg': return this.aggregate(source, 'Average', node.argument);
            case 'Min': return this.aggregate(source, 'Min', node.argument);
            case 'Max': return this.aggregate(source, 'Max', node.argument);
            // Strings
            case 'Upper': return source === null ? null : string(source, 'upper').toUpperCase();
            case 'Lower': return source === null ? null : string(source, 'lower').toLowerCase();
            case 'Trim': return source === null ? null : string(source, 'trim').trim();
            case 'Substring': return this.substring(source, node, context);
            case 'Replace': return this.replace(source, node, context);
            case 'Concat': return this.concat(source, node, context);
            case 'Split': return this.split(source, node, context);
            // Dates, in UTC
            case 'Year': return dateFunction(source, 'year', d => d.getUTCFullYear());
            case 'Month': return dateFunction(source, 'month', d => d.getUTCMonth() + 1);
            case 'Day': return dateFunction(source, 'day', d => d.getUTCDate());
            case 'Hour': return dateFunction(source, 'hour', d => d.getUTCHours());
            case 'Minute': return dateFunction(source, 'minute', d => d.getUTCMinutes());
            case 'Second': return dateFunction(source, 'second', d => d.getUTCSeconds());
            // Sunday is 0, Monday 1, ..., Saturday 6
            case 'DayOfWeek': return dateFunction(source, 'dayOfWeek', d => d.getUTCDay());
            case 'DaysAgo': return dateFunction(source, 'daysAgo', d => daysAgo(d, this.now()));
            case 'Format': return this.format(source, node, context);
            // Math
            case 'Round': return this.round(source, node, context);
            case 'Floor': return source === null ? null : Math.floor(Number(Values.number(source, 'floor')));
            case 'Ceil': return source === null ? null : Math.ceil(Number(Values.number(source, 'ceil')));
            case 'Abs': {
                if (source === null) return null;
                const value = Values.number(source, 'abs');
                return typeof value === 'bigint' ? (value < 0n ? -value : value) : Math.abs(value);
            }
            case 'Add': return this.arithmetic(source, node, context, '+');
            case 'Subtract': return this.arithmetic(source, node, context, '-');
            case 'Multiply': return this.arithmetic(source, node, context, '*');
            case 'Divide': return this.arithmetic(source, node, context, '/');
            case 'Mod': return this.arithmetic(source, node, context, '%');
            case 'Pow': {
                const args = functionArguments(node);
                if (args.length === 0) throw new ExpressionEvaluationError('pow function requires an exponent argument');
                const exponent = this.visit(args[0], context) ?? null;
                if (source === null || exponent === null) return null;
                return Math.pow(Number(Values.number(source, 'pow')), Number(Values.number(exponent, 'pow')));
            }
            // Collections
            case 'OrderBy': return this.orderBy(source, node);
            case 'Skip': return this.skipOrTake(source, node, 'offset', true);
            case 'Take': return this.skipOrTake(source, node, 'limit', false);
            case 'First':
            case 'Last': {
                if (source === null) return null;
                const items = this.collection(source, node.functionName === 'First' ? 'first' : 'last');
                if (items.length === 0) return null;
                return (node.functionName === 'First' ? items[0] : items[items.length - 1]) ?? null;
            }
            case 'Distinct': return this.distinct(source, node);
            case 'Any':
            case 'All':
                // Parsed as boolean functions; a tree built by hand may still have them here
                return this.visitBooleanFunction(
                    { kind: 'BooleanFunction', source: node.source, functionName: node.functionName, condition: null },
                    context);
        }
    }

    // Strings

    private substring(source: unknown, node: FunctionNode, context: Context): unknown {
        const args = functionArguments(node);
        const start = Values.wholeNumber(this.visit(args[0], context), 'substring');
        const length = args.length > 1 ? Values.wholeNumber(this.visit(args[1], context), 'substring') : null;
        if (source === null) return null;

        const text = string(source, 'substring');
        const end = length === null ? text.length : start + length;
        if (start < 0 || start > text.length || end < start || end > text.length)
            throw new ExpressionEvaluationError(`substring(${start}${length === null ? '' : `, ${length}`}) is out of `
                + `the range of '${text}'`);
        return text.slice(start, end);
    }

    private replace(source: unknown, node: FunctionNode, context: Context): unknown {
        const args = functionArguments(node);
        const oldValue = this.visit(args[0], context) ?? null;
        const newValue = this.visit(args[1], context) ?? null;
        if (source === null) return null;
        if (oldValue === null || String(oldValue).length === 0)
            throw new ExpressionEvaluationError('replace requires a value to replace');
        return string(source, 'replace').split(String(oldValue)).join(newValue === null ? '' : String(newValue));
    }

    private concat(source: unknown, node: FunctionNode, context: Context): unknown {
        // As string.Concat: a null part is empty
        let text = source === null ? '' : String(source);
        for (const arg of functionArguments(node)) {
            const value = this.visit(arg, context);
            if (value !== null && value !== undefined) text += String(value);
        }
        return text;
    }

    private split(source: unknown, node: FunctionNode, context: Context): unknown {
        const separator = this.visit(functionArguments(node)[0], context) ?? null;
        if (source === null) return null;
        const text = string(source, 'split');
        // The empty parts are kept, as String.Split(string, StringSplitOptions.None) does
        if (separator === null || String(separator).length === 0) return [text];
        return text.split(String(separator));
    }

    // Dates

    private format(source: unknown, node: FunctionNode, context: Context): unknown {
        const pattern = this.visit(functionArguments(node)[0], context) ?? null;
        if (source === null) return null;
        if (typeof pattern !== 'string')
            throw new ExpressionEvaluationError(`format requires a pattern, got ${Values.describe(pattern)}`);
        const date = toDate(source, 'format');
        try {
            return formatDate(date, pattern);
        } catch (e) {
            throw new ExpressionEvaluationError(`Cannot format ${Values.describe(source)} with '${pattern}': `
                + (e as Error).message, { cause: e });
        }
    }

    // Math

    private round(source: unknown, node: FunctionNode, context: Context): unknown {
        const args = functionArguments(node);
        const decimals = args.length === 0 ? 0 : Values.wholeNumber(this.visit(args[0], context), 'round');
        if (source === null) return null;
        // Math.Round rounds a midpoint to the even number
        return roundHalfEven(Number(Values.number(source, 'round')), decimals);
    }

    private arithmetic(source: unknown, node: FunctionNode, context: Context, operator: Values.Operator): unknown {
        const args = functionArguments(node);
        if (args.length === 0) throw new ExpressionEvaluationError('Math operation requires an operand');
        const operand = this.visit(args[0], context) ?? null;
        if (source === null || operand === null) return null;
        return Values.arithmetic(operator, Values.number(source, operator), Values.number(operand, operator));
    }

    // Collections

    private orderBy(source: unknown, node: FunctionNode): unknown {
        const args = functionArguments(node);
        if (args.length === 0)
            throw new ExpressionEvaluationError('orderBy function requires at least one property argument');
        if (source === null) return null;

        const keys = args.map(arg => {
            if (arg.kind === 'SortKey') return { name: arg.name, descending: arg.direction === 'Desc' };
            if (arg.kind === 'Property') return { name: arg.name, descending: false };
            if (arg.kind === 'Literal' && arg.literalType === 'String') return { name: String(arg.value), descending: false };
            throw new ExpressionEvaluationError('orderBy function requires property name arguments');
        });

        // Each key is read once per item; the sort is stable, as OrderBy/ThenBy
        const rows = this.collection(source, 'orderBy')
            .map(item => ({ item, values: keys.map(key => this.readProperty(item, key.name)) }));
        rows.sort((a, b) => {
            for (let i = 0; i < keys.length; i++) {
                const comparison = Values.compareNullsFirst(a.values[i], b.values[i]);
                if (comparison !== 0) return keys[i].descending ? -comparison : comparison;
            }
            return 0;
        });
        return rows.map(row => row.item);
    }

    private skipOrTake(source: unknown, node: FunctionNode, name: string, skip: boolean): unknown {
        const count = nonNegativeCount(node, name);
        if (source === null) return null;
        const items = this.collection(source, name);
        return skip ? items.slice(count) : items.slice(0, count);
    }

    private distinct(source: unknown, node: FunctionNode): unknown {
        const args = functionArguments(node);
        if (args.length === 0) throw new ExpressionEvaluationError('distinct function requires a property argument');
        const arg = args[0];
        let propertyName: string;
        if (arg.kind === 'Property') propertyName = arg.name;
        else if (arg.kind === 'Literal' && arg.literalType === 'String') propertyName = String(arg.value);
        else throw new ExpressionEvaluationError('distinct function requires a property name argument');

        if (source === null) return null;
        const values = new Map<string, unknown>();
        for (const item of this.collection(source, 'distinct')) {
            const value = this.readProperty(item, propertyName) ?? null;
            const key = Values.equalityKey(value);
            if (!values.has(key)) values.set(key, value);
        }
        return [...values.values()];
    }

    private visitBooleanFunction(node: BooleanFunctionNode, context: Context): unknown {
        const source = this.visit(node.source, context) ?? null;
        // All without a condition is true (there is no condition to fail)
        if (node.functionName === 'All' && node.condition === null) return true;
        if (source === null) return null;

        const items = this.collection(source, node.functionName === 'Any' ? 'any' : 'all');
        const condition = node.condition;
        if (condition === null) return items.length > 0;
        if (node.functionName === 'Any') return items.some(item => this.test(condition, itemContext(item)));
        return items.every(item => this.test(condition, itemContext(item)));
    }

    private visitBinaryCondition(node: BinaryConditionNode, context: Context): boolean {
        const left = this.visit(node.left, context) ?? null;
        const right = this.visit(node.right, context) ?? null;
        const both = left !== null && right !== null;
        switch (node.operator) {
            case 'Equal': return Values.areEqual(left, right);
            case 'NotEqual': return !Values.areEqual(left, right);
            case 'GreaterThan': return both && Values.compare(left, right) > 0;
            case 'LessThan': return both && Values.compare(left, right) < 0;
            case 'GreaterThanOrEqual': return both && Values.compare(left, right) >= 0;
            case 'LessThanOrEqual': return both && Values.compare(left, right) <= 0;
            case 'Contains': return both && string(left, 'contains').includes(String(right));
            case 'StartsWith': return both && string(left, 'startswith').startsWith(String(right));
            case 'EndsWith': return both && string(left, 'endswith').endsWith(String(right));
        }
    }

    private visitAggregation(node: AggregationNode, context: Context): unknown {
        const source = this.visit(node.source, context) ?? null;
        if (node.aggregationType === 'Count') return this.count(source);
        return this.aggregate(source, node.aggregationType, node.propertyName);
    }

    // Aggregations

    private count(source: unknown): unknown {
        if (source === null) return null;
        // The length of a string
        if (typeof source === 'string') return source.length;
        if (source instanceof Map) return source.size;
        return this.collection(source, 'count').length;
    }

    private aggregate(source: unknown, type: AggregationType, propertyName: string | null): unknown {
        if (source === null) return null;
        const name = type.toLowerCase();

        // The values, without the nulls (as the aggregates of nullable values)
        const values: unknown[] = [];
        for (const item of this.collection(source, name)) {
            const value = propertyName === null ? item : this.readProperty(item, propertyName);
            if (value !== null && value !== undefined) values.push(value);
        }

        switch (type) {
            case 'Sum':
                return values.length === 0 ? 0 : sum(values, name);
            case 'Average':
                // The average of an empty collection has no value
                return values.length === 0 ? null : Number(sum(values, name)) / values.length;
            default: {
                if (values.length === 0) return null;
                let best = values[0];
                for (const value of values) {
                    const comparison = Values.compare(value, best);
                    if (type === 'Min' ? comparison < 0 : comparison > 0) best = value;
                }
                return best;
            }
        }
    }

    // Helpers

    private test(condition: ConditionNode, context: Context): boolean {
        const value = this.visit(condition, context);
        if (typeof value === 'boolean') return value;
        throw new ExpressionEvaluationError(`A condition must be true or false, got ${Values.describe(value)}`);
    }

    private collection(source: unknown, fn: string): unknown[] {
        if (Values.isCollection(source)) return Values.items(source);
        throw new ExpressionEvaluationError(`Cannot apply ${fn} function to non-collection value ${Values.describe(source)}`);
    }

    private readProperty(target: unknown, name: string): unknown {
        if (target === null || target === undefined)
            throw new ExpressionEvaluationError(`Cannot read property '${name}' of null`);

        if (target instanceof Map) {
            if (!target.has(name)) throw new ExpressionEvaluationError(`Property '${name}' not found in the map`);
            return target.get(name) ?? null;
        }

        const found = typeof target === 'object' ? this.accessor(target, name) : undefined;
        if (found === undefined)
            throw new ExpressionEvaluationError(`Property '${name}' not found on type '${typeName(target)}'`);
        return found.value ?? null;
    }
}

function itemContext(item: unknown): Context {
    return { current: item ?? null, group: null };
}

function keyIndex(group: GroupContext, name: string): number {
    const lower = name.toLowerCase();
    return group.keyProperties.findIndex(key => key.toLowerCase() === lower);
}

function isFirstOrLast(node: ExpressionNode): boolean {
    return node.kind === 'Function' && (node.functionName === 'First' || node.functionName === 'Last');
}

function put(row: Record<string, unknown>, key: string, value: unknown): void {
    if (Object.prototype.hasOwnProperty.call(row, key))
        throw new ExpressionEvaluationError(`The projection has two properties named '${key}'; `
            + "give one of them another name with 'as'");
    // defineProperty, so that a key such as __proto__ is an ordinary property
    Object.defineProperty(row, key, { value: value ?? null, enumerable: true, writable: true, configurable: true });
}

function string(value: unknown, fn: string): string {
    if (typeof value === 'string') return value;
    throw new ExpressionEvaluationError(`Cannot apply ${fn} function to non-string value ${Values.describe(value)}`);
}

function toDate(value: unknown, fn: string): Date {
    if (value instanceof Date) return value;
    throw new ExpressionEvaluationError(`Cannot apply ${fn} function to non-date value ${Values.describe(value)}`);
}

function dateFunction(source: unknown, name: string, fn: (date: Date) => number): unknown {
    if (source === null) return null;
    const date = toDate(source, name);
    if (Number.isNaN(date.getTime())) throw new ExpressionEvaluationError(`Cannot apply ${name} function to an invalid date`);
    return fn(date);
}

function sum(values: unknown[], name: string): number | bigint {
    let total: number | bigint | null = null;
    for (const value of values) {
        const number = Values.number(value, name);
        total = total === null ? number : Values.arithmetic('+', total, number);
    }
    return total ?? 0;
}

// The argument of offset/limit: a whole number that is not negative
function nonNegativeCount(node: FunctionNode, name: string): number {
    const args = functionArguments(node);
    const arg = args[0];
    if (args.length !== 1 || arg.kind !== 'Literal' || arg.literalType !== 'Number')
        throw new ExpressionEvaluationError(`${name} function requires one number argument`);
    const value = arg.value as number;
    if (value < 0 || !Number.isInteger(value) || value > 2_147_483_647)
        throw new ExpressionEvaluationError(`${name} function requires a whole number between 0 and 2147483647, `
            + `got ${value}`);
    return value;
}

function describeSegment(segment: ExpressionNode): string {
    return segment.kind === 'Property' ? `'${segment.name}'` : `the ${segment.kind.toLowerCase()}`;
}

function typeName(target: unknown): string {
    if (typeof target !== 'object' || target === null) return typeof target;
    return (target as object).constructor?.name ?? 'Object';
}
