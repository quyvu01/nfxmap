import { describe, expect, it } from 'vitest';
import { type ExpressionNode, type ProjectionProperty, outputKey } from '../../src/expressions/nodes.js';
import { ExpressionParseError, parseExpression } from '../../src/expressions/parser.js';

type Kind = ExpressionNode['kind'];
type NodeOf<K extends Kind> = Extract<ExpressionNode, { kind: K }>;

/** Asserts the kind of a node and narrows it (the `isInstanceOf` + cast of the Java tests). */
function as<K extends Kind>(node: ExpressionNode | null | undefined, kind: K): NodeOf<K> {
    expect(node?.kind).toBe(kind);
    return node as NodeOf<K>;
}

const isComputed = (p: ProjectionProperty) => p.expression !== null;
const hasNavigation = (p: ProjectionProperty) => p.path !== null && p.path.includes('.');

describe('ExpressionParserFunctionsTest', () => {
    describe('Computed Projection Tests', () => {
        it('parseRootProjectionWithCoalesceExpressionReturnsCorrectNode', () => {
            const projection = as(parseExpression('{Id, (Nickname ?? Name) as DisplayName}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(projection.properties[0].path).toBe('Id');
            expect(isComputed(projection.properties[0])).toBe(false);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('DisplayName');
            const coalesce = as(projection.properties[1].expression, 'Coalesce');
            expect(as(coalesce.left, 'Property').name).toBe('Nickname');
            expect(as(coalesce.right, 'Property').name).toBe('Name');
        });

        it('parseRootProjectionWithTernaryExpressionReturnsCorrectNode', () => {
            const projection = as(
                parseExpression("{Id, (Status = 'Active' ? 'Yes' : 'No') as StatusText}"), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('StatusText');
            const ternary = as(projection.properties[1].expression, 'Ternary');
            as(ternary.condition, 'BinaryCondition');
            expect(as(ternary.whenTrue, 'Literal').value).toBe('Yes');
            expect(as(ternary.whenFalse, 'Literal').value).toBe('No');
        });

        it('parseRootProjectionWithMixedPropertiesReturnsCorrectNode', () => {
            const projection = as(
                parseExpression('{Id, Name, Country.Name as CountryName, (Nickname ?? Name) as Display}'),
                'RootProjection');
            expect(projection.properties).toHaveLength(4);

            expect(isComputed(projection.properties[0])).toBe(false);
            expect(outputKey(projection.properties[0])).toBe('Id');

            expect(isComputed(projection.properties[1])).toBe(false);
            expect(outputKey(projection.properties[1])).toBe('Name');

            expect(isComputed(projection.properties[2])).toBe(false);
            expect(outputKey(projection.properties[2])).toBe('CountryName');
            expect(hasNavigation(projection.properties[2])).toBe(true);

            expect(isComputed(projection.properties[3])).toBe(true);
            expect(outputKey(projection.properties[3])).toBe('Display');
        });

        it('parseComputedProjectionWithoutAliasThrowsException', () => {
            const expression = '{Id, (Nickname ?? Name)}';
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
            expect(() => parseExpression(expression)).toThrow('as');
        });

        it('parseFilterWithSimpleProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression("Provinces:where(Name endswith '0').{Id, Name}"), 'Projection');

            const filter = as(projection.source, 'Filter');
            expect(as(filter.source, 'Property').name).toBe('Provinces');

            expect(projection.properties).toHaveLength(2);
            expect(projection.properties[0].path).toBe('Id');
            expect(projection.properties[1].path).toBe('Name');
        });

        it('parseNonRootProjectionWithComputedExpressionReturnsCorrectStructure', () => {
            // Non-root projection (Collection.{...}) now supports computed expressions
            const projection = as(parseExpression(
                "Provinces:where(Name endswith '0').{Id, (Name endswith '0' ? Name : 'N/A') as DisplayName}"),
            'Projection');

            as(projection.source, 'Filter');

            expect(projection.properties).toHaveLength(2);

            expect(projection.properties[0].path).toBe('Id');
            expect(isComputed(projection.properties[0])).toBe(false);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('DisplayName');
            as(projection.properties[1].expression, 'Ternary');
        });
    });

    describe('String Functions', () => {
        it('parseUpperFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Name:upper'), 'Function');
            expect(func.functionName).toBe('Upper');
            expect(as(func.source, 'Property').name).toBe('Name');
        });

        it('parseLowerFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('Name:lower'), 'Function').functionName).toBe('Lower');
        });

        it('parseTrimFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('Description:trim'), 'Function').functionName).toBe('Trim');
        });

        it('parseSubstringWithOneArgReturnsFunctionNode', () => {
            const func = as(parseExpression('Name:substring(0)'), 'Function');
            expect(func.functionName).toBe('Substring');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(0);
        });

        it('parseSubstringWithTwoArgsReturnsFunctionNode', () => {
            const func = as(parseExpression('Name:substring(0, 3)'), 'Function');
            expect(func.functionName).toBe('Substring');
            expect(func.args).toHaveLength(2);
            expect(as(func.args[0], 'Literal').value).toBe(0);
            expect(as(func.args[1], 'Literal').value).toBe(3);
        });

        it('parseReplaceFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression("Name:replace('a', 'b')"), 'Function');
            expect(func.functionName).toBe('Replace');
            expect(func.args).toHaveLength(2);
            expect(as(func.args[0], 'Literal').value).toBe('a');
            expect(as(func.args[1], 'Literal').value).toBe('b');
        });

        it('parseConcatWithLiteralsReturnsFunctionNode', () => {
            const func = as(parseExpression("FirstName:concat(' ', LastName)"), 'Function');
            expect(func.functionName).toBe('Concat');
            expect(func.args).toHaveLength(2);
            expect(as(func.args[0], 'Literal').value).toBe(' ');
            expect(as(func.args[1], 'Property').name).toBe('LastName');
        });

        it('parseSplitFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression("Tags:split(',')"), 'Function');
            expect(func.functionName).toBe('Split');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(',');
        });

        it('parseChainedStringFunctionsReturnsFunctionNode', () => {
            // This parses as (Name:trim):upper
            const upperFunc = as(parseExpression('Name:trim:upper'), 'Function');
            expect(upperFunc.functionName).toBe('Upper');

            const trimFunc = as(upperFunc.source, 'Function');
            expect(trimFunc.functionName).toBe('Trim');
            as(trimFunc.source, 'Property');
        });

        it('parseSubstringWithoutArgsThrowsException', () => {
            expect(() => parseExpression('Name:substring')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Name:substring')).toThrow('requires arguments');
        });

        it('parseReplaceWithOneArgThrowsException', () => {
            expect(() => parseExpression("Name:replace('a')")).toThrow(ExpressionParseError);
            expect(() => parseExpression("Name:replace('a')")).toThrow('requires exactly 2 arguments');
        });

        it('parseSplitWithoutArgsThrowsException', () => {
            expect(() => parseExpression('Tags:split')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Tags:split')).toThrow('requires arguments');
        });

        it('parseStringFunctionInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, (Name:upper) as UpperName}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(projection.properties[0].path).toBe('Id');
            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('UpperName');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Upper');
        });
    });

    describe('Inline Functions in Projection Tests (Optional Parentheses)', () => {
        it('parseInlineFunctionWithoutAliasUsesPropertyNameAsOutputKey', () => {
            const projection = as(parseExpression('{Id, Name:upper}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(projection.properties[0].path).toBe('Id');
            expect(isComputed(projection.properties[0])).toBe(false);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Name'); // Uses property name as output key

            const func = as(projection.properties[1].expression, 'Function');
            expect(func.functionName).toBe('Upper');
            expect(as(func.source, 'Property').name).toBe('Name');
        });

        it('parseInlineFunctionWithAliasUsesAliasAsOutputKey', () => {
            const projection = as(parseExpression('{Id, Name:upper as UpperName}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('UpperName');
            as(projection.properties[1].expression, 'Function');
        });

        it('parseInlineLowerFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Name:lower as LowerName}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('LowerName');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Lower');
        });

        it('parseInlineTrimFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Description:trim}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Description');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Trim');
        });

        it('parseInlineSubstringFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Name:substring(0, 3) as Short}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Short');

            const func = as(projection.properties[1].expression, 'Function');
            expect(func.functionName).toBe('Substring');
            expect(func.args).toHaveLength(2);
        });

        it('parseInlineReplaceFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression("{Id, Name:replace('a', 'b') as ReplacedName}"), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('ReplacedName');

            const func = as(projection.properties[1].expression, 'Function');
            expect(func.functionName).toBe('Replace');
            expect(func.args).toHaveLength(2);
        });

        it('parseInlineConcatFunctionReturnsCorrectStructure', () => {
            const projection = as(
                parseExpression("{Id, FirstName:concat(' ', LastName) as FullName}"), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('FullName');

            const func = as(projection.properties[1].expression, 'Function');
            expect(func.functionName).toBe('Concat');
            expect(func.args).toHaveLength(2);
        });

        it('parseInlineChainedFunctionsReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Name:trim:upper as CleanName}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('CleanName');

            // Should be (Name:trim):upper
            const upperFunc = as(projection.properties[1].expression, 'Function');
            expect(upperFunc.functionName).toBe('Upper');

            const trimFunc = as(upperFunc.source, 'Function');
            expect(trimFunc.functionName).toBe('Trim');
            as(trimFunc.source, 'Property');
        });

        it('parseInlineFunctionWithNavigationPathReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Country.Name:upper as CountryName}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('CountryName');

            const func = as(projection.properties[1].expression, 'Function');
            expect(func.functionName).toBe('Upper');

            // Source should be NavigationNode(Country, Name)
            expect(as(func.source, 'Navigation').segments).toHaveLength(2);
        });

        it('parseInlineCountFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Orders:count as OrderCount}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('OrderCount');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Count');
        });

        it('parseMultipleInlineFunctionsReturnsCorrectStructure', () => {
            const projection = as(parseExpression(
                '{Id, Name:upper, Description:trim as TrimmedDesc, Country.Name:lower as CountryName}'), 'RootProjection');
            expect(projection.properties).toHaveLength(4);

            expect(projection.properties[0].path).toBe('Id');
            expect(isComputed(projection.properties[0])).toBe(false);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Name');

            expect(isComputed(projection.properties[2])).toBe(true);
            expect(outputKey(projection.properties[2])).toBe('TrimmedDesc');

            expect(isComputed(projection.properties[3])).toBe(true);
            expect(outputKey(projection.properties[3])).toBe('CountryName');
        });

        it('parseInlineFunctionWithSplitFunctionReturnsCorrectStructure', () => {
            const projection = as(parseExpression("{Id, Tags:split(',') as TagList}"), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('TagList');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Split');
        });

        it('parseMixedInlineAndComputedExpressionsReturnsCorrectStructure', () => {
            const projection = as(
                parseExpression('{Id, Name:upper, (Nickname ?? Name) as DisplayName}'), 'RootProjection');
            expect(projection.properties).toHaveLength(3);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Name');
            as(projection.properties[1].expression, 'Function');

            expect(isComputed(projection.properties[2])).toBe(true);
            expect(outputKey(projection.properties[2])).toBe('DisplayName');
            as(projection.properties[2].expression, 'Coalesce');
        });

        it('parseInlineFunctionInNonRootProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('Orders.{Id, ProductName:upper as Product}'), 'Projection');

            expect(projection.properties).toHaveLength(2);
            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Product');
            as(projection.properties[1].expression, 'Function');
        });

        it('parseComplexExpressionRequiresParenthesesCoalesceNeedsParens', () => {
            const projection = as(parseExpression('{Id, (Nickname ?? Name) as Display}'), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            as(projection.properties[1].expression, 'Coalesce');
        });

        it('parseComplexExpressionRequiresParenthesesTernaryNeedsParens', () => {
            const projection = as(
                parseExpression("{Id, (Status = 'Active' ? 'Yes' : 'No') as StatusText}"), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            as(projection.properties[1].expression, 'Ternary');
        });
    });

    describe('Date Functions', () => {
        it('parseYearFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('CreatedAt:year'), 'Function');
            expect(func.functionName).toBe('Year');
            expect(as(func.source, 'Property').name).toBe('CreatedAt');
        });

        it('parseMonthFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:month'), 'Function').functionName).toBe('Month');
        });

        it('parseDayFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:day'), 'Function').functionName).toBe('Day');
        });

        it('parseHourFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:hour'), 'Function').functionName).toBe('Hour');
        });

        it('parseMinuteFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:minute'), 'Function').functionName).toBe('Minute');
        });

        it('parseSecondFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:second'), 'Function').functionName).toBe('Second');
        });

        it('parseDayOfWeekFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:dayOfWeek'), 'Function').functionName).toBe('DayOfWeek');
        });

        it('parseDaysAgoFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('CreatedAt:daysAgo'), 'Function').functionName).toBe('DaysAgo');
        });

        it('parseFormatFunctionReturnsFunctionNodeWithArgument', () => {
            const func = as(parseExpression("CreatedAt:format('yyyy-MM-dd')"), 'Function');
            expect(func.functionName).toBe('Format');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe('yyyy-MM-dd');
        });

        it('parseFormatFunctionWithTimeFormatReturnsFunctionNode', () => {
            const func = as(parseExpression("CreatedAt:format('yyyy-MM-dd HH:mm:ss')"), 'Function');
            expect(func.functionName).toBe('Format');
            expect(as(func.args[0], 'Literal').value).toBe('yyyy-MM-dd HH:mm:ss');
        });

        it('parseFormatFunctionWithoutArgsThrowsException', () => {
            expect(() => parseExpression('CreatedAt:format')).toThrow(ExpressionParseError);
            expect(() => parseExpression('CreatedAt:format')).toThrow('requires');
        });

        it('parseDateFunctionInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, CreatedAt:year as Year}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('Year');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Year');
        });

        it('parseDateFunctionWithNavigationReturnsCorrectStructure', () => {
            const navNode = as(parseExpression('Order.CreatedAt:year'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);
            expect(as(navNode.segments[1], 'Function').functionName).toBe('Year');
        });

        it('parseMultipleDateFunctionsInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression(
                '{Id, CreatedAt:year as Year, CreatedAt:month as Month, CreatedAt:day as Day}'), 'RootProjection');
            expect(projection.properties).toHaveLength(4);

            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Year');
            expect(as(projection.properties[2].expression, 'Function').functionName).toBe('Month');
            expect(as(projection.properties[3].expression, 'Function').functionName).toBe('Day');
        });

        it('parseDateFormatInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression("{Id, CreatedAt:format('yyyy-MM-dd') as DateStr}"), 'RootProjection');

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('DateStr');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Format');
        });

        it('parseDateFunctionCaseInsensitiveReturnsFunctionNode', () => {
            for (const expression of ['CreatedAt:YEAR', 'CreatedAt:Year', 'CreatedAt:year'])
                expect(as(parseExpression(expression), 'Function').functionName).toBe('Year');
        });
    });

    describe('Math Functions', () => {
        it('parseFloorFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:floor'), 'Function');
            expect(func.functionName).toBe('Floor');
            expect(as(func.source, 'Property').name).toBe('Price');
        });

        it('parseCeilFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('Price:ceil'), 'Function').functionName).toBe('Ceil');
        });

        it('parseAbsFunctionReturnsFunctionNode', () => {
            expect(as(parseExpression('Balance:abs'), 'Function').functionName).toBe('Abs');
        });

        it('parseRoundFunctionWithoutArgsReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:round'), 'Function');
            expect(func.functionName).toBe('Round');
            // No arguments is an empty list
            expect(func.args).toEqual([]);
        });

        it('parseRoundFunctionWithDecimalsReturnsFunctionNodeWithArgument', () => {
            const func = as(parseExpression('Price:round(2)'), 'Function');
            expect(func.functionName).toBe('Round');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(2);
        });

        it('parseAddFunctionWithNumberReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:add(10)'), 'Function');
            expect(func.functionName).toBe('Add');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(10);
        });

        it('parseAddFunctionWithPropertyReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:add(Tax)'), 'Function');
            expect(func.functionName).toBe('Add');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Property').name).toBe('Tax');
        });

        it('parseSubtractFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:subtract(Discount)'), 'Function');
            expect(func.functionName).toBe('Subtract');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Property').name).toBe('Discount');
        });

        it('parseMultiplyFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Price:multiply(Quantity)'), 'Function');
            expect(func.functionName).toBe('Multiply');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Property').name).toBe('Quantity');
        });

        it('parseDivideFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Total:divide(Count)'), 'Function');
            expect(func.functionName).toBe('Divide');
            expect(func.args).toHaveLength(1);
        });

        it('parseModFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Value:mod(3)'), 'Function');
            expect(func.functionName).toBe('Mod');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(3);
        });

        it('parsePowFunctionReturnsFunctionNode', () => {
            const func = as(parseExpression('Value:pow(2)'), 'Function');
            expect(func.functionName).toBe('Pow');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(2);
        });

        it.each([
            ['parseAddWithoutArgsThrowsException', 'Price:add'],
            ['parseSubtractWithoutArgsThrowsException', 'Price:subtract'],
            ['parseMultiplyWithoutArgsThrowsException', 'Price:multiply'],
            ['parseDivideWithoutArgsThrowsException', 'Price:divide'],
            ['parseModWithoutArgsThrowsException', 'Value:mod'],
            ['parsePowWithoutArgsThrowsException', 'Value:pow'],
        ])('%s', (_name, expression) => {
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
            expect(() => parseExpression(expression)).toThrow('requires an argument');
        });

        it('parseMathFunctionInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Price:round(2) as RoundedPrice}'), 'RootProjection');
            expect(projection.properties).toHaveLength(2);

            expect(isComputed(projection.properties[1])).toBe(true);
            expect(outputKey(projection.properties[1])).toBe('RoundedPrice');
            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Round');
        });

        it('parseChainedMathFunctionsReturnsCorrectStructure', () => {
            // add tax first, then round
            const roundFunc = as(parseExpression('Price:add(Tax):round(2)'), 'Function');
            expect(roundFunc.functionName).toBe('Round');

            const addFunc = as(roundFunc.source, 'Function');
            expect(addFunc.functionName).toBe('Add');
            expect(as(addFunc.source, 'Property').name).toBe('Price');
        });

        it('parseMathFunctionWithNavigationReturnsCorrectStructure', () => {
            const navNode = as(parseExpression('Order.Total:floor'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);
            expect(as(navNode.segments[1], 'Function').functionName).toBe('Floor');
        });

        it('parseMultipleMathFunctionsInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression(
                '{Id, Price:floor as FloorPrice, Price:ceil as CeilPrice, Balance:abs as AbsBalance}'), 'RootProjection');
            expect(projection.properties).toHaveLength(4);

            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Floor');
            expect(as(projection.properties[2].expression, 'Function').functionName).toBe('Ceil');
            expect(as(projection.properties[3].expression, 'Function').functionName).toBe('Abs');
        });

        it('parseMathFunctionCaseInsensitiveReturnsFunctionNode', () => {
            for (const expression of ['Price:FLOOR', 'Price:Floor', 'Price:floor'])
                expect(as(parseExpression(expression), 'Function').functionName).toBe('Floor');
        });

        it('parseComplexMathExpressionReturnsCorrectStructure', () => {
            // (Price * Quantity - Discount):round(2) as chained functions
            const roundFunc = as(parseExpression('Price:multiply(Quantity):subtract(Discount):round(2)'), 'Function');
            expect(roundFunc.functionName).toBe('Round');

            const subtractFunc = as(roundFunc.source, 'Function');
            expect(subtractFunc.functionName).toBe('Subtract');

            const multiplyFunc = as(subtractFunc.source, 'Function');
            expect(multiplyFunc.functionName).toBe('Multiply');

            expect(as(multiplyFunc.source, 'Property').name).toBe('Price');
        });

        it('parseMathFunctionInFilterReturnsCorrectStructure', () => {
            const filterNode = as(parseExpression('Products:where(Price:floor > 100)'), 'Filter');
            const condition = as(filterNode.condition, 'BinaryCondition');
            expect(as(condition.left, 'Function').functionName).toBe('Floor');
        });

        it('parseMathFunctionWithNegativeNumberReturnsCorrectStructure', () => {
            const func = as(parseExpression('Value:add(-10)'), 'Function');
            expect(func.functionName).toBe('Add');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(-10);
        });

        it('parseMathFunctionWithDecimalNumberReturnsCorrectStructure', () => {
            const func = as(parseExpression('Price:multiply(1.15)'), 'Function');
            expect(func.functionName).toBe('Multiply');
            expect(func.args).toHaveLength(1);
            expect(as(func.args[0], 'Literal').value).toBe(1.15);
        });

        it('parseComplexProjectionWithMathAndStringReturnsCorrectStructure', () => {
            const projection = as(parseExpression(
                '{Id, Name:upper, Price:round(2) as RoundedPrice, (Balance:abs) as AbsBalance}'), 'RootProjection');
            expect(projection.properties).toHaveLength(4);

            expect(as(projection.properties[1].expression, 'Function').functionName).toBe('Upper');
            expect(as(projection.properties[2].expression, 'Function').functionName).toBe('Round');
            expect(as(projection.properties[3].expression, 'Function').functionName).toBe('Abs');
        });

        it('parseMathFunctionAfterAggregationReturnsAggregationNode', () => {
            const sumAgg = as(parseExpression("Orders:where(Status = 'Done'):sum(Total)"), 'Aggregation');
            expect(sumAgg.aggregationType).toBe('Sum');
            expect(sumAgg.propertyName).toBe('Total');
            as(sumAgg.source, 'Filter');
        });

        it('parseMathFunctionAfterCountFunctionReturnsCorrectStructure', () => {
            const addFunc = as(parseExpression("Orders:where(Status = 'Done'):count:add(10)"), 'Function');
            expect(addFunc.functionName).toBe('Add');

            const countFunc = as(addFunc.source, 'Function');
            expect(countFunc.functionName).toBe('Count');
            as(countFunc.source, 'Filter');
        });
    });
});
