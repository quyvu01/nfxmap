/**
 * The abstract syntax tree of the FxMap expression language. Every node is a plain object with a `kind`, so a tree can
 * be compared, logged or serialized as it is.
 */

/** The functions of the expression language (`:count`, `:upper`, `:orderBy`...), named as FxMap names them. */
export type FunctionType =
    // Aggregates
    | 'Count' | 'Sum' | 'Avg' | 'Min' | 'Max' | 'Any' | 'All'
    // Strings
    | 'Upper' | 'Lower' | 'Trim' | 'Substring' | 'Replace' | 'Concat' | 'Split'
    // Dates
    | 'Year' | 'Month' | 'Day' | 'Hour' | 'Minute' | 'Second' | 'DayOfWeek' | 'DaysAgo' | 'Format'
    // Math
    | 'Round' | 'Floor' | 'Ceil' | 'Abs' | 'Add' | 'Subtract' | 'Multiply' | 'Divide' | 'Mod' | 'Pow'
    // Collections: offset is Skip, limit is Take
    | 'OrderBy' | 'Skip' | 'Take' | 'First' | 'Last' | 'Distinct';

/** The aggregations of a collection. */
export type AggregationType = 'Count' | 'Sum' | 'Average' | 'Min' | 'Max';

/** The boolean functions of a collection. */
export type BooleanFunctionType = 'Any' | 'All';

/** The comparison operators. */
export type ComparisonOperator =
    | 'Equal' | 'NotEqual' | 'GreaterThan' | 'LessThan' | 'GreaterThanOrEqual' | 'LessThanOrEqual'
    | 'Contains' | 'StartsWith' | 'EndsWith';

/** The logical operators that join conditions. */
export type LogicalOperator = 'And' | 'Or';

/** The direction of a key of `:orderBy(...)`. */
export type OrderDirection = 'Asc' | 'Desc';

/** The type of a literal. */
export type LiteralType = 'String' | 'Number' | 'Boolean' | 'Null';

/** A simple property access: `Name`, or `Address?` when the access is null-safe. */
export interface PropertyNode {
    readonly kind: 'Property';
    readonly name: string;
    readonly isNullSafe: boolean;
}

/** A chain of navigations: `Country.Province.Name`. */
export interface NavigationNode {
    readonly kind: 'Navigation';
    readonly segments: readonly ExpressionNode[];
}

/** A filter of a collection: `Orders:where(Status = 'Done')`. */
export interface FilterNode {
    readonly kind: 'Filter';
    readonly source: ExpressionNode;
    readonly condition: ConditionNode;
}

/** A projection of a source (a collection, each item projected, or an object): `Orders.{Id, Total}`. */
export interface ProjectionNode {
    readonly kind: 'Projection';
    readonly source: ExpressionNode;
    readonly properties: readonly ProjectionProperty[];
}

/** A projection of the root object: `{Id, Name, Country.Name as CountryName}`. */
export interface RootProjectionNode {
    readonly kind: 'RootProjection';
    readonly properties: readonly ProjectionProperty[];
}

/**
 * A function applied to a source: `Name:upper`, `Name:substring(0, 3)`, `Items:orderBy(Name desc)`.
 * `argument` is the property of an aggregate written `:sum(Total)` (kept for compatibility); `args` are the arguments.
 */
export interface FunctionNode {
    readonly kind: 'Function';
    readonly source: ExpressionNode;
    readonly functionName: FunctionType;
    readonly argument: string | null;
    readonly args: readonly ExpressionNode[];
}

/** `:any`, `:any(condition)`, `:all`, `:all(condition)`. */
export interface BooleanFunctionNode {
    readonly kind: 'BooleanFunction';
    readonly source: ExpressionNode;
    readonly functionName: BooleanFunctionType;
    readonly condition: ConditionNode | null;
}

/** A comparison: `Status = 'Active'`, `Name:count > 3`. */
export interface BinaryConditionNode {
    readonly kind: 'BinaryCondition';
    readonly left: ExpressionNode;
    readonly operator: ComparisonOperator;
    readonly right: ExpressionNode;
}

