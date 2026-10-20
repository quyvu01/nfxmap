import { describe, expect, it } from 'vitest';
import { ExpressionEvaluator } from '../../src/expressions/evaluator.js';
import { type ExpressionNode, functionArguments, Nodes } from '../../src/expressions/nodes.js';
import { parseExpression } from '../../src/expressions/parser.js';

/**
 * The expression features over a graph of objects: filters, ordering and paging, projections, functions and chains.
 * Ported from jfxmap's ExpressionEvaluationTest (itself from FxMap's ExpressionIntegrationTests).
 */

interface TestCity { id: string; name: string; population: number; isCapital: boolean; foundedYear: number }
interface TestProvince { id: string; name: string; code: string; area: number; cities: TestCity[] }
interface TestCountry { id: string; name: string; code: string; population: number; provinces: TestProvince[] }
interface TestOrderItem { id: string; productName: string; quantity: number; price: number; category: string }
interface TestOrder { id: string; status: string; total: number; orderDate: Date; items: TestOrderItem[] }
interface TestCustomer {
    id: string; name: string; email: string; age: number; isVip: boolean; createdAt: Date; orders: TestOrder[];
}

type Kind = ExpressionNode['kind'];
type NodeOf<K extends Kind> = Extract<ExpressionNode, { kind: K }>;

function as<K extends Kind>(node: ExpressionNode | null | undefined, kind: K): NodeOf<K> {
    expect(node?.kind).toBe(kind);
    return node as NodeOf<K>;
}

const EVALUATOR = new ExpressionEvaluator();

// JS: a fixed now instead of LocalDateTime.now(), in UTC
const NOW = new Date('2026-01-10T12:00:00Z');
const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY);
const yearsBefore = (years: number) => new Date(Date.UTC(NOW.getUTCFullYear() - years, NOW.getUTCMonth(),
    NOW.getUTCDate(), 12));
const monthsBefore = (months: number) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - months,
    NOW.getUTCDate(), 12));

const city = (id: string, name: string, population: number, isCapital: boolean, foundedYear: number): TestCity =>
    ({ id, name, population, isCapital, foundedYear });

const COUNTRIES: TestCountry[] = [
    {
        id: 'country-usa', name: 'United States', code: 'US', population: 331000000, provinces: [
            {
                id: 'province-ca', name: 'California', code: 'CA', area: 423967, cities: [
                    city('city-la', 'Los Angeles', 3900000, false, 1781),
                    city('city-sf', 'San Francisco', 870000, false, 1776),
                    city('city-sac', 'Sacramento', 500000, true, 1850)],
            },
            {
                id: 'province-ny', name: 'New York', code: 'NY', area: 141297, cities: [
                    city('city-nyc', 'New York City', 8400000, false, 1624),
                    city('city-alb', 'Albany', 98000, true, 1614)],
            },
            {
                id: 'province-tx', name: 'Texas', code: 'TX', area: 695662, cities: [
                    city('city-hou', 'Houston', 2300000, false, 1837),
                    city('city-dal', 'Dallas', 1300000, false, 1841),
                    city('city-aus', 'Austin', 950000, true, 1839),
                    city('city-sat', 'San Antonio', 1500000, false, 1718)],
            }],
    },
    {
        id: 'country-jpn', name: 'Japan', code: 'JP', population: 126000000, provinces: [
            {
                id: 'province-tokyo', name: 'Tokyo', code: 'TK', area: 2194, cities: [
                    city('city-tokyo', 'Tokyo', 13960000, true, 1457),
                    city('city-shibuya', 'Shibuya', 230000, false, 1932)],
            },
            {
                id: 'province-osaka', name: 'Osaka', code: 'OS', area: 1905, cities: [
                    city('city-osaka', 'Osaka', 2750000, false, 1583)],
            }],
    },
    // No provinces, for the edge cases
    { id: 'country-empty', name: 'Empty Country', code: 'XX', population: 0, provinces: [] },
];

const item = (id: string, productName: string, quantity: number, price: number, category: string): TestOrderItem =>
    ({ id, productName, quantity, price, category });

