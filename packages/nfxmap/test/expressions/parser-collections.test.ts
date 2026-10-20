import { describe, expect, it } from 'vitest';
import { type ExpressionNode, type ProjectionProperty, functionArguments, Nodes, outputKey } from '../../src/expressions/nodes.js';
import { ExpressionParseError, parseExpression } from '../../src/expressions/parser.js';

type Kind = ExpressionNode['kind'];
type NodeOf<K extends Kind> = Extract<ExpressionNode, { kind: K }>;

/** Asserts the kind of a node and narrows it (the `isInstanceOf` + cast of the Java tests). */
function as<K extends Kind>(node: ExpressionNode | null | undefined, kind: K): NodeOf<K> {
    expect(node?.kind).toBe(kind);
    return node as NodeOf<K>;
}

const isComputed = (p: ProjectionProperty) => p.expression !== null;

describe('ExpressionParserCollectionsTest', () => {
    describe('Collection Functions - Distinct', () => {
        it('parseDistinctWithPropertyReturnsFunctionNode', () => {
            const funcNode = as(parseExpression('Items:distinct(Name)'), 'Function');
            expect(funcNode.functionName).toBe('Distinct');
            expect(as(funcNode.source, 'Property').name).toBe('Items');

            const args = functionArguments(funcNode);
            expect(args).toHaveLength(1);
            expect(as(args[0], 'Property').name).toBe('Name');
        });

        it('parseDistinctWithNavigationSourceReturnsCorrectStructure', () => {
            // NavigationNode([Order, FunctionNode(Items:distinct(ProductName))])
            const navNode = as(parseExpression('Order.Items:distinct(ProductName)'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            expect(as(navNode.segments[0], 'Property').name).toBe('Order');

            const funcNode = as(navNode.segments[1], 'Function');
            expect(funcNode.functionName).toBe('Distinct');
            expect(as(funcNode.source, 'Property').name).toBe('Items');

            const args = functionArguments(funcNode);
            expect(args).toHaveLength(1);
            expect(as(args[0], 'Property').name).toBe('ProductName');
        });

        it('parseDistinctAfterFilterReturnsCorrectStructure', () => {
            // NavigationNode([FilterNode(Orders), FunctionNode(Items:distinct)])
            const navNode = as(parseExpression("Orders:where(Status = 'Done').Items:distinct(CustomerId)"), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            const filterNode = as(navNode.segments[0], 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            const funcNode = as(navNode.segments[1], 'Function');
            expect(funcNode.functionName).toBe('Distinct');
            expect(as(functionArguments(funcNode)[0], 'Property').name).toBe('CustomerId');
        });

        it('parseDistinctWithCountChainReturnsCorrectStructure', () => {
            const countFunc = as(parseExpression('Items:distinct(Category):count'), 'Function');
            expect(countFunc.functionName).toBe('Count');

            const distinctFunc = as(countFunc.source, 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
            expect(as(functionArguments(distinctFunc)[0], 'Property').name).toBe('Category');
        });

        it('parseDistinctInProjectionReturnsCorrectStructure', () => {
            const projection = as(parseExpression('{Id, Name, Items:distinct(Category) as Categories}'), 'RootProjection');
            expect(projection.properties).toHaveLength(3);

            const distinctProp = projection.properties[2];
            expect(outputKey(distinctProp)).toBe('Categories');
            expect(isComputed(distinctProp)).toBe(true);
            expect(as(distinctProp.expression, 'Function').functionName).toBe('Distinct');
        });

        it('parseDistinctWithFilterAndCountComplexChain', () => {
            // NavigationNode([FilterNode(Orders), FunctionNode(Items:distinct(ProductId):count)])
            const navNode = as(
                parseExpression("Orders:where(Status = 'Completed').Items:distinct(ProductId):count"), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            const filterNode = as(navNode.segments[0], 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            const countFunc = as(navNode.segments[1], 'Function');
            expect(countFunc.functionName).toBe('Count');

            const distinctFunc = as(countFunc.source, 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
            expect(as(distinctFunc.source, 'Property').name).toBe('Items');
        });

        it('parseDistinctWithoutArgumentThrowsException', () => {
            // the property argument is required
            expect(() => parseExpression('Items:distinct')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Items:distinct')).toThrow('distinct');
            expect(() => parseExpression('Items:distinct')).toThrow('requires');
        });

        it('parseDistinctWithEmptyParensThrowsException', () => {
            expect(() => parseExpression('Items:distinct()')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Items:distinct()')).toThrow('argument');
        });

        it('parseMultipleDistinctsInProjectionReturnsCorrectStructure', () => {
            const projection = as(
                parseExpression('{Items:distinct(Category) as Categories, Items:distinct(Vendor) as Vendors}'),
                'RootProjection');
            expect(projection.properties).toHaveLength(2);

            const catProp = projection.properties[0];
            expect(outputKey(catProp)).toBe('Categories');
            const catFunc = as(catProp.expression, 'Function');
            expect(catFunc.functionName).toBe('Distinct');
            expect(as(functionArguments(catFunc)[0], 'Property').name).toBe('Category');

            const vendorProp = projection.properties[1];
            expect(outputKey(vendorProp)).toBe('Vendors');
            const vendorFunc = as(vendorProp.expression, 'Function');
            expect(vendorFunc.functionName).toBe('Distinct');
            expect(as(functionArguments(vendorFunc)[0], 'Property').name).toBe('Vendor');
        });

        it('parseDistinctWithDeepNavigationReturnsCorrectStructure', () => {
            // NavigationNode([Customer, Orders, FunctionNode(Items:distinct(ProductName))])
            const navNode = as(parseExpression('Customer.Orders.Items:distinct(ProductName)'), 'Navigation');
            expect(navNode.segments).toHaveLength(3);

            expect(as(navNode.segments[0], 'Property').name).toBe('Customer');
            expect(as(navNode.segments[1], 'Property').name).toBe('Orders');

            const funcNode = as(navNode.segments[2], 'Function');
            expect(funcNode.functionName).toBe('Distinct');
            expect(as(funcNode.source, 'Property').name).toBe('Items');
        });

        it('parseDistinctWithFilterOnNestedCollectionComplexQuery', () => {
            // NavigationNode([Company, FilterNode(Departments), Employees, FunctionNode(Items:distinct(Role))])
            const navNode = as(
                parseExpression('Company.Departments:where(IsActive = true).Employees.Items:distinct(Role)'),
                'Navigation');
            expect(navNode.segments).toHaveLength(4);

            expect(as(navNode.segments[0], 'Property').name).toBe('Company');

            const filterNode = as(navNode.segments[1], 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Departments');

            expect(as(navNode.segments[2], 'Property').name).toBe('Employees');

            const distinctFunc = as(navNode.segments[3], 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
            expect(as(distinctFunc.source, 'Property').name).toBe('Items');
            expect(as(functionArguments(distinctFunc)[0], 'Property').name).toBe('Role');
        });

        it('parseDistinctAfterOrderByAndLimitComplexChain', () => {
            // NavigationNode([limit(orderBy(Customers)), Orders, FunctionNode(Items:distinct(Status))])
            const navNode = as(
                parseExpression('Customers:orderBy(CreatedAt):limit(10).Orders.Items:distinct(Status)'), 'Navigation');
            expect(navNode.segments).toHaveLength(3);

            const limitNode = as(navNode.segments[0], 'Function');
            expect(limitNode.functionName).toBe('Take');
            const orderByNode = as(limitNode.source, 'Function');
            expect(orderByNode.functionName).toBe('OrderBy');
            expect(as(orderByNode.source, 'Property').name).toBe('Customers');
            expect(functionArguments(orderByNode)).toEqual([Nodes.sortKey('CreatedAt', 'Asc')]);

            expect(as(navNode.segments[1], 'Property').name).toBe('Orders');

            const distinctFunc = as(navNode.segments[2], 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
            expect(as(distinctFunc.source, 'Property').name).toBe('Items');
            expect(as(functionArguments(distinctFunc)[0], 'Property').name).toBe('Status');
        });

        it('parseDistinctCombinedWithTernaryInProjection', () => {
            const projection = as(parseExpression(
                "{(Items:distinct(Category):count > 0 ? 'Has Categories' : 'No Categories') as CategoryStatus}"),
            'RootProjection');
            expect(projection.properties).toHaveLength(1);

            const prop = projection.properties[0];
            expect(outputKey(prop)).toBe('CategoryStatus');
            const ternary = as(prop.expression, 'Ternary');

            const condition = as(ternary.condition, 'BinaryCondition');
            // The left side should be Items:distinct(Category):count
            const countFunc = as(condition.left, 'Function');
            expect(countFunc.functionName).toBe('Count');

            const distinctFunc = as(countFunc.source, 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
        });

        it('parseDistinctWithCoalesceInProjectionComplexExpression', () => {
            const projection = as(
                parseExpression('{(Items:distinct(Category) ?? Items:distinct(SubCategory)) as Categories}'),
                'RootProjection');
            expect(projection.properties).toHaveLength(1);

            const prop = projection.properties[0];
            expect(outputKey(prop)).toBe('Categories');
            const coalesce = as(prop.expression, 'Coalesce');

            const leftDistinct = as(coalesce.left, 'Function');
            expect(leftDistinct.functionName).toBe('Distinct');
            expect(as(functionArguments(leftDistinct)[0], 'Property').name).toBe('Category');

            const rightDistinct = as(coalesce.right, 'Function');
            expect(rightDistinct.functionName).toBe('Distinct');
            expect(as(functionArguments(rightDistinct)[0], 'Property').name).toBe('SubCategory');
        });

        it('parseDistinctWithAndFilterComplexQuery', () => {
            const navNode = as(
                parseExpression("Orders:where(Year = 2024, Status = 'Active').Items:distinct(CustomerId)"), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            const filterNode = as(navNode.segments[0], 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            // Condition should be LogicalConditionNode (AND)
            expect(as(filterNode.condition, 'LogicalCondition').operator).toBe('And');

            const distinctFunc = as(navNode.segments[1], 'Function');
            expect(distinctFunc.functionName).toBe('Distinct');
            expect(as(functionArguments(distinctFunc)[0], 'Property').name).toBe('CustomerId');
        });

        it('parseDistinctCaseInsensitiveWorks', () => {
            for (const expression of ['Items:distinct(Name)', 'Items:DISTINCT(Name)', 'Items:Distinct(Name)'])
                expect(as(parseExpression(expression), 'Function').functionName).toBe('Distinct');
        });
    });

    describe('GroupBy Tests - Basic Parsing', () => {
        it('parseGroupBySingleKeyReturnsGroupByNode', () => {
            const groupByNode = as(parseExpression('Orders:groupBy(Status)'), 'GroupBy');
            expect(as(groupByNode.source, 'Property').name).toBe('Orders');
            expect(groupByNode.keyProperties).toEqual(['Status']);
            // isSingleKey / isMultiKey
            expect(groupByNode.keyProperties.length === 1).toBe(true);
            expect(groupByNode.keyProperties.length > 1).toBe(false);
        });

        it('parseGroupByMultipleKeysReturnsGroupByNode', () => {
            const groupByNode = as(parseExpression('Orders:groupBy(Year, Month)'), 'GroupBy');
            expect(as(groupByNode.source, 'Property').name).toBe('Orders');
            expect(groupByNode.keyProperties).toEqual(['Year', 'Month']);
            expect(groupByNode.keyProperties.length === 1).toBe(false);
            expect(groupByNode.keyProperties.length > 1).toBe(true);
        });

        it('parseGroupByThreeKeysReturnsGroupByNode', () => {
            const groupByNode = as(parseExpression('Sales:groupBy(Year, Quarter, Region)'), 'GroupBy');
            expect(groupByNode.keyProperties).toEqual(['Year', 'Quarter', 'Region']);
            expect(groupByNode.keyProperties.length > 1).toBe(true);
        });

        it('parseGroupByAfterFilterReturnsCorrectStructure', () => {
            const groupByNode = as(parseExpression("Orders:where(Status = 'Active'):groupBy(CustomerId)"), 'GroupBy');

            const filterNode = as(groupByNode.source, 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            expect(groupByNode.keyProperties).toEqual(['CustomerId']);
        });

        it('parseGroupByWithNavigationReturnsCorrectStructure', () => {
            const navNode = as(parseExpression('Customer.Orders:groupBy(Status)'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            expect(as(navNode.segments[0], 'Property').name).toBe('Customer');

            const groupByNode = as(navNode.segments[1], 'GroupBy');
            expect(as(groupByNode.source, 'Property').name).toBe('Orders');
            expect(groupByNode.keyProperties[0]).toBe('Status');
        });

        it('parseGroupByCaseInsensitiveWorks', () => {
            for (const expression of ['Items:groupby(Category)', 'Items:GROUPBY(Category)', 'Items:GroupBy(Category)'])
                expect(as(parseExpression(expression), 'GroupBy').keyProperties[0]).toBe('Category');
        });
    });

    describe('GroupBy Tests - With Projection', () => {
        it('parseGroupByWithSimpleProjectionReturnsProjectionNode', () => {
            const projNode = as(parseExpression('Orders:groupBy(Status).{Status, :count}'), 'Projection');

            const groupByNode = as(projNode.source, 'GroupBy');
            expect(groupByNode.keyProperties[0]).toBe('Status');

            expect(projNode.properties).toHaveLength(2);

            expect(projNode.properties[0].path).toBe('Status');

            // :count (direct aggregation on group elements)
            expect(isComputed(projNode.properties[1])).toBe(true);
            const countFunc = as(projNode.properties[1].expression, 'Function');
            expect(countFunc.functionName).toBe('Count');
            as(countFunc.source, 'GroupElements');
        });

        it('parseGroupByWithAliasedProjectionReturnsCorrectAliases', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(Status).{Status as OrderStatus, :count as TotalCount}'), 'Projection');

            expect(projNode.properties).toHaveLength(2);
            expect(outputKey(projNode.properties[0])).toBe('OrderStatus');
            expect(outputKey(projNode.properties[1])).toBe('TotalCount');
        });

        it('parseGroupByMultiKeyWithProjectionReturnsCorrectStructure', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(Year, Month).{Year, Month, :count as OrderCount}'), 'Projection');

            const groupByNode = as(projNode.source, 'GroupBy');
            expect(groupByNode.keyProperties).toEqual(['Year', 'Month']);

            expect(projNode.properties).toHaveLength(3);
            expect(projNode.properties[0].path).toBe('Year');
            expect(projNode.properties[1].path).toBe('Month');
            expect(outputKey(projNode.properties[2])).toBe('OrderCount');
        });

        it('parseGroupByWithSumFunctionReturnsCorrectStructure', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(CustomerId).{CustomerId, :sum(Total) as TotalAmount}'), 'Projection');

            expect(projNode.properties).toHaveLength(2);

            const totalProp = projNode.properties[1];
            expect(outputKey(totalProp)).toBe('TotalAmount');
            const sumAgg = as(totalProp.expression, 'Aggregation');
            expect(sumAgg.aggregationType).toBe('Sum');
            expect(sumAgg.propertyName).toBe('Total');
        });

        it('parseGroupByWithAvgFunctionReturnsCorrectStructure', () => {
            const projNode = as(
                parseExpression('Products:groupBy(Category).{Category, :avg(Price) as AvgPrice}'), 'Projection');

            const avgProp = projNode.properties[1];
            expect(outputKey(avgProp)).toBe('AvgPrice');
            const avgAgg = as(avgProp.expression, 'Aggregation');
            expect(avgAgg.aggregationType).toBe('Average');
            expect(avgAgg.propertyName).toBe('Price');
        });

        it('parseGroupByWithMinMaxFunctionsReturnsCorrectStructure', () => {
            const projNode = as(parseExpression(
                'Orders:groupBy(Status).{Status, :min(CreatedAt) as FirstOrder, :max(CreatedAt) as LastOrder}'),
            'Projection');

            expect(projNode.properties).toHaveLength(3);

            const minProp = projNode.properties[1];
            expect(outputKey(minProp)).toBe('FirstOrder');
            expect(as(minProp.expression, 'Aggregation').aggregationType).toBe('Min');

            const maxProp = projNode.properties[2];
            expect(outputKey(maxProp)).toBe('LastOrder');
            expect(as(maxProp.expression, 'Aggregation').aggregationType).toBe('Max');
        });

        it('parseGroupByWithMultipleAggregationsReturnsCorrectStructure', () => {
            const projNode = as(parseExpression(
                'Orders:groupBy(CustomerId).{CustomerId, :count as OrderCount, :sum(Total) as TotalSpent, :avg(Total) as AvgOrderValue}'),
            'Projection');

            expect(projNode.properties).toHaveLength(4);

            expect(projNode.properties[0].path).toBe('CustomerId');

            // count returns FunctionNode
            expect(outputKey(projNode.properties[1])).toBe('OrderCount');
            expect(as(projNode.properties[1].expression, 'Function').functionName).toBe('Count');

            // sum returns AggregationNode
            expect(outputKey(projNode.properties[2])).toBe('TotalSpent');
            expect(as(projNode.properties[2].expression, 'Aggregation').aggregationType).toBe('Sum');

            // avg returns AggregationNode
            expect(outputKey(projNode.properties[3])).toBe('AvgOrderValue');
            expect(as(projNode.properties[3].expression, 'Aggregation').aggregationType).toBe('Average');
        });
    });

    describe('GroupBy Tests - Error Cases', () => {
        it('parseGroupByWithoutArgumentsThrowsException', () => {
            expect(() => parseExpression('Orders:groupBy')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Orders:groupBy')).toThrow('groupBy');
            expect(() => parseExpression('Orders:groupBy')).toThrow('requires');
        });

        it('parseGroupByWithEmptyParensThrowsException', () => {
            expect(() => parseExpression('Orders:groupBy()')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Orders:groupBy()')).toThrow('property');
        });

        it('parseGroupByWithInvalidProjectionThrowsException', () => {
            expect(() => parseExpression('Orders:groupBy(Status).InvalidToken')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Orders:groupBy(Status).InvalidToken')).toThrow('{');
        });

        it('parseGroupByWithTrailingCommaThrowsException', () => {
            expect(() => parseExpression('Orders:groupBy(Status,)')).toThrow(ExpressionParseError);
            expect(() => parseExpression('Orders:groupBy(Status,)')).toThrow('property');
        });
    });

    describe('GroupBy Tests - Complex Scenarios', () => {
        it('parseGroupByAfterFilterWithProjectionComplexChain', () => {
            const projNode = as(parseExpression(
                'Orders:where(Year = 2024):groupBy(Status).{Status, :count as Count, :sum(Total) as Revenue}'),
            'Projection');

            const groupByNode = as(projNode.source, 'GroupBy');
            expect(groupByNode.keyProperties[0]).toBe('Status');

            const filterNode = as(groupByNode.source, 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');

            expect(projNode.properties).toHaveLength(3);
        });

        it('parseGroupByWithDeepNavigationReturnsCorrectStructure', () => {
            const navNode = as(
                parseExpression('Company.Departments.Employees:groupBy(Role).{Role, :count as HeadCount}'), 'Navigation');
            expect(navNode.segments).toHaveLength(3);

            expect(as(navNode.segments[0], 'Property').name).toBe('Company');
            expect(as(navNode.segments[1], 'Property').name).toBe('Departments');

            // ProjectionNode (wrapping GroupByNode)
            const projNode = as(navNode.segments[2], 'Projection');
            as(projNode.source, 'GroupBy');
        });

        it('parseGroupByAfterOrderByAndLimitComplexChain', () => {
            const navNode = as(parseExpression(
                'Customers:orderBy(CreatedAt desc):limit(10).Orders:groupBy(Status).{Status, :count}'), 'Navigation');
            expect(navNode.segments).toHaveLength(2);

            const limitNode = as(navNode.segments[0], 'Function');
            expect(limitNode.functionName).toBe('Take');
            const orderByNode = as(limitNode.source, 'Function');
            expect(as(orderByNode.source, 'Property').name).toBe('Customers');
            expect(functionArguments(orderByNode)).toEqual([Nodes.sortKey('CreatedAt', 'Desc')]);

            as(navNode.segments[1], 'Projection');
        });

        it('parseGroupByWithComputedExpressionInProjection', () => {
            // Use multiply function instead of * operator (which isn't supported in tokenizer)
            const projNode = as(
                parseExpression('Orders:groupBy(Status).{Status, (:count:multiply(10)) as WeightedCount}'), 'Projection');

            expect(projNode.properties).toHaveLength(2);

            const weightedProp = projNode.properties[1];
            expect(outputKey(weightedProp)).toBe('WeightedCount');
            expect(isComputed(weightedProp)).toBe(true);
        });

        it('parseGroupByWithAnyFunctionReturnsCorrectStructure', () => {
            const projNode = as(
                parseExpression("Orders:groupBy(CustomerId).{CustomerId, :any(Status = 'Urgent') as HasUrgent}"),
                'Projection');

            const hasUrgentProp = projNode.properties[1];
            expect(outputKey(hasUrgentProp)).toBe('HasUrgent');
            expect(as(hasUrgentProp.expression, 'BooleanFunction').functionName).toBe('Any');
        });

        it('parseGroupByWithAllFunctionReturnsCorrectStructure', () => {
            const projNode = as(
                parseExpression('Tasks:groupBy(ProjectId).{ProjectId, :all(IsCompleted = true) as AllCompleted}'),
                'Projection');

            const allCompletedProp = projNode.properties[1];
            expect(outputKey(allCompletedProp)).toBe('AllCompleted');
            expect(as(allCompletedProp.expression, 'BooleanFunction').functionName).toBe('All');
        });

        it('parseGroupByWithDefaultAliasWhenNoAliasProvided', () => {
            // :count should get default alias "Count"
            const projNode = as(parseExpression('Orders:groupBy(Status).{Status, :count}'), 'Projection');
            expect(outputKey(projNode.properties[1])).toBe('Count');
        });

        it('parseGroupByWithMultipleKeysAndComplexAggregations', () => {
            const projNode = as(parseExpression(
                'Sales:groupBy(Year, Quarter, Region).{Year, Quarter, Region, :count as SalesCount, :sum(Amount) as TotalSales, :avg(Amount) as AvgSale}'),
            'Projection');

            expect(as(projNode.source, 'GroupBy').keyProperties).toHaveLength(3);

            expect(projNode.properties).toHaveLength(6);
            expect(projNode.properties[0].path).toBe('Year');
            expect(projNode.properties[1].path).toBe('Quarter');
            expect(projNode.properties[2].path).toBe('Region');
            expect(outputKey(projNode.properties[3])).toBe('SalesCount');
            expect(outputKey(projNode.properties[4])).toBe('TotalSales');
            expect(outputKey(projNode.properties[5])).toBe('AvgSale');
        });

        it('parseGroupByWithTernaryInProjectionComplexScenario', () => {
            const projNode = as(
                parseExpression("Orders:groupBy(Status).{Status, (:count > 10 ? 'High' : 'Low') as Volume}"),
                'Projection');

            const volumeProp = projNode.properties[1];
            expect(outputKey(volumeProp)).toBe('Volume');
            const ternary = as(volumeProp.expression, 'Ternary');
            as(ternary.condition, 'BinaryCondition');
        });

        it('parseGroupByWithCoalesceInProjectionComplexScenario', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(Status).{Status, (:sum(Discount) ?? 0) as TotalDiscount}'), 'Projection');

            const discountProp = projNode.properties[1];
            expect(outputKey(discountProp)).toBe('TotalDiscount');
            as(discountProp.expression, 'Coalesce');
        });

        it('parseGroupByOnNestedCollectionAfterNavigation', () => {
            // NavigationNode [Customer, Projection(GroupBy(Where(Orders)))]
            const navNode = as(parseExpression(
                "Customer.Orders:where(Status != 'Cancelled'):groupBy(ProductCategory).{ProductCategory, :count as CategoryCount}"),
            'Navigation');
            expect(navNode.segments).toHaveLength(2);

            expect(as(navNode.segments[0], 'Property').name).toBe('Customer');

            const projNode = as(navNode.segments[1], 'Projection');
            const groupByNode = as(projNode.source, 'GroupBy');
            expect(groupByNode.keyProperties[0]).toBe('ProductCategory');

            const filterNode = as(groupByNode.source, 'Filter');
            expect(as(filterNode.source, 'Property').name).toBe('Orders');
        });

        it('parseGroupByWithOnlyItemsInProjection', () => {
            const projNode = as(parseExpression('Orders:groupBy(Status).{:count}'), 'Projection');

            expect(projNode.properties).toHaveLength(1);
            expect(as(projNode.properties[0].expression, 'Function').functionName).toBe('Count');
        });

        it('parseGroupByPreservesKeyPropertyCase', () => {
            const projNode = as(parseExpression('Orders:groupBy(CustomerID).{CustomerID, :count}'), 'Projection');

            expect(as(projNode.source, 'GroupBy').keyProperties[0]).toBe('CustomerID');
            expect(projNode.properties[0].path).toBe('CustomerID');
        });
    });

    describe('GroupBy Tests - Inner Projection', () => {
        it('parseGroupByWithInnerProjectionSimpleCase', () => {
            const projNode = as(parseExpression('Orders:groupBy(Status).{Status, {Id, Total} as Items}'), 'Projection');

            const groupByNode = as(projNode.source, 'GroupBy');
            expect(groupByNode.keyProperties[0]).toBe('Status');

            expect(projNode.properties).toHaveLength(2);

            expect(projNode.properties[0].path).toBe('Status');

            const itemsProp = projNode.properties[1];
            expect(outputKey(itemsProp)).toBe('Items');
            expect(isComputed(itemsProp)).toBe(true);

            // A ProjectionNode with GroupElementsNode as source
            const innerProjNode = as(itemsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');

            expect(innerProjNode.properties).toHaveLength(2);
            expect(innerProjNode.properties[0].path).toBe('Id');
            expect(innerProjNode.properties[1].path).toBe('Total');
        });

        it('parseGroupByWithInnerProjectionMultipleProperties', () => {
            const projNode = as(parseExpression(
                'Orders:groupBy(CustomerId).{CustomerId, {Id, ProductName, Quantity, UnitPrice} as OrderDetails}'),
            'Projection');

            const detailsProp = projNode.properties[1];
            expect(outputKey(detailsProp)).toBe('OrderDetails');

            const innerProjNode = as(detailsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');
            expect(innerProjNode.properties.map(p => p.path)).toEqual(['Id', 'ProductName', 'Quantity', 'UnitPrice']);
        });

        it('parseGroupByWithInnerProjectionWithAggregation', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(Status).{Status, :count as Count, {Id, CustomerName} as Items}'),
                'Projection');

            expect(projNode.properties).toHaveLength(3);

            expect(projNode.properties[0].path).toBe('Status');

            expect(outputKey(projNode.properties[1])).toBe('Count');
            as(projNode.properties[1].expression, 'Function');

            const itemsProp = projNode.properties[2];
            expect(outputKey(itemsProp)).toBe('Items');
            const innerProjNode = as(itemsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');
            expect(innerProjNode.properties).toHaveLength(2);
        });

        it('parseGroupByWithInnerProjectionMultipleKeys', () => {
            const projNode = as(
                parseExpression('Sales:groupBy(Year, Month).{Year, Month, {Id, Amount, Customer} as Transactions}'),
                'Projection');

            expect(as(projNode.source, 'GroupBy').keyProperties).toEqual(['Year', 'Month']);

            expect(projNode.properties).toHaveLength(3);
            expect(projNode.properties[0].path).toBe('Year');
            expect(projNode.properties[1].path).toBe('Month');

            const transactionsProp = projNode.properties[2];
            expect(outputKey(transactionsProp)).toBe('Transactions');

            const innerProjNode = as(transactionsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');
            expect(innerProjNode.properties).toHaveLength(3);
        });

        it('parseGroupByWithInnerProjectionSingleProperty', () => {
            const projNode = as(parseExpression('Orders:groupBy(Status).{Status, {Id} as OrderIds}'), 'Projection');

            const orderIdsProp = projNode.properties[1];
            expect(outputKey(orderIdsProp)).toBe('OrderIds');

            const innerProjNode = as(orderIdsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');
            expect(innerProjNode.properties).toHaveLength(1);
            expect(innerProjNode.properties[0].path).toBe('Id');
        });

        it('parseGroupByWithInnerProjectionAliasedInnerProperties', () => {
            const projNode = as(
                parseExpression('Orders:groupBy(Status).{Status, {Id as OrderId, Total as OrderTotal} as Items}'),
                'Projection');

            const itemsProp = projNode.properties[1];
            expect(outputKey(itemsProp)).toBe('Items');

            const innerProjNode = as(itemsProp.expression, 'Projection');
            expect(innerProjNode.properties).toHaveLength(2);
            expect(innerProjNode.properties[0].path).toBe('Id');
            expect(outputKey(innerProjNode.properties[0])).toBe('OrderId');
            expect(innerProjNode.properties[1].path).toBe('Total');
            expect(outputKey(innerProjNode.properties[1])).toBe('OrderTotal');
        });

        it('parseGroupByWithInnerProjectionMissingAliasThrowsException', () => {
            const expression = 'Orders:groupBy(Status).{Status, {Id, Total}}';
            expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
            expect(() => parseExpression(expression)).toThrow('as');
        });

        it('parseGroupByWithInnerProjectionAfterFilter', () => {
            const projNode = as(
                parseExpression('Orders:where(Year = 2024):groupBy(Status).{Status, {Id, CustomerName} as Items}'),
                'Projection');

            as(as(projNode.source, 'GroupBy').source, 'Filter');

            const itemsProp = projNode.properties[1];
            expect(outputKey(itemsProp)).toBe('Items');
            as(as(itemsProp.expression, 'Projection').source, 'GroupElements');
        });

        it('parseGroupByWithInnerProjectionComplexCombination', () => {
            const projNode = as(parseExpression(
                'Orders:groupBy(Status).{Status, :count as Count, :sum(Total) as Revenue, {Id, CustomerName, Total} as Details}'),
            'Projection');

            expect(projNode.properties).toHaveLength(4);

            expect(projNode.properties[0].path).toBe('Status');

            expect(outputKey(projNode.properties[1])).toBe('Count');
            as(projNode.properties[1].expression, 'Function');

            expect(outputKey(projNode.properties[2])).toBe('Revenue');
            as(projNode.properties[2].expression, 'Aggregation');

            const detailsProp = projNode.properties[3];
            expect(outputKey(detailsProp)).toBe('Details');
            const innerProjNode = as(detailsProp.expression, 'Projection');
            as(innerProjNode.source, 'GroupElements');
            expect(innerProjNode.properties).toHaveLength(3);
        });
    });
});
