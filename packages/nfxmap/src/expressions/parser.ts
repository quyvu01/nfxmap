import {
    type AggregationType,
    type BooleanFunctionType,
    type ComparisonOperator,
    type ConditionNode,
    type ExpressionNode,
    type FunctionType,
    type GroupByNode,
    type LiteralNode,
    type OrderDirection,
    type ProjectionNode,
    type ProjectionProperty,
    type RootProjectionNode,
    isCondition,
    Nodes,
} from './nodes.js';
import { type Token, type TokenType, tokenize } from './tokenizer.js';

/** Thrown when an expression is not valid. */
export class ExpressionParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExpressionParseError';
    }
}

const FUNCTION_NAMES: ReadonlyMap<string, FunctionType> = new Map<string, FunctionType>([
    // Aggregates
    ['count', 'Count'], ['sum', 'Sum'], ['avg', 'Avg'], ['min', 'Min'], ['max', 'Max'],
    // Strings
    ['upper', 'Upper'], ['lower', 'Lower'], ['trim', 'Trim'], ['substring', 'Substring'], ['replace', 'Replace'],
    ['concat', 'Concat'], ['split', 'Split'],
    // Dates
    ['year', 'Year'], ['month', 'Month'], ['day', 'Day'], ['hour', 'Hour'], ['minute', 'Minute'],
    ['second', 'Second'], ['dayofweek', 'DayOfWeek'], ['daysago', 'DaysAgo'], ['format', 'Format'],
    // Math
    ['round', 'Round'], ['floor', 'Floor'], ['ceil', 'Ceil'], ['abs', 'Abs'], ['add', 'Add'],
    ['subtract', 'Subtract'], ['multiply', 'Multiply'], ['divide', 'Divide'], ['mod', 'Mod'], ['pow', 'Pow'],
    // Collections: offset is Skip, limit is Take
    ['orderby', 'OrderBy'], ['offset', 'Skip'], ['limit', 'Take'], ['first', 'First'], ['last', 'Last'],
    ['distinct', 'Distinct'],
]);

const AGGREGATION_NAMES: ReadonlyMap<string, AggregationType> = new Map<string, AggregationType>([
    ['count', 'Count'], ['sum', 'Sum'], ['avg', 'Average'], ['min', 'Min'], ['max', 'Max'],
]);

const BOOLEAN_FUNCTION_NAMES: ReadonlyMap<string, BooleanFunctionType> = new Map<string, BooleanFunctionType>([
    ['any', 'Any'], ['all', 'All'],
]);