const order = (id: string, status: string, total: number, orderDate: Date, items: TestOrderItem[]): TestOrder =>
    ({ id, status, total, orderDate, items });

const CUSTOMERS: TestCustomer[] = [
    {
        id: 'customer-john', name: 'John Doe', email: 'john@example.com', age: 35, isVip: true,
        createdAt: yearsBefore(3), orders: [
            order('order-1', 'Completed', 1500.00, daysBefore(30), [
                item('item-1-1', 'Laptop', 1, 1200.00, 'Electronics'),
                item('item-1-2', 'Mouse', 2, 150.00, 'Electronics')]),
            order('order-2', 'Completed', 350.00, daysBefore(20), [
                item('item-2-1', 'Book', 5, 50.00, 'Books'),
                item('item-2-2', 'Pen Set', 2, 50.00, 'Stationery')]),
            order('order-3', 'Pending', 2500.00, daysBefore(5), [
                item('item-3-1', 'Monitor', 2, 800.00, 'Electronics'),
                item('item-3-2', 'Keyboard', 1, 250.00, 'Electronics'),
                item('item-3-3', 'Webcam', 1, 150.00, 'Electronics'),
                item('item-3-4', 'Desk Lamp', 2, 250.00, 'Home')]),
            order('order-4', 'Cancelled', 100.00, daysBefore(60), [
                item('item-4-1', 'Notebook', 10, 10.00, 'Stationery')])],
    },
    {
        id: 'customer-jane', name: 'Jane Smith', email: 'jane@example.com', age: 28, isVip: false,
        createdAt: yearsBefore(1), orders: [
            order('order-5', 'Completed', 800.00, daysBefore(10), [
                item('item-5-1', 'Headphones', 1, 300.00, 'Electronics'),
                item('item-5-2', 'Phone Case', 3, 50.00, 'Accessories'),
                item('item-5-3', 'Charger', 2, 200.00, 'Electronics')])],
    },
    // No orders, for the edge cases
    {
        id: 'customer-bob', name: 'Bob Wilson', email: 'bob@example.com', age: 45, isVip: true,
        createdAt: yearsBefore(5), orders: [],
    },
    {
        id: 'customer-alice', name: 'Alice Brown', email: 'alice@example.com', age: 32, isVip: false,
        createdAt: monthsBefore(6), orders: [
            order('order-6', 'Completed', 5000.00, daysBefore(2), [
                item('item-6-1', 'MacBook Pro', 1, 2500.00, 'Electronics'),
                item('item-6-2', 'iPad', 1, 1500.00, 'Electronics'),
                item('item-6-3', 'AirPods', 2, 500.00, 'Electronics')]),
            order('order-7', 'Pending', 150.00, daysBefore(1), [
                item('item-7-1', 'USB Cable', 5, 20.00, 'Accessories'),
                item('item-7-2', 'Screen Protector', 2, 25.00, 'Accessories')])],
    },
];

function find<T extends { id: string }>(items: T[], id: string): T {
    const found = items.find(i => i.id === id);
    if (found === undefined) throw new Error(`No ${id}`);
    return found;
}

const customer = (id: string, expression: string) => EVALUATOR.evaluate(expression, find(CUSTOMERS, id));
const province = (id: string, expression: string) =>
    EVALUATOR.evaluate(expression, find(COUNTRIES.flatMap(c => c.provinces), id));
const country = (id: string, expression: string) => EVALUATOR.evaluate(expression, find(COUNTRIES, id));

type Row = Record<string, unknown>;
const rows = (value: unknown) => value as Row[];
const row = (value: unknown) => value as Row;