/** Conditions joined by `&&` or `||`. */
export interface LogicalConditionNode {
    readonly kind: 'LogicalCondition';
    readonly left: ConditionNode;
    readonly operator: LogicalOperator;
    readonly right: ConditionNode;
}

/** A literal: `'text'`, `12.5`, `true`, `null`. */
export interface LiteralNode {
    readonly kind: 'Literal';
    readonly value: string | number | boolean | null;
    readonly literalType: LiteralType;
}

/** An aggregation of a collection: `Orders:sum(Total)`; `propertyName` is null for `:count` and for `:sum` of values. */
export interface AggregationNode {
    readonly kind: 'Aggregation';
    readonly source: ExpressionNode;
    readonly aggregationType: AggregationType;
    readonly propertyName: string | null;
}

/** `A ?? B`: A when it is not null, else B. `A ?? B ?? C` is `A ?? (B ?? C)`. */
export interface CoalesceNode {
    readonly kind: 'Coalesce';
    readonly left: ExpressionNode;
    readonly right: ExpressionNode;
}

/** `Condition ? WhenTrue : WhenFalse`. */
export interface TernaryNode {
    readonly kind: 'Ternary';
    readonly condition: ConditionNode;
    readonly whenTrue: ExpressionNode;
    readonly whenFalse: ExpressionNode;
}

/** `Orders:groupBy(Status)`, `Orders:groupBy(Year, Month)`. */
export interface GroupByNode {
    readonly kind: 'GroupBy';
    readonly source: ExpressionNode;
    readonly keyProperties: readonly string[];
}

/** The items of a group, in a projection after groupBy: the source of `:count` and `:sum(Total)` there. */
export interface GroupElementsNode {
    readonly kind: 'GroupElements';
}

/** A key of `:orderBy(...)`; only valid as an argument of orderBy. */
export interface SortKeyNode {
    readonly kind: 'SortKey';
    readonly name: string;
    readonly direction: OrderDirection;
}

export type ConditionNode = BinaryConditionNode | LogicalConditionNode;

export type ExpressionNode =
    | PropertyNode | NavigationNode | FilterNode | ProjectionNode | RootProjectionNode | FunctionNode
    | BooleanFunctionNode | ConditionNode | LiteralNode | AggregationNode | CoalesceNode | TernaryNode | GroupByNode
    | GroupElementsNode | SortKeyNode;

/**
 * A property of a projection: a path (`Name`, `Country.Name`), with an optional alias, or a computed expression
 * (`(Nickname ?? Name) as DisplayName`), whose alias is required.
 */
export interface ProjectionProperty {
    readonly path: string | null;
    readonly alias: string | null;
    readonly expression: ExpressionNode | null;
}

// Factories