const STRING_FUNCTIONS = new Set<FunctionType>(['Upper', 'Lower', 'Trim', 'Substring', 'Replace', 'Concat', 'Split']);
const DATE_FUNCTIONS = new Set<FunctionType>(
    ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second', 'DayOfWeek', 'DaysAgo', 'Format']);
const MATH_FUNCTIONS = new Set<FunctionType>(
    ['Round', 'Floor', 'Ceil', 'Abs', 'Add', 'Subtract', 'Multiply', 'Divide', 'Mod', 'Pow']);
const COLLECTION_FUNCTIONS = new Set<FunctionType>(['OrderBy', 'Skip', 'Take', 'First', 'Last', 'Distinct']);

const COMPARISON_OPERATORS: ReadonlyMap<TokenType, ComparisonOperator> = new Map<TokenType, ComparisonOperator>([
    ['Equal', 'Equal'], ['NotEqual', 'NotEqual'], ['GreaterThan', 'GreaterThan'], ['LessThan', 'LessThan'],
    ['GreaterThanOrEqual', 'GreaterThanOrEqual'], ['LessThanOrEqual', 'LessThanOrEqual'],
    ['Contains', 'Contains'], ['StartsWith', 'StartsWith'], ['EndsWith', 'EndsWith'],
]);

/**
 * Parses an expression into its syntax tree.
 *
 * Grammar (with precedence from low to high):
 * ```
 * Expression         := TernaryExpr
 * TernaryExpr        := CoalesceExpr (Condition '?' Expression ':' Expression)?
 * CoalesceExpr       := PrimaryExpr ('??' CoalesceExpr)?
 * PrimaryExpr        := RootProjection | Literal | NavigationExpr
 * NavigationExpr     := Segment ('.' Segment)* ('.' Projection)?
 * RootProjection     := '{' ProjectionProperty (',' ProjectionProperty)* '}'
 * ProjectionProperty := PropertyPath (':' Function)* ('as' Identifier)? | '(' Expression ')' 'as' Identifier
 * Segment            := Identifier ('?')? (':' Function)*
 * Condition          := OrCondition
 * OrCondition        := AndCondition (('||' | 'or') AndCondition)*
 * AndCondition       := Comparison (('&&' | 'and' | ',') Comparison)*
 * Comparison         := FieldPath Operator Value
 * Function           := FunctionName ('(' Arguments ')')?
 * ```
 *
 * @throws ExpressionParseError when the expression is not valid
 * @throws ExpressionTokenizeError when it has a character that is not part of the language
 */
export function parseExpression(expression: string): ExpressionNode {
    const parser = new ExpressionParser(tokenize(expression));
    const result = parser.parseExpression();
    // The whole text must be part of the expression: a rest that is left would be silently ignored
    parser.expectEnd();
    return result;
}

/** The parser over a list of tokens. Most callers use {@link parseExpression}. */
export class ExpressionParser {
    private position = 0;

    constructor(private readonly tokens: readonly Token[]) {
    }

    /** Parses an expression, starting with the ternary (the lowest precedence). */
    parseExpression(): ExpressionNode {
        return this.parseTernaryExpression();
    }

    /** Throws when tokens are left after the expression. */
    expectEnd(): void {
        if (!this.isAtEnd()) {
            const rest = this.current();
            throw new ExpressionParseError(`Unexpected '${rest.value}' at position ${rest.position}`);
        }
    }

    private parseTernaryExpression(): ExpressionNode {
        const expr = this.parseCoalesceExpression();

        // A ternary condition is: expr op value ? whenTrue : whenFalse
        if (this.isComparisonOperator()) {
            const op = this.parseComparisonOperator();
            const rightValue = this.parseValue();
            // More comparisons joined by && and ||: Name = 'John' && Score > 80 ? 'Hit' : 'Miss'
            const condition = this.parseLogicalRest(Nodes.binary(expr, op, rightValue));

            if (this.match('Question')) {
                const whenTrue = this.parseTernaryBranch();
                this.consume('Colon', "Expected ':' in ternary expression");
                const whenFalse = this.parseExpression();
                return Nodes.ternary(condition, whenTrue, whenFalse);
            }

            // Without a ternary, this is just a condition (unusual at the top level, but valid)
            return condition;
        }

        // An expression that is already a boolean (Orders:any) followed by '?'
        if (this.check('Question') && (expr.kind === 'BooleanFunction' || isCondition(expr))) {
            this.match('Question');
            const whenTrue = this.parseTernaryBranch();
            this.consume('Colon', "Expected ':' in ternary expression");
            const whenFalse = this.parseExpression();
            return Nodes.ternary(toCondition(expr), whenTrue, whenFalse);
        }

        return expr;
    }

    /** The whenTrue branch of a ternary: it stops at the ':' that separates the branches. */
    private parseTernaryBranch(): ExpressionNode {
        const left = this.parsePrimaryBranchExpression();
        if (this.match('QuestionQuestion')) return Nodes.coalesce(left, this.parseTernaryBranch());
        return left;
    }

    private parsePrimaryBranchExpression(): ExpressionNode {
        if (this.check('OpenBrace')) return this.parseRootProjection();
        if (this.isLiteral()) return this.parseValue();

        // A navigation whose ':' may be the separator of the ternary
        const segments: ExpressionNode[] = [this.parseSegmentWithoutTrailingFunction()];
        while (this.match('Dot')) {
            if (this.check('OpenBrace')) return this.parseProjection(navigationOf(segments));
            segments.push(this.parseSegmentWithoutTrailingFunction());
        }
        return navigationOf(segments);
    }

    /**
     * A segment whose ':' is a function only when a known function name follows it; otherwise the ':' is the
     * separator of the ternary.
     */
    private parseSegmentWithoutTrailingFunction(): ExpressionNode {
        const propertyName = this.consume('Identifier', 'Expected property name').value;
        const isNullSafe = this.match('Question');
        let result: ExpressionNode = Nodes.property(propertyName, isNullSafe);

        if (this.check('Colon')) {
            const saved = this.position;
            this.advance();
            if (this.check('Identifier') && isKnownFunctionName(this.current().value.toLowerCase())) {
                result = this.parseFunctionOrAggregation(result);
            } else {
                // Not a function: this ':' belongs to the ternary
                this.position = saved;
            }
        }

        this.checkSegmentEnd();
        return result;
    }

    /** A ?? B ?? C is A ?? (B ?? C). */
    private parseCoalesceExpression(): ExpressionNode {
        const left = this.parsePrimaryExpression();
        if (this.match('QuestionQuestion')) return Nodes.coalesce(left, this.parseCoalesceExpression());
        return left;
    }

    private parsePrimaryExpression(): ExpressionNode {
        if (this.check('OpenBrace')) return this.parseRootProjection();
        // Literals (the right side of a ternary or a coalesce)
        if (this.isLiteral()) return this.parseValue();
        return this.parseNavigationExpression();
    }

    private isLiteral(): boolean {
        return this.check('String') || this.check('Number') || this.check('Boolean') || this.check('Null');
    }

    /** Segment ('.' Segment)*, ending with an optional projection .{...} */
    private parseNavigationExpression(): ExpressionNode {
        const segments: ExpressionNode[] = [this.parseSegment()];
        while (this.match('Dot')) {
            if (this.check('OpenBrace')) return this.parseProjection(navigationOf(segments));
            segments.push(this.parseSegment());
        }

        if (this.check('OpenBrace'))
            throw new ExpressionParseError(`Projection requires '.' before '{' at position ${this.current().position}`);
        return navigationOf(segments);
    }

    /** Property, Property?, Property:function... */
    private parseSegment(): ExpressionNode {
        const propertyName = this.consume('Identifier', 'Expected property name').value;
        const isNullSafe = this.match('Question');
        let result: ExpressionNode = Nodes.property(propertyName, isNullSafe);
        if (this.match('Colon')) result = this.parseFunctionOrAggregation(result);
        this.checkSegmentEnd();
        return result;
    }

    private checkSegmentEnd(): void {
        // The filter Name(condition) was removed in 5.0: it is the function :where(condition)
        if (this.check('OpenParen')) throw this.filterRemoved();
        // The indexer syntax [skip take asc|desc Name] was removed in 5.0
        if (this.check('OpenBracket')) throw this.indexerRemoved();
        if (this.check('Identifier'))
            throw new ExpressionParseError(
                `Property navigation requires '.' before identifier at position ${this.current().position}`);
    }

    /** A function, the ':' being consumed, and the functions chained after it. */
    private parseFunctionOrAggregation(source: ExpressionNode): ExpressionNode {
        const funcToken = this.consume('Identifier', "Expected function name after ':'");
        const funcName = funcToken.value.toLowerCase();

        // groupBy and where are not functions of the FunctionType
        if (funcName === 'groupby') return this.parseGroupByFunction(source, funcToken);
        if (funcName === 'where') return this.parseWhereFunction(source, funcToken);

        const booleanType = BOOLEAN_FUNCTION_NAMES.get(funcName);
        if (booleanType !== undefined) {
            let result: ExpressionNode = this.parseBooleanFunction(source, booleanType);
            while (this.match('Colon')) result = this.parseFunctionOrAggregation(result);
            return result;
        }

        const functionType = FUNCTION_NAMES.get(funcName);
        if (functionType === undefined)
            throw new ExpressionParseError(`Unknown function '${funcName}' at position ${funcToken.position}`);

        let result: ExpressionNode;
        if (STRING_FUNCTIONS.has(functionType)) {
            result = this.parseStringFunction(source, functionType, funcToken);
        } else if (DATE_FUNCTIONS.has(functionType)) {
            result = this.parseDateFunction(source, functionType, funcToken);
        } else if (MATH_FUNCTIONS.has(functionType)) {
            result = this.parseMathFunction(source, functionType, funcToken);
        } else if (COLLECTION_FUNCTIONS.has(functionType)) {
            result = this.parseCollectionFunction(source, functionType, funcToken);
        } else {
            let argument: string | null = null;
            // :sum(Total)
            if (this.match('OpenParen')) {
                argument = this.consume('Identifier', 'Expected property name in function argument').value;
                this.consume('CloseParen', "Expected ')' after function argument");
            }
            // count without an argument is a function (it is also the length of a string); the rest aggregate
            result = argument !== null || functionType !== 'Count'
                ? Nodes.aggregation(source, AGGREGATION_NAMES.get(funcName)!, argument)
                : Nodes.func(source, functionType);
        }

        // Chained functions: :add(10):round(2), :trim:upper
        while (this.match('Colon')) result = this.parseFunctionOrAggregation(result);
        return result;
    }

    /** :year, :month... take no argument; :format(pattern) requires one. */
    private parseDateFunction(source: ExpressionNode, functionType: FunctionType, funcToken: Token): ExpressionNode {
        if (functionType !== 'Format') return Nodes.func(source, functionType);
        if (!this.match('OpenParen'))
            throw new ExpressionParseError(
                `Function 'format' requires a format pattern argument at position ${funcToken.position}`);
        const pattern = this.parseFunctionArgument();
        this.consume('CloseParen', "Expected ')' after format argument");
        return Nodes.func(source, functionType, [pattern]);
    }

    /** :floor, :ceil, :abs take no argument; :round has an optional one; the operations require one. */
    private parseMathFunction(source: ExpressionNode, functionType: FunctionType, funcToken: Token): ExpressionNode {
        switch (functionType) {
            case 'Floor':
            case 'Ceil':
            case 'Abs':
                return Nodes.func(source, functionType);
            case 'Round':
                if (this.match('OpenParen')) {
                    const decimals = this.parseFunctionArgument();
                    this.consume('CloseParen', "Expected ')' after round argument");
                    return Nodes.func(source, functionType, [decimals]);
                }
                // No argument: round to 0 decimal places
                return Nodes.func(source, functionType);
            default: {
                if (!this.match('OpenParen'))
                    throw new ExpressionParseError(
                        `Function '${funcToken.value}' requires an argument at position ${funcToken.position}`);
                const operand = this.parseFunctionArgument();
                this.consume('CloseParen', `Expected ')' after ${funcToken.value} argument`);
                return Nodes.func(source, functionType, [operand]);
            }
        }
    }

    /**
     * :orderBy(Key [asc|desc], ...), :offset(n), :limit(n), :first, :last, :distinct(Property).
     */
    private parseCollectionFunction(source: ExpressionNode, functionType: FunctionType,
                                    funcToken: Token): ExpressionNode {
        switch (functionType) {
            case 'First':
            case 'Last':
                return Nodes.func(source, functionType);
            case 'OrderBy': {
                if (!this.match('OpenParen'))
                    throw new ExpressionParseError(
                        `Function 'orderBy' requires a property argument at position ${funcToken.position}`);
                // Each key is a property with an optional direction; the keys are separated by ','
                const keys: ExpressionNode[] = [];
                do {
                    const name = this.consume('Identifier', 'Expected property name in orderBy').value;
                    let direction: OrderDirection = 'Asc';
                    // 'asc' is the default, so it may be left out or written
                    if (this.match('Desc')) direction = 'Desc';
                    else this.match('Asc');
                    keys.push(Nodes.sortKey(name, direction));
                } while (this.match('Comma'));
                this.consume('CloseParen', "Expected ')' after orderBy argument");
                return Nodes.func(source, functionType, keys);
            }
            default: {
                // offset(n), limit(n): the number is validated when the expression is evaluated; distinct(Property)
                const name = functionType === 'Skip' ? 'offset' : functionType === 'Take' ? 'limit' : 'distinct';
                const kind = functionType === 'Distinct' ? 'a property' : 'a number';
                if (!this.match('OpenParen'))
                    throw new ExpressionParseError(
                        `Function '${name}' requires ${kind} argument at position ${funcToken.position}`);
                const argument = this.parseFunctionArgument();
                this.consume('CloseParen', `Expected ')' after ${name} argument`);
                return Nodes.func(source, functionType, [argument]);
            }
        }
    }

    /** :groupBy(Property1, Property2, ...), and the projection or the functions that follow it. */
    private parseGroupByFunction(source: ExpressionNode, funcToken: Token): ExpressionNode {
        if (!this.match('OpenParen'))
            throw new ExpressionParseError(
                `Function 'groupBy' requires at least one property argument at position ${funcToken.position}`);

        const keyProperties = [this.consume('Identifier', 'Expected property name for groupBy key').value];
        while (this.match('Comma')) keyProperties.push(this.consume('Identifier', "Expected property name after ','").value);
        this.consume('CloseParen', "Expected ')' after groupBy arguments");

        const groupBy = Nodes.groupBy(source, keyProperties);

        // A projection after groupBy: :groupBy(Status).{Status, :count}
        if (this.match('Dot')) {
            if (this.check('OpenBrace')) return this.parseGroupByProjection(groupBy);
            throw new ExpressionParseError(
                `Expected '{' for projection after groupBy at position ${this.current().position}`);
        }

        // A function after groupBy (without a projection)
        if (this.match('Colon')) return this.parseFunctionOrAggregation(groupBy);
        return groupBy;
    }

    private parseGroupByProjection(groupBy: GroupByNode): ProjectionNode {
        this.consume('OpenBrace', "Expected '{' for projection");
        const properties: ProjectionProperty[] = [];
        do {
            properties.push(this.parseGroupByProjectionProperty());
        } while (this.match('Comma'));
        this.consume('CloseBrace', "Expected '}' after projection");
        return Nodes.projection(groupBy, properties);
    }

    /**
     * A property of a projection after groupBy: a key property, an aggregation of the group (`:count`,
     * `:sum(Total)`), a computed expression (`(:count > 10 ? 'High' : 'Low') as Volume`) or an inner projection of
     * the items (`{Id, Total} as Items`).
     */
    private parseGroupByProjectionProperty(): ProjectionProperty {
        if (this.match('OpenParen')) {
            const expression = this.parseGroupByExpression();
            this.consume('CloseParen', "Expected ')' after computed expression");
            this.consume('As', "Computed expression requires 'as' alias");
            const alias = this.consume('Identifier', 'Expected alias name').value;
            return Nodes.computedProperty(expression, alias);
        }

        if (this.check('OpenBrace')) {
            const inner = this.parseProjection(Nodes.groupElements());
            this.consume('As', "Inner projection requires 'as' alias");
            const alias = this.consume('Identifier', 'Expected alias name').value;
            return Nodes.computedProperty(inner, alias);
        }

        if (this.match('Colon')) {
            const fn = this.parseFunctionOrAggregation(Nodes.groupElements());
            const alias = this.match('As') ? this.consume('Identifier', 'Expected alias name').value : null;
            return Nodes.computedProperty(fn, alias ?? defaultAlias(fn));
        }

        const name = this.consume('Identifier', 'Expected property name').value;
        const alias = this.match('As') ? this.consume('Identifier', 'Expected alias name').value : null;
        return Nodes.pathProperty(name, alias);
    }

    /** An expression of a projection after groupBy, where :function applies to the items of the group. */
    private parseGroupByExpression(): ExpressionNode {
        const expr = this.parseGroupByCoalesceExpression();
        if (this.isComparisonOperator()) {
            const op = this.parseComparisonOperator();
            const condition = Nodes.binary(expr, op, this.parseValue());
            if (this.match('Question')) {
                const whenTrue = this.parseGroupByCoalesceExpression();
                this.consume('Colon', "Expected ':' in ternary expression");
                return Nodes.ternary(condition, whenTrue, this.parseGroupByExpression());
            }
            return condition;
        }
        return expr;
    }

    private parseGroupByCoalesceExpression(): ExpressionNode {
        let left = this.parseGroupByPrimaryExpression();
        while (this.match('QuestionQuestion')) left = Nodes.coalesce(left, this.parseGroupByPrimaryExpression());
        return left;
    }

    private parseGroupByPrimaryExpression(): ExpressionNode {
        if (this.match('Colon')) return this.parseFunctionOrAggregation(Nodes.groupElements());
        return this.parsePrimaryExpression();
    }

    /** :upper, :lower, :trim take no argument; :substring, :replace, :concat, :split require theirs. */
    private parseStringFunction(source: ExpressionNode, functionType: FunctionType, funcToken: Token): ExpressionNode {
        if (functionType === 'Upper' || functionType === 'Lower' || functionType === 'Trim')
            return Nodes.func(source, functionType);

        if (!this.match('OpenParen'))
            throw new ExpressionParseError(
                `Function '${funcToken.value}' requires arguments at position ${funcToken.position}`);

        const args = [this.parseFunctionArgument()];
        while (this.match('Comma')) args.push(this.parseFunctionArgument());
        this.consume('CloseParen', `Expected ')' after ${funcToken.value} arguments`);

        const count = args.length;
        const at = `at position ${funcToken.position}`;
        if (functionType === 'Substring' && (count < 1 || count > 2))
            throw new ExpressionParseError(`substring requires 1 or 2 arguments ${at}`);
        if (functionType === 'Replace' && count !== 2)
            throw new ExpressionParseError(`replace requires exactly 2 arguments ${at}`);
        if (functionType === 'Split' && count !== 1)
            throw new ExpressionParseError(`split requires exactly 1 argument ${at}`);

        return Nodes.func(source, functionType, args);
    }

    /** An argument of a function: a string, a number or a property reference. */
    private parseFunctionArgument(): ExpressionNode {
        if (this.match('String')) return Nodes.string(this.previous().value);
        if (this.match('Number')) return Nodes.number(parseNumber(this.previous()));
        if (this.check('Identifier')) return Nodes.property(this.advance().value);
        throw new ExpressionParseError(
            `Expected argument (string, number, or property) at position ${this.current().position}`);
    }

    /** :where(condition) and the functions that follow it. */
    private parseWhereFunction(source: ExpressionNode, funcToken: Token): ExpressionNode {
        if (!this.match('OpenParen'))
            throw new ExpressionParseError(`Function 'where' requires a condition at position ${funcToken.position}`);
        const condition = this.parseOrCondition();
        this.consume('CloseParen', "Expected ')' after where condition");

        let result: ExpressionNode = Nodes.filter(source, condition);
        // Chained functions: :where(...):orderBy(...):first
        while (this.match('Colon')) result = this.parseFunctionOrAggregation(result);
        return result;
    }

    /** The filter of the versions before 5.0, `Orders(Status = 'Done')`, was replaced by the function :where. */
    private filterRemoved(): ExpressionParseError {
        return new ExpressionParseError(`The filter '(...)' at position ${this.current().position}`
            + ' is no longer supported (removed in 5.0). '
            + "Use the function :where(condition): Orders(Status = 'Done') is Orders:where(Status = 'Done')");
    }

    /** The indexer of the versions before 5.0 was replaced by the functions. */
    private indexerRemoved(): ExpressionParseError {
        return new ExpressionParseError(`The indexer '[...]' at position ${this.current().position}`
            + ' is no longer supported (removed in 5.0). Use the functions: '
            + "'[asc Date]' is ':orderBy(Date)', '[0 asc Date]' is ':orderBy(Date):first', "
            + "'[-1 asc Date]' is ':orderBy(Date):last', '[5 10 desc Date]' is ':orderBy(Date desc):offset(5):limit(10)'");
    }

    /** :any, :any(condition), :all, :all(condition), the name being consumed. */
    private parseBooleanFunction(source: ExpressionNode, functionType: BooleanFunctionType): ExpressionNode {
        let condition: ConditionNode | null = null;
        if (this.match('OpenParen')) {
            condition = this.parseOrCondition();
            this.consume('CloseParen', "Expected ')' after boolean function condition");
        }
        return Nodes.booleanFunction(source, functionType, condition);
    }

    /**
     * The comparisons that follow the first one of a condition outside of a filter: && binds tighter than ||. A comma
     * does not join them here (it separates the items of a projection).
     */
    private parseLogicalRest(first: ConditionNode): ConditionNode {
        let left = first;
        while (this.match('And')) left = Nodes.logical(left, 'And', this.parseComparison());
        while (this.match('Or')) {
            let right = this.parseComparison();
            while (this.match('And')) right = Nodes.logical(right, 'And', this.parseComparison());
            left = Nodes.logical(left, 'Or', right);
        }
        return left;
    }

    /** A || B || C */
    private parseOrCondition(): ConditionNode {
        let left = this.parseAndCondition();
        while (this.match('Or')) left = Nodes.logical(left, 'Or', this.parseAndCondition());
        return left;
    }

    /** A && B && C; a comma is AND too */
    private parseAndCondition(): ConditionNode {
        let left = this.parseComparison();
        while (this.match('And') || this.match('Comma')) left = Nodes.logical(left, 'And', this.parseComparison());
        return left;
    }

    /** Name = 'value', Count > 3, Name:count >= 5 */
    private parseComparison(): ConditionNode {
        const left = this.parseFieldPath();
        const op = this.parseComparisonOperator();
        return Nodes.binary(left, op, this.parseValue());
    }

    /** Name, Name:count, User.Name */
    private parseFieldPath(): ExpressionNode {
        const segments: ExpressionNode[] = [];
        do {
            const name = this.consume('Identifier', 'Expected property name').value;
            let node: ExpressionNode = Nodes.property(name);
            if (this.match('Colon')) {
                const funcToken = this.consume('Identifier', "Expected function name after ':'");
                const funcType = FUNCTION_NAMES.get(funcToken.value.toLowerCase());
                if (funcType === undefined)
                    throw new ExpressionParseError(
                        `Unknown function '${funcToken.value}' at position ${funcToken.position}`);
                node = Nodes.func(node, funcType);
            }
            segments.push(node);
        } while (this.match('Dot') && this.check('Identifier') && !this.isComparisonOperator());
        return navigationOf(segments);
    }

    private parseComparisonOperator(): ComparisonOperator {
        const operator = COMPARISON_OPERATORS.get(this.current().type);
        if (operator === undefined || this.isAtEnd())
            throw new ExpressionParseError(`Expected comparison operator at position ${this.current().position}`);
        this.advance();
        return operator;
    }

    private parseValue(): LiteralNode {
        if (this.match('String')) return Nodes.string(this.previous().value);
        if (this.match('Number')) return Nodes.number(parseNumber(this.previous()));
        if (this.match('Boolean')) return Nodes.bool(this.previous().value.toLowerCase() === 'true');
        if (this.match('Null')) return Nodes.nullValue();
        throw new ExpressionParseError(`Expected value at position ${this.current().position}`);
    }

    /** .{Id, Name, Description}, the '.' being consumed. */
    private parseProjection(source: ExpressionNode): ProjectionNode {
        this.consume('OpenBrace', "Expected '{' for projection");
        const properties = [this.parseProjectionProperty()];
        while (this.match('Comma')) properties.push(this.parseProjectionProperty());
        this.consume('CloseBrace', "Expected '}' after projection");
        return Nodes.projection(source, properties);
    }

    /** {Id, Name, Country.Name as CountryName} */
    private parseRootProjection(): RootProjectionNode {
        this.consume('OpenBrace', "Expected '{' for root projection");
        const properties = [this.parseProjectionProperty()];
        while (this.match('Comma')) properties.push(this.parseProjectionProperty());
        this.consume('CloseBrace', "Expected '}' after projection");
        return Nodes.rootProjection(properties);
    }

    /**
     * A property of a projection: a path (`Name`, `Country.Name`), with functions (`Name:upper`), an alias
     * (`Country.Name as CountryName`), or a computed expression (`(Nickname ?? Name) as DisplayName`).
     */
    private parseProjectionProperty(): ProjectionProperty {
        if (this.check('OpenParen')) return this.parseComputedProjectionProperty();

        const pathParts = [this.consume('Identifier', 'Expected property name in projection').value];
        while (this.match('Dot')) {
            // Stop at a nested projection
            if (this.check('OpenBrace')) break;
            pathParts.push(this.consume('Identifier', "Expected property name after '.'").value);
        }

        if (this.check('Colon')) return this.parseInlineFunctionProperty(pathParts);

        const alias = this.match('As') ? this.consume('Identifier', "Expected alias name after 'as'").value : null;
        return Nodes.pathProperty(pathParts.join('.'), alias);
    }

    /** Name:upper, Name:substring(0, 3) as Short, Name:trim:upper */
    private parseInlineFunctionProperty(pathParts: string[]): ProjectionProperty {
        let source: ExpressionNode = pathParts.length === 1
            ? Nodes.property(pathParts[0])
            : Nodes.navigation(pathParts.map(part => Nodes.property(part)));

        while (this.match('Colon')) source = this.parseFunctionOrAggregation(source);

        const alias = this.match('As') ? this.consume('Identifier', "Expected alias name after 'as'").value : null;
        // Without an alias, the output key is the property name: {Name:upper} is "Name"
        return Nodes.computedProperty(source, alias ?? pathParts[pathParts.length - 1]);
    }

    /** (expression) as Alias; the alias is required. */
    private parseComputedProjectionProperty(): ProjectionProperty {
        this.consume('OpenParen', "Expected '(' for computed expression");
        const expression = this.parseExpression();
        this.consume('CloseParen', "Expected ')' after computed expression");
        this.consume('As', "Expected 'as' keyword after computed expression - alias is required");
        const alias = this.consume('Identifier', "Expected alias name after 'as'").value;
        return Nodes.computedProperty(expression, alias);
    }

    // Helpers

    private isComparisonOperator(): boolean {
        return COMPARISON_OPERATORS.has(this.current().type);
    }

    private current(): Token {
        return this.position < this.tokens.length ? this.tokens[this.position] : this.tokens[this.tokens.length - 1];
    }

    private previous(): Token {
        return this.tokens[this.position - 1];
    }

    private isAtEnd(): boolean {
        return this.current().type === 'EndOfExpression';
    }

    private check(type: TokenType): boolean {
        return !this.isAtEnd() && this.current().type === type;
    }

    private match(type: TokenType): boolean {
        if (!this.check(type)) return false;
        this.position++;
        return true;
    }

    private advance(): Token {
        if (!this.isAtEnd()) this.position++;
        return this.previous();
    }

    private consume(type: TokenType, message: string): Token {
        if (this.check(type)) return this.advance();
        const current = this.current();
        throw new ExpressionParseError(`${message}. Got '${current.type}' at position ${current.position}`);
    }
}

function navigationOf(segments: ExpressionNode[]): ExpressionNode {
    return segments.length === 1 ? segments[0] : Nodes.navigation(segments);
}

function isKnownFunctionName(name: string): boolean {
    return FUNCTION_NAMES.has(name) || BOOLEAN_FUNCTION_NAMES.has(name) || AGGREGATION_NAMES.has(name)
        || name === 'where';
}

/** A condition as it is; a boolean function (Orders:any) as `Orders:any = true`. */
function toCondition(expr: ExpressionNode): ConditionNode {
    if (isCondition(expr)) return expr;
    if (expr.kind === 'BooleanFunction') return Nodes.binary(expr, 'Equal', Nodes.bool(true));
    throw new ExpressionParseError(`Expected a condition expression for ternary operator. Got ${expr.kind}`);
}

/** The output name of an aggregation of a group that has no alias. */
function defaultAlias(expression: ExpressionNode): string {
    if (expression.kind === 'Function') return expression.functionName;
    if (expression.kind === 'Aggregation') return expression.aggregationType;
    if (expression.kind === 'Filter') return 'FilteredItems';
    return 'Value';
}

function parseNumber(token: Token): number {
    // Number() accepts more than the language does ('0x10', ' 1'); the tokenizer only gives digits, '-' and '.'
    const value = /^-?(\d+\.?\d*|\.\d+)$/.test(token.value) ? Number(token.value) : Number.NaN;
    if (Number.isNaN(value))
        throw new ExpressionParseError(`Invalid number '${token.value}' at position ${token.position}`);
    return value;
}
