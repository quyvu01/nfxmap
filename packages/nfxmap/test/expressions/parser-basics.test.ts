import { describe, expect, it } from 'vitest';
import {
    type ComparisonOperator,
    type ExpressionNode,
    type FunctionNode,
    type FunctionType,
    type OrderDirection,
    type ProjectionProperty,
    type RootProjectionNode,
    functionArguments,
    Nodes,
    outputKey,
    pathSegments,
} from '../../src/expressions/nodes.js';
import { ExpressionParseError, parseExpression } from '../../src/expressions/parser.js';

type Kind = ExpressionNode['kind'];
type NodeOf<K extends Kind> = Extract<ExpressionNode, { kind: K }>;

/** Asserts the kind of a node and narrows it (the `isInstanceOf` + cast of the Java tests). */
function as<K extends Kind>(node: ExpressionNode | null | undefined, kind: K): NodeOf<K> {
    expect(node?.kind).toBe(kind);
    return node as NodeOf<K>;
}

const hasNavigation = (p: ProjectionProperty) => p.path !== null && p.path.includes('.');

describe('ExpressionParserBasicsTest', () => {
    describe('Simple Property Tests', () => {
        it('parseSimplePropertyReturnsPropertyNode', () => {
            const propertyNode = as(parseExpression('Name'), 'Property');
            expect(propertyNode.name).toBe('Name');
            expect(propertyNode.isNullSafe).toBe(false);
        });

        it('parseNullSafePropertyReturnsPropertyNodeWithNullSafe', () => {
            const propertyNode = as(parseExpression('Name?'), 'Property');
            expect(propertyNode.name).toBe('Name');
            expect(propertyNode.isNullSafe).toBe(true);
        });
    });

    describe('Navigation Tests', () => {
        it('parseNavigationReturnsNavigationNode', () => {
            const navNode = as(parseExpression('Country.Name'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);
        });

        it('parseDeepNavigationReturnsNavigationNode', () => {
            const navNode = as(parseExpression('Country.Province.City.Name'), 'Navigation');
            expect(navNode.segments).toHaveLength(4);
        });

        it('parseNullSafeNavigationReturnsNavigationNodeWithNullSafe', () => {
            const navNode = as(parseExpression('Country?.Name'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            const firstSegment = as(navNode.segments[0], 'Property');
            expect(firstSegment.name).toBe('Country');
            expect(firstSegment.isNullSafe).toBe(true);
        });
    });

    describe('Filter Tests', () => {
        it('parseFilterWithEqualsReturnsFilterNode', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Done')"), 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            const condition = as(filterNode.condition, 'BinaryCondition');
            expect(condition.operator).toBe('Equal');
        });

        it('parseFilterWithGreaterThanReturnsFilterNode', () => {
            const filterNode = as(parseExpression('Orders:where(Total > 100)'), 'Filter');
            const condition = as(filterNode.condition, 'BinaryCondition');
            expect(condition.operator).toBe('GreaterThan');
        });

        it('parseFilterWithLogicalAndReturnsFilterNode', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Done' && Total > 100)"), 'Filter');
            const logicalCondition = as(filterNode.condition, 'LogicalCondition');
            expect(logicalCondition.operator).toBe('And');
        });

        it('parseFilterWithLogicalOrReturnsFilterNode', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Done' || Status = 'Pending')"), 'Filter');
            const logicalCondition = as(filterNode.condition, 'LogicalCondition');
            expect(logicalCondition.operator).toBe('Or');
        });

        it('parseFilterWithAndKeywordReturnsFilterNode', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Done' and Total > 100)"), 'Filter');
            const logicalCondition = as(filterNode.condition, 'LogicalCondition');
            expect(logicalCondition.operator).toBe('And');
        });

        it('parseFilterWithOrKeywordReturnsFilterNode', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Done' or Status = 'Pending')"), 'Filter');
            const logicalCondition = as(filterNode.condition, 'LogicalCondition');
            expect(logicalCondition.operator).toBe('Or');
        });
    });

    describe('Collection Function Tests (orderBy, offset, limit, first, last)', () => {
        function func(expression: string, type: FunctionType): FunctionNode {
            const node = as(parseExpression(expression), 'Function');
            expect(node.functionName).toBe(type);
            return node;
        }

        it('parseOrderByDefaultsToAscending', () => {
            const node = func('Orders:orderBy(OrderDate)', 'OrderBy');

            expect(as(node.source, 'Property').name).toBe('Orders');
            expect(functionArguments(node)).toEqual([Nodes.sortKey('OrderDate', 'Asc')]);
        });

        it.each<[string, OrderDirection]>([
            ['Orders:orderBy(OrderDate asc)', 'Asc'],
            ['Orders:orderBy(OrderDate desc)', 'Desc'],
        ])('parseOrderByWithDirection: %s', (expression, direction) => {
            expect(functionArguments(func(expression, 'OrderBy'))).toEqual([Nodes.sortKey('OrderDate', direction)]);
        });

        it('parseOrderByWithSeveralKeysKeepsTheirOrderAndDirections', () => {
            const node = func('Orders:orderBy(CreatedAt, CreatedBy desc, Id asc)', 'OrderBy');

            expect(functionArguments(node)).toEqual([
                Nodes.sortKey('CreatedAt', 'Asc'),
                Nodes.sortKey('CreatedBy', 'Desc'),
                Nodes.sortKey('Id', 'Asc'),
            ]);
        });

        it('parseOffsetThenLimitChainsOnTheOrderedCollection', () => {
            const limit = func('Orders:orderBy(Total desc):offset(5):limit(10)', 'Take');
            expect(functionArguments(limit)).toHaveLength(1);
            expect(as(functionArguments(limit)[0], 'Literal').value).toBe(10);

            const offset = as(limit.source, 'Function');
            expect(offset.functionName).toBe('Skip');
            expect(functionArguments(offset)).toHaveLength(1);
            expect(as(functionArguments(offset)[0], 'Literal').value).toBe(5);

            const orderBy = as(offset.source, 'Function');
            expect(orderBy.functionName).toBe('OrderBy');
            expect(functionArguments(orderBy)).toEqual([Nodes.sortKey('Total', 'Desc')]);
        });

        it.each<[string, FunctionType]>([
            ['Orders:orderBy(OrderDate):first', 'First'],
            ['Orders:orderBy(OrderDate desc):last', 'Last'],
        ])('parseFirstAndLastTakeNoArguments: %s', (expression, type) => {
            const node = func(expression, type);

            expect(functionArguments(node)).toEqual([]);
            expect(as(node.source, 'Function').functionName).toBe('OrderBy');
        });

        it('parseOrderByThenProjectionProjectsTheOrderedCollection', () => {
            const projNode = as(parseExpression('Orders:orderBy(OrderDate).{Id, Status}'), 'Projection');
            expect(as(projNode.source, 'Function').functionName).toBe('OrderBy');
        });

        it('parseFilterThenOrderByOrdersTheFilteredCollection', () => {
            const node = func("Orders:where(Status = 'Active'):orderBy(CreatedAt desc)", 'OrderBy');

            expect(functionArguments(node)).toEqual([Nodes.sortKey('CreatedAt', 'Desc')]);
            as(node.source, 'Filter');
        });

        it('parseFilterThenFunctionsThenProjectionKeepsTheProjection', () => {
            // The projection after a function that follows a filter used to be dropped
            const projNode = as(
                parseExpression("Orders:where(Status = 'Done'):orderBy(Total desc):first.{Id, Total}"), 'Projection');
            expect(projNode.properties).toHaveLength(2);
            expect(as(projNode.source, 'Function').functionName).toBe('First');
        });

        it.each([
            'Orders[0 asc OrderDate]',
            'Orders[-1 desc OrderDate]',
            'Orders[0 10 asc OrderDate]',
            'Orders[asc OrderDate]',
            "Orders:where(Status = 'Done')[0 asc OrderDate]",
            'Orders[asc OrderDate].{Id}',
            'Orders:orderBy(OrderDate)[0 asc OrderDate]',
        ])('parseTheRemovedIndexerIsRejectedWithTheFunctionsToUseInstead: %s', expression => {
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
            expect(() => parseExpression(expression)).toThrow('no longer supported');
            expect(() => parseExpression(expression)).toThrow(':orderBy(');
        });

        it('parseWhereFiltersTheCollection', () => {
            const filter = as(parseExpression("Orders:where(Status = 'Done' && Total > 100)"), 'Filter');
            expect(as(filter.source, 'Property').name).toBe('Orders');
            as(filter.condition, 'LogicalCondition');
        });

        it('parseWhereChainsWithTheOtherFunctionsInAnyOrder', () => {
            // where after orderBy
            const first = func('Orders:orderBy(Date):where(Total > 100):first', 'First');
            const filter = as(first.source, 'Filter');
            expect(as(filter.source, 'Function').functionName).toBe('OrderBy');

            // where, orderBy, then a projection
            const projection = as(
                parseExpression("Orders:where(Status = 'Done'):orderBy(Total desc):limit(3).{Id}"), 'Projection');
            const limit = as(projection.source, 'Function');
            expect(limit.functionName).toBe('Take');

            // two filters
            const twoFilters = as(parseExpression("Orders:where(Status = 'Done'):where(Total > 100)"), 'Filter');
            as(twoFilters.source, 'Filter');
        });

        it('parseWhereWithAFunctionInTheConditionAndAnAggregateAfterIt', () => {
            const sum = as(parseExpression('Orders:where(Items:count > 5):sum(Total)'), 'Aggregation');
            as(sum.source, 'Filter');
        });

        it.each([
            "Orders(Status = 'Done')",
            "Orders(Status = 'Done'):count",
            "Orders?(Status = 'Done')",
            'Customer.Orders(Total > 1).Items',
            "Orders(Status = 'Done').{Id}",
        ])('parseTheRemovedFilterIsRejectedWithTheFunctionToUseInstead: %s', expression => {
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
            expect(() => parseExpression(expression)).toThrow('no longer supported');
            expect(() => parseExpression(expression)).toThrow(':where(');
        });

        it.each([
            'Orders:where',
            'Orders:where()',
            "Orders:where(Status = 'Done'",
            'Orders:where(Status)',
            'Orders:where(Status = )',
        ])('parseWrongWhereIsRejected: %s', expression => {
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
        });

        it.each([
            'Orders:orderBy()',
            'Orders:orderBy(Date,)',
            'Orders:orderBy(Date up)',
            'Orders:orderBy(Date desc desc)',
            'Orders:first(Id)',
            'Orders:offset',
            'Orders:limit',
        ])('parseWrongArgumentsOfTheCollectionFunctionsAreRejected: %s', expression => {
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
        });
    });

    describe('Function Tests', () => {
        it('parseCountFunctionReturnsFunctionNode', () => {
            const funcNode = as(parseExpression('Orders:count'), 'Function');
            expect(funcNode.functionName).toBe('Count');
            as(funcNode.source, 'Property');
        });

        it('parseSumFunctionReturnsAggregationNode', () => {
            // sum with argument returns AggregationNode
            const aggNode = as(parseExpression('Orders:sum(Total)'), 'Aggregation');
            expect(aggNode.aggregationType).toBe('Sum');
            expect(aggNode.propertyName).toBe('Total');
        });

        it('parseAvgFunctionReturnsAggregationNode', () => {
            const aggNode = as(parseExpression('Orders:avg(Total)'), 'Aggregation');
            expect(aggNode.aggregationType).toBe('Average');
            expect(aggNode.propertyName).toBe('Total');
        });

        it('parseMinFunctionReturnsAggregationNode', () => {
            const aggNode = as(parseExpression('Orders:min(Total)'), 'Aggregation');
            expect(aggNode.aggregationType).toBe('Min');
            expect(aggNode.propertyName).toBe('Total');
        });

        it('parseMaxFunctionReturnsAggregationNode', () => {
            const aggNode = as(parseExpression('Orders:max(Total)'), 'Aggregation');
            expect(aggNode.aggregationType).toBe('Max');
            expect(aggNode.propertyName).toBe('Total');
        });

        it('parseStringCountFunctionReturnsFunctionNode', () => {
            const funcNode = as(parseExpression('Name:count'), 'Function');
            expect(funcNode.functionName).toBe('Count');
            expect(as(funcNode.source, 'Property').name).toBe('Name');
        });
    });

    describe('Projection Tests', () => {
        function firstWithPath(node: RootProjectionNode, path: string): ProjectionProperty {
            const found = node.properties.find(p => p.path === path);
            if (found === undefined) throw new Error(`No projection property with path ${path}`);
            return found;
        }

        it('parseProjectionReturnsProjectionNode', () => {
            const projNode = as(parseExpression('Orders.{Id, Status}'), 'Projection');
            expect(projNode.properties).toHaveLength(2);
            expect(projNode.properties[0].path).toBe('Id');
            expect(projNode.properties[1].path).toBe('Status');
        });

        it('parseProjectionMultipleFieldsReturnsProjectionNode', () => {
            const projNode = as(parseExpression('Orders.{Id, Status, Total, OrderDate}'), 'Projection');
            expect(projNode.properties).toHaveLength(4);
        });

        it('parseRootProjectionReturnsRootProjectionNode', () => {
            const rootProjNode = as(parseExpression('{Id, Name}'), 'RootProjection');
            expect(rootProjNode.properties).toHaveLength(2);
            expect(rootProjNode.properties.some(p => p.path === 'Id')).toBe(true);
            expect(rootProjNode.properties.some(p => p.path === 'Name')).toBe(true);
        });

        it('parseRootProjectionMultipleFieldsReturnsRootProjectionNode', () => {
            const rootProjNode = as(parseExpression('{Id, UserEmail, ProvinceId, Age}'), 'RootProjection');
            expect(rootProjNode.properties).toHaveLength(4);
            for (const path of ['Id', 'UserEmail', 'ProvinceId', 'Age'])
                expect(rootProjNode.properties.some(p => p.path === path)).toBe(true);
        });

        it('parseRootProjectionSingleFieldReturnsRootProjectionNode', () => {
            const rootProjNode = as(parseExpression('{Name}'), 'RootProjection');
            expect(rootProjNode.properties).toHaveLength(1);
            expect(rootProjNode.properties.some(p => p.path === 'Name')).toBe(true);
        });

        it('parseRootProjectionWithNavigationReturnsProjectionPropertyWithPath', () => {
            const rootProjNode = as(parseExpression('{Id, Country.Name}'), 'RootProjection');
            expect(rootProjNode.properties).toHaveLength(2);

            const idProp = firstWithPath(rootProjNode, 'Id');
            expect(outputKey(idProp)).toBe('Id');
            expect(hasNavigation(idProp)).toBe(false);

            const countryNameProp = firstWithPath(rootProjNode, 'Country.Name');
            expect(outputKey(countryNameProp)).toBe('Name'); // Last segment without alias
            expect(hasNavigation(countryNameProp)).toBe(true);
            expect(pathSegments(countryNameProp)).toEqual(['Country', 'Name']);
        });

        it('parseRootProjectionWithAliasReturnsProjectionPropertyWithAlias', () => {
            const rootProjNode = as(parseExpression('{Id, Country.Name as CountryName}'), 'RootProjection');
            expect(rootProjNode.properties).toHaveLength(2);

            const countryNameProp = firstWithPath(rootProjNode, 'Country.Name');
            expect(countryNameProp.alias).toBe('CountryName');
            expect(outputKey(countryNameProp)).toBe('CountryName'); // Uses alias as output key
        });

        it('parseRootProjectionWithMultipleAliasesReturnsCorrectProperties', () => {
            const rootProjNode = as(
                parseExpression('{Id, Name, Country.Name as CountryName, Province.City.Name as CityName}'),
                'RootProjection');
            const properties = rootProjNode.properties;
            expect(properties).toHaveLength(4);

            expect(properties[0].path).toBe('Id');
            expect(properties[0].alias).toBeNull();
            expect(outputKey(properties[0])).toBe('Id');

            expect(properties[1].path).toBe('Name');
            expect(properties[1].alias).toBeNull();
            expect(outputKey(properties[1])).toBe('Name');

            expect(properties[2].path).toBe('Country.Name');
            expect(properties[2].alias).toBe('CountryName');
            expect(outputKey(properties[2])).toBe('CountryName');

            expect(properties[3].path).toBe('Province.City.Name');
            expect(properties[3].alias).toBe('CityName');
            expect(outputKey(properties[3])).toBe('CityName');
            expect(pathSegments(properties[3])).toEqual(['Province', 'City', 'Name']);
        });
    });

    describe('Complex Expression Tests', () => {
        it('parseFilterThenFirstReturnsCorrectStructure', () => {
            const first = as(parseExpression("Orders:where(Status = 'Done'):orderBy(OrderDate):first"), 'Function');
            expect(first.functionName).toBe('First');
            const orderBy = as(first.source, 'Function');
            expect(orderBy.functionName).toBe('OrderBy');
            as(orderBy.source, 'Filter');
        });

        it('parseFilterThenProjectionReturnsCorrectStructure', () => {
            const projNode = as(parseExpression("Orders:where(Status = 'Done').{Id, Total}"), 'Projection');
            as(projNode.source, 'Filter');
        });

        it('parseFilterThenCountReturnsCorrectStructure', () => {
            const funcNode = as(parseExpression("Orders:where(Status = 'Done'):count"), 'Function');
            expect(funcNode.functionName).toBe('Count');
            as(funcNode.source, 'Filter');
        });

        it('parseComplexExpressionReturnsCorrectStructure', () => {
            // ProjectionNode(source: limit(orderBy(filter(Provinces))))
            const projNode = as(
                parseExpression('Provinces:where(Name:count > 3):orderBy(Name):limit(10).{Id, Name}'), 'Projection');

            const limitNode = as(projNode.source, 'Function');
            expect(limitNode.functionName).toBe('Take');
            const orderByNode = as(limitNode.source, 'Function');
            expect(orderByNode.functionName).toBe('OrderBy');

            const filterNode = as(orderByNode.source, 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Provinces');
        });

        it('parseNavigationWithFilterIndexerProjectionReturnsCorrectStructure', () => {
            const projNode = as(parseExpression('Country.Provinces.{Id, Name}'), 'Projection');
            const navNode = as(projNode.source, 'Navigation');
            expect(navNode.segments).toHaveLength(2);
        });
    });

    describe('Literal Tests', () => {
        it('parseStringLiteralReturnsCorrectValue', () => {
            const filterNode = as(parseExpression("Orders:where(Status = 'Completed')"), 'Filter');
            const condition = as(filterNode.condition, 'BinaryCondition');
            const literal = as(condition.right, 'Literal');
            expect(literal.literalType).toBe('String');
            expect(literal.value).toBe('Completed');
        });

        it('parseNumberLiteralReturnsCorrectValue', () => {
            const filterNode = as(parseExpression('Orders:where(Total > 100)'), 'Filter');
            const condition = as(filterNode.condition, 'BinaryCondition');
            const literal = as(condition.right, 'Literal');
            expect(literal.literalType).toBe('Number');
        });

        it('parseBooleanLiteralReturnsCorrectValue', () => {
            const filterNode = as(parseExpression('Users:where(IsActive = true)'), 'Filter');
            const condition = as(filterNode.condition, 'BinaryCondition');
            const literal = as(condition.right, 'Literal');
            expect(literal.literalType).toBe('Boolean');
            expect(literal.value).toBe(true);
        });
    });

    describe('Comparison Operator Tests', () => {
        it.each<[string, ComparisonOperator]>([
            ['Orders:where(Total = 100)', 'Equal'],
            ['Orders:where(Total != 100)', 'NotEqual'],
            ['Orders:where(Total > 100)', 'GreaterThan'],
            ['Orders:where(Total < 100)', 'LessThan'],
            ['Orders:where(Total >= 100)', 'GreaterThanOrEqual'],
            ['Orders:where(Total <= 100)', 'LessThanOrEqual'],
        ])('parseComparisonOperatorsReturnsCorrectOperator: %s', (expression, expected) => {
            const filterNode = as(parseExpression(expression), 'Filter');
            expect(as(filterNode.condition, 'BinaryCondition').operator).toBe(expected);
        });

        it.each<[string, ComparisonOperator]>([
            ["Orders:where(Name contains 'test')", 'Contains'],
            ["Orders:where(Name startswith 'test')", 'StartsWith'],
            ["Orders:where(Name endswith 'test')", 'EndsWith'],
        ])('parseStringComparisonOperatorsReturnsCorrectOperator: %s', (expression, expected) => {
            const filterNode = as(parseExpression(expression), 'Filter');
            expect(as(filterNode.condition, 'BinaryCondition').operator).toBe(expected);
        });
    });

    describe('Boolean Function Tests (:any, :all)', () => {
        it('parseAnyWithoutConditionReturnsBooleanFunctionNode', () => {
            const boolFunc = as(parseExpression('Orders:any'), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('Any');
            expect(boolFunc.condition).toBeNull();
            expect(as(boolFunc.source, 'Property').name).toBe('Orders');
        });

        it('parseAnyWithConditionReturnsBooleanFunctionNodeWithCondition', () => {
            const boolFunc = as(parseExpression("Orders:any(Status = 'Pending')"), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('Any');
            expect(boolFunc.condition).not.toBeNull();

            const condition = as(boolFunc.condition, 'BinaryCondition');
            expect(as(condition.left, 'Property').name).toBe('Status');
            expect(condition.operator).toBe('Equal');
            expect(as(condition.right, 'Literal').value).toBe('Pending');
        });

        it('parseAllWithoutConditionReturnsBooleanFunctionNode', () => {
            const boolFunc = as(parseExpression('Documents:all'), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('All');
            expect(boolFunc.condition).toBeNull();
        });

        it('parseAllWithConditionReturnsBooleanFunctionNodeWithCondition', () => {
            const boolFunc = as(parseExpression('Documents:all(IsApproved = true)'), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('All');

            const condition = as(boolFunc.condition, 'BinaryCondition');
            expect(as(condition.left, 'Property').name).toBe('IsApproved');
            expect(condition.operator).toBe('Equal');
            expect(as(condition.right, 'Literal').value).toBe(true);
        });

        it('parseAnyWithComplexConditionReturnsBooleanFunctionNodeWithLogicalCondition', () => {
            const boolFunc = as(parseExpression("Orders:any(Status = 'Done' || Status = 'Shipped')"), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('Any');
            expect(as(boolFunc.condition, 'LogicalCondition').operator).toBe('Or');
        });

        it('parseAllWithAndConditionReturnsBooleanFunctionNodeWithLogicalCondition', () => {
            const boolFunc = as(parseExpression('Items:all(Price > 0 && Quantity > 0)'), 'BooleanFunction');
            expect(boolFunc.functionName).toBe('All');
            expect(as(boolFunc.condition, 'LogicalCondition').operator).toBe('And');
        });

        it('parseNavigationThenAnyReturnsCorrectStructure', () => {
            // NavigationNode containing [User, BooleanFunctionNode(Orders)]
            const navNode = as(parseExpression("User.Orders:any(Status = 'Done')"), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            expect(as(navNode.segments[0], 'Property').name).toBe('User');

            const boolFunc = as(navNode.segments[1], 'BooleanFunction');
            expect(boolFunc.functionName).toBe('Any');
            expect(as(boolFunc.source, 'Property').name).toBe('Orders');
        });

        it('parseFilterThenAnyReturnsCorrectStructure', () => {
            const boolFunc = as(parseExpression("Orders:where(Year = 2024):any(Status = 'Done')"), 'BooleanFunction');
            as(boolFunc.source, 'Filter');
        });
    });

    describe('Coalesce Tests (??)', () => {
        it('parseSimpleCoalesceReturnsCoalesceNode', () => {
            const coalesce = as(parseExpression('Nickname ?? Name'), 'Coalesce');
            expect(as(coalesce.left, 'Property').name).toBe('Nickname');
            expect(as(coalesce.right, 'Property').name).toBe('Name');
        });

        it('parseCoalesceWithLiteralReturnsCoalesceNode', () => {
            const coalesce = as(parseExpression("City ?? 'Unknown'"), 'Coalesce');
            expect(as(coalesce.left, 'Property').name).toBe('City');
            expect(as(coalesce.right, 'Literal').value).toBe('Unknown');
        });

        it('parseChainedCoalesceReturnsRightToLeftAssociativity', () => {
            // A ?? B ?? C should be A ?? (B ?? C)
            const coalesce = as(parseExpression('PreferredName ?? Nickname ?? Name'), 'Coalesce');
            expect(as(coalesce.left, 'Property').name).toBe('PreferredName');

            const innerCoalesce = as(coalesce.right, 'Coalesce');
            expect(as(innerCoalesce.left, 'Property').name).toBe('Nickname');
            expect(as(innerCoalesce.right, 'Property').name).toBe('Name');
        });

        it('parseCoalesceWithNumberReturnsCoalesceNode', () => {
            const coalesce = as(parseExpression('Score ?? 0'), 'Coalesce');
            as(coalesce.left, 'Property');
            expect(as(coalesce.right, 'Literal').value).toBe(0);
        });

        it('parseCoalesceWithBooleanReturnsCoalesceNode', () => {
            const coalesce = as(parseExpression('IsActive ?? false'), 'Coalesce');
            as(coalesce.left, 'Property');
            expect(as(coalesce.right, 'Literal').value).toBe(false);
        });
    });

    describe('Ternary Tests (?:)', () => {
        it('parseSimpleTernaryReturnsTernaryNode', () => {
            const ternary = as(parseExpression("Status = 'Active' ? 'Yes' : 'No'"), 'Ternary');

            const condition = as(ternary.condition, 'BinaryCondition');
            expect(as(condition.left, 'Property').name).toBe('Status');
            expect(condition.operator).toBe('Equal');

            expect(as(ternary.whenTrue, 'Literal').value).toBe('Yes');
            expect(as(ternary.whenFalse, 'Literal').value).toBe('No');
        });

        it('parseTernaryWithGreaterThanReturnsTernaryNode', () => {
            const ternary = as(parseExpression("Count > 0 ? 'HasItems' : 'Empty'"), 'Ternary');
            expect(as(ternary.condition, 'BinaryCondition').operator).toBe('GreaterThan');
        });

        it('parseTernaryWithExpressionResultsReturnsTernaryNode', () => {
            const ternary = as(parseExpression('IsVIP = true ? Discount1 : Discount2'), 'Ternary');
            expect(as(ternary.whenTrue, 'Property').name).toBe('Discount1');
            expect(as(ternary.whenFalse, 'Property').name).toBe('Discount2');
        });

        it('parseNestedTernaryReturnsRightToLeftAssociativity', () => {
            // A = 1 ? 'One' : (B = 2 ? 'Two' : 'Other')
            const ternary = as(parseExpression("Score >= 90 ? 'A' : Score >= 80 ? 'B' : 'C'"), 'Ternary');
            expect(as(ternary.whenTrue, 'Literal').value).toBe('A');

            const innerTernary = as(ternary.whenFalse, 'Ternary');
            expect(as(innerTernary.whenTrue, 'Literal').value).toBe('B');
            expect(as(innerTernary.whenFalse, 'Literal').value).toBe('C');
        });

        it('parseTernaryWithBooleanFunctionReturnsTernaryNode', () => {
            const ternary = as(parseExpression("Orders:any ? 'Has Orders' : 'No Orders'"), 'Ternary');
            // Condition should wrap BooleanFunctionNode as comparison
            const condition = as(ternary.condition, 'BinaryCondition');
            as(condition.left, 'BooleanFunction');
        });
    });
});