describe('ExpressionEvaluationTest', () => {
    describe('Ordering and paging', () => {
        it('orderByNameReturnsOrderedCollection', () => {
            const node = as(parseExpression('Cities:orderBy(Name)'), 'Function');
            expect(node.functionName).toBe('OrderBy');

            const cities = rows(province('province-ca', 'Cities:orderBy(Name).{Id, Name}'));
            expect(cities).toHaveLength(3);

            // Ordered by Name ascending
            expect(cities[0].Name).toBe('Los Angeles');
            expect(cities[1].Name).toBe('Sacramento');
            expect(cities[2].Name).toBe('San Francisco');
        });

        it('orderByPopulationDescReturnsOrderedCollection', () => {
            const cities = rows(province('province-ca', 'Cities:orderBy(Population desc).{Name, Population}'));
            expect(cities).toHaveLength(3);

            expect(cities[0].Name).toBe('Los Angeles');
            expect(cities[0].Population).toBe(3900000);
            expect(cities[1].Name).toBe('San Francisco');
            expect(cities[2].Name).toBe('Sacramento');
        });

        it('firstReturnsFirstOrderedItem', () => {
            const firstCity = row(province('province-tx', 'Cities:orderBy(Name):first.{Id, Name}'));
            expect(firstCity).not.toBeNull();
            expect(firstCity.Name).toBe('Austin'); // First alphabetically
        });

        it('lastReturnsLastOrderedItem', () => {
            const lastCity = row(province('province-tx', 'Cities:orderBy(Population desc):last.{Name, Population}'));
            expect(lastCity).not.toBeNull();
            // desc Population order: Houston(2.3M), San Antonio(1.5M), Dallas(1.3M), Austin(950K)
            expect(lastCity.Name).toBe('Austin');
        });

        it('limitReturnsPagedCollection', () => {
            const cities = rows(province('province-tx', 'Cities:orderBy(Name):limit(2).{Name}'));
            expect(cities).toHaveLength(2);
            expect(cities[0].Name).toBe('Austin');
            expect(cities[1].Name).toBe('Dallas');
        });

        it('offsetAndLimitReturnPaginatedResults', () => {
            const cities = rows(province('province-tx', 'Cities:orderBy(Name):offset(1):limit(2).{Name}'));
            expect(cities).toHaveLength(2);
            // Order: Austin, Dallas, Houston, San Antonio; skip Austin, take Dallas and Houston
            expect(cities[0].Name).toBe('Dallas');
            expect(cities[1].Name).toBe('Houston');
        });
    });

    describe('Filters', () => {
        it('filterSimpleEqualsReturnsMatchingItems', () => {
            expect(customer('customer-john', "Orders:where(Status = 'Completed'):count")).toBe(2);
        });

        it('filterGreaterThanReturnsMatchingItems', () => {
            // order-1 (1500), order-3 (2500)
            expect(customer('customer-john', 'Orders:where(Total > 1000):count')).toBe(2);
        });

        it('filterLessThanOrEqualReturnsMatchingItems', () => {
            // order-2 (350), order-4 (100)
            expect(customer('customer-john', 'Orders:where(Total <= 500):count')).toBe(2);
        });

        it('filterNotEqualsReturnsNonMatchingItems', () => {
            expect(customer('customer-john', "Orders:where(Status != 'Cancelled'):count")).toBe(3);
        });

        it('filterContainsReturnsMatchingItems', () => {
            // "Pending" contains "end"
            expect(customer('customer-john', "Orders:where(Status contains 'end'):count")).toBe(1);
        });

        it('filterStartsWithReturnsMatchingItems', () => {
            // "Completed" (2) + "Cancelled" (1)
            expect(customer('customer-john', "Orders:where(Status startswith 'C'):count")).toBe(3);
        });

        it('filterEndsWithReturnsMatchingItems', () => {
            // "Completed" (2) + "Cancelled" (1)
            expect(customer('customer-john', "Orders:where(Status endswith 'ed'):count")).toBe(3);
        });

        it('filterAndConditionReturnsMatchingItems', () => {
            // Only order-1 (Status=Completed AND Total=1500)
            expect(customer('customer-john', "Orders:where(Status = 'Completed', Total > 500):count")).toBe(1);
        });

        it('filterOrConditionReturnsMatchingItems', () => {
            // order-3 (Pending), order-4 (Cancelled)
            expect(customer('customer-john', "Orders:where(Status = 'Pending' || Status = 'Cancelled'):count"))
                .toBe(2);
        });
    });

    describe('Aggregate functions', () => {
        it('countReturnsCollectionCount', () => {
            expect(customer('customer-john', 'Orders:count')).toBe(4);
        });

        it('sumReturnsSum', () => {
            // 1500 + 350 + 2500 + 100
            expect(customer('customer-john', 'Orders:sum(Total)')).toBe(4450);
        });

        it('avgReturnsAverage', () => {
            // 4450 / 4
            expect(customer('customer-john', 'Orders:avg(Total)')).toBe(1112.5);
        });

        it('minReturnsMinimum', () => {
            expect(customer('customer-john', 'Orders:min(Total)')).toBe(100);
        });

        it('maxReturnsMaximum', () => {
            expect(customer('customer-john', 'Orders:max(Total)')).toBe(2500);
        });

        it('anyReturnsTrueWhenMatchExists', () => {
            expect(customer('customer-john', "Orders:any(Status = 'Pending')")).toBe(true);
        });

        it('anyReturnsFalseWhenNoMatch', () => {
            expect(customer('customer-john', "Orders:any(Status = 'Shipped')")).toBe(false);
        });

        it('allReturnsTrueWhenAllMatch', () => {
            expect(customer('customer-john', 'Orders:all(Total > 0)')).toBe(true);
        });

        it('allReturnsFalseWhenNotAllMatch', () => {
            // order-4 has Total = 100
            expect(customer('customer-john', 'Orders:all(Total > 200)')).toBe(false);
        });
    });

    describe('String functions', () => {
        it('upperReturnsUppercase', () => {
            expect(customer('customer-john', 'Name:upper')).toBe('JOHN DOE');
        });

        it('lowerReturnsLowercase', () => {
            expect(customer('customer-john', 'Email:lower')).toBe('john@example.com');
        });

        it('countOfAStringReturnsLength', () => {
            expect(customer('customer-john', 'Name:count')).toBe(8); // "John Doe".length
        });
    });

    describe('Chains', () => {
        it('filterThenOrderThenProjection', () => {
            const firstCompletedOrder = row(customer('customer-john',
                "Orders:where(Status = 'Completed'):orderBy(OrderDate):first.{Id, Total}"));
            expect(firstCompletedOrder).not.toBeNull();
            // Completed orders, oldest first: order-1 (30 days ago), order-2 (20 days ago)
            expect(firstCompletedOrder.Id).toBe('order-1');
            expect(firstCompletedOrder.Total).toBe(1500);
        });

        it('filterThenAggregate', () => {
            // 1500 + 350
            expect(customer('customer-john', "Orders:where(Status = 'Completed'):sum(Total)")).toBe(1850);
        });

        it('filteredCollectionMax', () => {
            // Completed orders: order-1 (1500), order-2 (350)
            expect(customer('customer-john', "Orders:where(Status = 'Completed'):max(Total)")).toBe(1500);
        });

        it('filteredCollectionMin', () => {
            expect(customer('customer-john', "Orders:where(Status = 'Completed'):min(Total)")).toBe(350);
        });

        it('filteredProvincesCount', () => {
            // Texas (695662), California (423967) > 200000
            expect(country('country-usa', 'Provinces:where(Area > 200000):count')).toBe(2);
        });

        it('orderThenTakeWithProjection', () => {
            const provinces = rows(country('country-usa', 'Provinces:orderBy(Area desc):limit(2).{Name, Area}'));
            expect(provinces).toHaveLength(2);
            // Desc by Area: Texas (695662), California (423967), New York (141297)
            expect(provinces[0].Name).toBe('Texas');
            expect(provinces[1].Name).toBe('California');
        });

        it('multipleExpressionsMixedTypes', () => {
            expect(customer('customer-john', 'Name')).toBe('John Doe');
            expect(customer('customer-john', 'Age')).toBe(35);
            expect(customer('customer-john', 'IsVip')).toBe(true);
            expect(customer('customer-john', 'Orders:count')).toBe(4);
            expect(customer('customer-john', "Orders:where(Status = 'Completed'):sum(Total)")).toBe(1850);
            // Average of all orders: (1500+350+2500+100)/4
            expect(customer('customer-john', 'Orders:avg(Total)')).toBe(1112.5);
        });
    });

    describe('Edge cases', () => {
        it('emptyCollectionCountReturnsZero', () => {
            expect(customer('customer-bob', 'Orders:count')).toBe(0); // Bob has no orders
        });

        it('emptyCollectionSumReturnsZero', () => {
            // JS: the number 0 (Java gives the zero of the type of Total, BigDecimal.ZERO)
            expect(customer('customer-bob', 'Orders:sum(Total)')).toBe(0);
        });

        it('filterReturnsEmptyCountReturnsZero', () => {
            expect(customer('customer-john', "Orders:where(Status = 'NonExistent'):count")).toBe(0);
        });

        it('firstOfAnEmptyCollectionProjectsToNullValues', () => {
            // The projection of the first item of an empty collection has its properties null
            const dict = row(customer('customer-bob', 'Orders:orderBy(OrderDate):first.{Id}'));
            expect(dict).not.toBeNull();
            expect(dict).toEqual({ Id: null });
        });

        it('emptyProvincesCollectionCountReturnsZero', () => {
            expect(country('country-empty', 'Provinces:count')).toBe(0);
        });

        it('projectionOnEmptyCollectionReturnsEmptyList', () => {
            expect(rows(customer('customer-bob', 'Orders.{Id, Status}'))).toEqual([]);
        });

        it.each(['Orders:max(Total)', 'Orders:min(Total)', 'Orders:avg(Total)'])(
            'minMaxAverageOnEmptyCollectionReturnNull(%s)', expression => {
                expect(customer('customer-bob', expression)).toBeNull();
            });

        it('emptyCollectionDoesNotBreakAggregatesOfOtherObjects', () => {
            const withOrders = CUSTOMERS.filter(c => EVALUATOR.evaluate('Orders:max(Total)', c) !== null);
            expect(withOrders).not.toHaveLength(0);
            expect(customer('customer-bob', 'Orders:max(Total)')).toBeNull();
            expect(customer('customer-bob', 'Orders:sum(Total)')).toBe(0);
        });

        it('anyOnEmptyCollectionReturnsFalse', () => {
            expect(customer('customer-bob', "Orders:any(Status = 'Completed')")).toBe(false);
        });

        it('allOnEmptyCollectionReturnsTrue', () => {
            // Vacuous truth
            expect(customer('customer-bob', "Orders:all(Status = 'Completed')")).toBe(true);
        });
    });

    describe('Root projection', () => {
        it('rootProjectionSimpleFields', () => {
            const rootProj = row(customer('customer-jane', '{Id, Name, Email, Age}'));
            expect(rootProj).not.toBeNull();
            expect(rootProj.Id).toBe('customer-jane');
            expect(rootProj.Name).toBe('Jane Smith');
            expect(rootProj.Email).toBe('jane@example.com');
            expect(rootProj.Age).toBe(28);
        });

        it('rootProjectionWithAlias', () => {
            const rootProj = row(customer('customer-jane', '{Id, Name as CustomerName, Age as CustomerAge}'));
            expect(rootProj).not.toBeNull();
            expect(rootProj.Id).toBe('customer-jane');
            expect(rootProj.CustomerName).toBe('Jane Smith');
            expect(rootProj.CustomerAge).toBe(28);
        });
    });

    describe('Coalesce and ternary', () => {
        it('coalesceReturnsFirstNonNull', () => {
            expect(customer('customer-john', 'Email ?? Name')).toBe('john@example.com');
        });

        it('ternaryReturnsCorrectBranchWhenTrue', () => {
            // John is VIP
            expect(customer('customer-john', "IsVip = true ? 'VIP Customer' : 'Regular Customer'"))
                .toBe('VIP Customer');
        });

        it('ternaryReturnsCorrectBranchWhenFalse', () => {
            // Jane is not VIP
            expect(customer('customer-jane', "IsVip = true ? 'VIP Customer' : 'Regular Customer'"))
                .toBe('Regular Customer');
        });
    });

    describe('Collection projection', () => {
        it('collectionProjectionReturnsProjectedProperties', () => {
            const projectedOrders = rows(customer('customer-john', 'Orders.{Id, Status}'));
            expect(projectedOrders).toHaveLength(4); // John has 4 orders
            expect(projectedOrders).toContainEqual({ Id: 'order-1', Status: 'Completed' });
            expect(projectedOrders).toContainEqual({ Id: 'order-2', Status: 'Completed' });
            expect(projectedOrders).toContainEqual({ Id: 'order-3', Status: 'Pending' });
            expect(projectedOrders).toContainEqual({ Id: 'order-4', Status: 'Cancelled' });
        });

        it('collectionProjectionWithFilterReturnsFilteredProjectedProperties', () => {
            const projectedOrders = rows(customer('customer-john', "Orders:where(Status = 'Completed').{Id, Total}"));
            expect(projectedOrders).toHaveLength(2); // 2 completed orders
            expect(projectedOrders).toContainEqual({ Id: 'order-1', Total: 1500 });
            expect(projectedOrders).toContainEqual({ Id: 'order-2', Total: 350 });
        });

        it('collectionProjectionMultipleFieldsReturnsAllFields', () => {
            const projectedOrders = rows(customer('customer-jane', 'Orders.{Id, Status, Total}'));
            expect(projectedOrders).toHaveLength(1); // Jane has 1 order
            expect(projectedOrders[0].Id).toBe('order-5');
            expect(projectedOrders[0].Status).toBe('Completed');
            expect(projectedOrders[0].Total).toBe(800);
        });

        it('collectionProjectionEmptyCollectionReturnsEmptyList', () => {
            expect(rows(customer('customer-bob', 'Orders.{Id, Status}'))).toEqual([]);
        });
    });

    describe('Parser edge cases', () => {
        it('parserOrderByParsesCorrectly', () => {
            const fn = as(parseExpression('Items:orderBy(Name)'), 'Function');
            expect(fn.functionName).toBe('OrderBy');
            expect(functionArguments(fn)).toEqual([Nodes.sortKey('Name', 'Asc')]);
        });

        it('parserFirstAfterOrderByParsesCorrectly', () => {
            const first = as(parseExpression('Items:orderBy(Price desc):first'), 'Function');
            expect(first.functionName).toBe('First');
            expect(functionArguments(as(first.source, 'Function'))).toEqual([Nodes.sortKey('Price', 'Desc')]);
        });

        it('parserLastAfterOrderByParsesCorrectly', () => {
            const node = as(parseExpression('Items:orderBy(CreatedAt):last'), 'Function');
            expect(node.functionName).toBe('Last');
        });

        it('parserOffsetAndLimitAfterOrderByParsesCorrectly', () => {
            const limit = as(parseExpression('Items:orderBy(Total desc):offset(5):limit(10)'), 'Function');
            expect(limit.functionName).toBe('Take');
            const offset = as(limit.source, 'Function');
            expect(offset.functionName).toBe('Skip');
            expect(as(offset.source, 'Function').functionName).toBe('OrderBy');
        });

        it('parserComplexChainParsesCorrectly', () => {
            const node = parseExpression(
                "Orders:where(Status = 'Done'):orderBy(OrderDate):limit(2).Items:where(Quantity > 1):sum(Price)");

            // NavigationNode [limit(orderBy(where(Orders))), sum(where(Items))]
            const navigation = as(node, 'Navigation');
            expect(navigation.segments).toHaveLength(2);
            expect(as(navigation.segments[0], 'Function').functionName).toBe('Take');
            const sum = as(navigation.segments[1], 'Aggregation');
            expect(sum.aggregationType).toBe('Sum');
            expect(sum.source.kind).toBe('Filter');
        });
    });
});