export const Nodes = {
    property: (name: string, isNullSafe = false): PropertyNode => ({ kind: 'Property', name, isNullSafe }),
    navigation: (segments: readonly ExpressionNode[]): NavigationNode => ({ kind: 'Navigation', segments: [...segments] }),
    filter: (source: ExpressionNode, condition: ConditionNode): FilterNode => ({ kind: 'Filter', source, condition }),
    projection: (source: ExpressionNode, properties: readonly ProjectionProperty[]): ProjectionNode =>
        ({ kind: 'Projection', source, properties: [...properties] }),
    rootProjection: (properties: readonly ProjectionProperty[]): RootProjectionNode =>
        ({ kind: 'RootProjection', properties: [...properties] }),
    func: (source: ExpressionNode, functionName: FunctionType, args: readonly ExpressionNode[] = [],
           argument: string | null = null): FunctionNode =>
        ({ kind: 'Function', source, functionName, argument, args: [...args] }),
    booleanFunction: (source: ExpressionNode, functionName: BooleanFunctionType,
                      condition: ConditionNode | null = null): BooleanFunctionNode =>
        ({ kind: 'BooleanFunction', source, functionName, condition }),
    binary: (left: ExpressionNode, operator: ComparisonOperator, right: ExpressionNode): BinaryConditionNode =>
        ({ kind: 'BinaryCondition', left, operator, right }),
    logical: (left: ConditionNode, operator: LogicalOperator, right: ConditionNode): LogicalConditionNode =>
        ({ kind: 'LogicalCondition', left, operator, right }),
    string: (value: string): LiteralNode => ({ kind: 'Literal', value, literalType: 'String' }),
    number: (value: number): LiteralNode => ({ kind: 'Literal', value, literalType: 'Number' }),
    bool: (value: boolean): LiteralNode => ({ kind: 'Literal', value, literalType: 'Boolean' }),
    nullValue: (): LiteralNode => ({ kind: 'Literal', value: null, literalType: 'Null' }),
    aggregation: (source: ExpressionNode, aggregationType: AggregationType,
                  propertyName: string | null = null): AggregationNode =>
        ({ kind: 'Aggregation', source, aggregationType, propertyName }),
    coalesce: (left: ExpressionNode, right: ExpressionNode): CoalesceNode => ({ kind: 'Coalesce', left, right }),
    ternary: (condition: ConditionNode, whenTrue: ExpressionNode, whenFalse: ExpressionNode): TernaryNode =>
        ({ kind: 'Ternary', condition, whenTrue, whenFalse }),
    groupBy: (source: ExpressionNode, keyProperties: readonly string[]): GroupByNode =>
        ({ kind: 'GroupBy', source, keyProperties: [...keyProperties] }),
    groupElements: (): GroupElementsNode => ({ kind: 'GroupElements' }),
    sortKey: (name: string, direction: OrderDirection = 'Asc'): SortKeyNode => ({ kind: 'SortKey', name, direction }),
    pathProperty: (path: string, alias: string | null = null): ProjectionProperty =>
        ({ path, alias, expression: null }),
    computedProperty: (expression: ExpressionNode, alias: string): ProjectionProperty =>
        ({ path: null, alias, expression }),
} as const;

/** Whether a node is a condition. */
export function isCondition(node: ExpressionNode): node is ConditionNode {
    return node.kind === 'BinaryCondition' || node.kind === 'LogicalCondition';
}

/** The arguments of a function: `args` when there are some, else the legacy property argument of `:sum(Total)`. */
export function functionArguments(node: FunctionNode): readonly ExpressionNode[] {
    if (node.args.length > 0) return node.args;
    if (node.argument !== null) return [Nodes.property(node.argument)];
    return [];
}

/** The output key of a projection property: its alias, else the last segment of its path. */
export function outputKey(property: ProjectionProperty): string {
    if (property.alias !== null) return property.alias;
    if (property.path !== null) {
        const segments = property.path.split('.');
        return segments[segments.length - 1];
    }
    throw new Error('Computed expression requires an alias');
}

/** The segments of the path of a projection property; empty for a computed one. */
export function pathSegments(property: ProjectionProperty): string[] {
    return property.path === null ? [] : property.path.split('.');
}

// Keys of the nodes that hold no name of the language
const NOT_NAMES = new Set(['kind', 'literalType', 'functionName', 'operator', 'direction', 'aggregationType']);

/**
 * Every name an expression may read, for a data provider that loads only what is read: its identifiers, the segments
 * of its paths (`Country.Name`) and its string arguments (`:orderBy('Name')`). It may hold more than is read (a string
 * literal compared with a value), never less; the exposed names are not mapped to their properties.
 */
export function referencedNames(node: ExpressionNode): string[] {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
        if (typeof value === 'string') {
            for (const part of value.split('.')) if (part.length > 0) names.add(part);
        } else if (Array.isArray(value)) {
            for (const item of value) visit(item);
        } else if (value !== null && typeof value === 'object') {
            for (const [key, inner] of Object.entries(value)) if (!NOT_NAMES.has(key)) visit(inner);
        }
    };
    visit(node);
    return [...names];
}
