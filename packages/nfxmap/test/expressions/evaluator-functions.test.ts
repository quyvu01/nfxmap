import { describe, expect, it } from 'vitest';
import { ExpressionEvaluationError } from '../../src/expressions/errors.js';
import { ExpressionEvaluator } from '../../src/expressions/evaluator.js';
import { canonical, canonicalJson } from './canonical.js';

/**
 * Every function of the expression language, evaluated in memory. The expected values are the ones that
 * docs/expression.md gives, not what the code happens to answer. Ported from jfxmap's ExpressionFunctionsTest (itself
 * from FxMap's ExpressionFunctionTests).
 */

interface Line { status: string; total: number; year: number; quantity: number }
interface Address { city: string }
interface Person {
    id: string; name: string; lastName: string; padded: string; tags: string; nick: string | null;
    createdAt: Date; born: Date; price: number; tax: number; balance: number;
    value: number; quantity: number; score: number; active: boolean; address: Address | null; orders: Line[];
    noOrders: Line[];
}

// Today is 2026-01-10 for :daysAgo
const EVALUATOR = new ExpressionEvaluator({ now: () => new Date('2026-01-10T12:00:00Z') });

function data(address: Address | null): Person {
    return {
        id: 'P1', name: 'John', lastName: 'Doe', padded: '  john  ', tags: 'a,b,c', nick: null,
        createdAt: new Date('2024-12-25T14:30:45Z'), // a Wednesday
        born: new Date('2026-01-05T00:00:00Z'), // 5 days before today
        price: 10.456, tax: 2, balance: -100, value: 10, quantity: 3, score: 85, active: true, address,
        orders: [
            { status: 'Done', total: 100, year: 2024, quantity: 1 },
            { status: 'Done', total: 200, year: 2024, quantity: 2 },
            { status: 'Pending', total: 300, year: 2025, quantity: 5 }],
        noOrders: [],
    };
}

const evaluate = (expression: string, person: Person) => EVALUATOR.evaluate(expression, person);

function check(expression: string, expected: string): void {
    expect(canonical(evaluate(expression, data(null))), expression).toEqual(canonicalJson(expected));
}

/** The `expression => expected` rows of the CsvSources. */
function cases(...rows: string[]): [string, string][] {
    return rows.map(r => {
        const [expression, expected] = r.split(' => ');
        return [expression, expected];
    });
}

describe('ExpressionFunctionsTest', () => {
    it.each(cases(
        'Name:upper => "JOHN"',
        'Name:lower => "john"',
        'Padded:trim => "john"',
        'Name:substring(0, 3) => "Joh"',
        'Name:substring(1) => "ohn"',
        'Name:substring(1, 2) => "oh"',
        'Name:replace(\'o\', \'a\') => "Jahn"',
        'Name:concat(\' \', LastName) => "John Doe"',
        'Name:concat(\'-\', \'x\', \'-\', LastName) => "John-x-Doe"',
        'Tags:split(\',\') => ["a","b","c"]',
    ))('stringFunctions(%s)', check);

    it.each(cases(
        'Padded:trim:upper:substring(0, 3) => "JOH"',
        'Name:upper:lower => "john"',
        'Name:concat(\' \', LastName):upper => "JOHN DOE"',
        'Name:replace(\'o\', \'0\'):upper => "J0HN"',
    ))('stringFunctionsChain(%s)', check);

    it.each(cases(
        'CreatedAt:year => 2024',
        'CreatedAt:month => 12',
        'CreatedAt:day => 25',
        'CreatedAt:hour => 14',
        'CreatedAt:minute => 30',
        'CreatedAt:second => 45',
        'CreatedAt:dayOfWeek => 3', // Sunday is 0
        'Born:daysAgo => 5',
        'CreatedAt:format(\'yyyy-MM-dd\') => "2024-12-25"',
        'CreatedAt:format(\'dd/MM/yyyy HH:mm:ss\') => "25/12/2024 14:30:45"',
        'CreatedAt:year:add(1) => 2025',
    ))('dateFunctions(%s)', check);

    // JS: numbers are compared with 12 significant digits (canonical), as 10.456 * 3 is 31.368000000000002
    it.each(cases(
        'Price:round(2) => 10.46',
        'Price:round => 10',
        'Price:round(0) => 10',
        'Price:floor => 10',
        'Price:ceil => 11',
        'Balance:abs => 100',
        'Price:add(Tax) => 12.456',
        'Price:add(1) => 11.456',
        'Price:subtract(Tax) => 8.456',
        'Price:subtract(10) => 0.456',
        'Price:multiply(Quantity) => 31.368',
        'Price:multiply(2) => 20.912',
        'Price:divide(Tax) => 5.228',
        'Price:divide(2) => 5.228',
        'Value:mod(3) => 1',
        'Value:pow(2) => 100',
        'Price:add(Tax):round(2) => 12.46',
        'Value:add(5):multiply(2) => 30',
    ))('mathFunctions(%s)', check);

    it.each(cases(
        'Orders:count => 3',
        'Orders:sum(Total) => 600',
        'Orders:avg(Total) => 200',
        'Orders:min(Total) => 100',
        'Orders:max(Total) => 300',
        'Orders:where(Status = \'Done\'):count => 2',
        'Orders:where(Status = \'Done\'):sum(Total) => 300',
        'Orders:where(Year = 2025):avg(Total) => 300',
        'NoOrders:count => 0',
        'NoOrders:sum(Total) => 0',
        'Name:count => 4',
    ))('aggregations(%s)', check);

    it.each(cases(
        'Orders:any => true',
        'NoOrders:any => false',
        'Orders:any(Status = \'Done\') => true',
        'Orders:any(Total > 1000) => false',
        'Orders:all(Total > 0) => true',
        'Orders:all(Total > 100) => false',
        'Orders:all(Status != \'Cancelled\') => true',
        'NoOrders:all(Total > 0) => true',
    ))('booleanFunctions(%s)', check);

    it.each(cases(
        'Orders:where(Total >= 200 && Status = \'Done\'):count => 1',
        'Orders:where(Status = \'Done\' || Total > 250):count => 3',
        'Orders:where(Status = \'Done\', Total > 150):count => 1', // a comma is AND
        'Orders:where(Status != \'Done\'):count => 1',
        'Orders:where(Status contains \'on\'):count => 2',
        'Orders:where(Status startswith \'Do\'):count => 2',
        'Orders:where(Status endswith \'ing\'):count => 1',
        'Orders:where(Total < 200):count => 1',
        'Orders:where(Total <= 200):count => 2',
        'Orders:where(Total > 100 && Total < 300):count => 1',
        'Orders:where(Status:lower = \'done\'):count => 2',
        'Orders:where(Status:upper = \'PENDING\'):count => 1',
        'Orders:where(Quantity > 1):sum(Total) => 500',
    ))('filters(%s)', check);

    it.each(cases(
        'Nick ?? Name => "John"',
        'Nick ?? Name ?? \'x\' => "John"',
        'Nick ?? \'Anonymous\' => "Anonymous"',
        'Address?.City ?? \'Unknown\' => "Unknown"',
        'Active = true ? \'Yes\' : \'No\' => "Yes"',
        'Active = false ? \'Yes\' : \'No\' => "No"',
        'Score >= 90 ? \'A\' : Score >= 80 ? \'B\' : Score >= 70 ? \'C\' : \'F\' => "B"',
        'Score >= 95 ? \'A\' : Score >= 80 ? \'B\' : \'F\' => "B"',
        'Orders:any(Status = \'Pending\') ? \'Has\' : \'None\' => "Has"',
        'Orders:any(Status = \'Cancelled\') ? \'Has\' : \'None\' => "None"',
        'Orders:count > 2 ? \'Many\' : \'Few\' => "Many"',
        'Name = \'John\' && Score > 80 ? \'Hit\' : \'Miss\' => "Hit"',
        'Name = \'John\' && Score > 90 ? \'Hit\' : \'Miss\' => "Miss"',
        'Name = \'Jane\' || Score > 80 ? \'Hit\' : \'Miss\' => "Hit"',
        'Name = \'Jane\' || Score > 90 ? \'Hit\' : \'Miss\' => "Miss"',
        'Name = \'Jane\' && Score > 80 || Active = true ? \'Hit\' : \'Miss\' => "Hit"', // && binds tighter than ||
        'Name = \'John\' || Name = \'Jane\' && Score > 90 ? \'Hit\' : \'Miss\' => "Hit"',
    ))('coalesceAndTernary(%s)', check);

    it.each(cases(
        '{Id, Name} => {"Id":"P1","Name":"John"}',
        '{Id, Name as Given} => {"Id":"P1","Given":"John"}',
        '{Name:upper as Loud, Padded:trim as Clean} => {"Loud":"JOHN","Clean":"john"}',
        '{(Nick ?? Name) as DisplayName} => {"DisplayName":"John"}',
        '{(Active = true ? \'Yes\' : \'No\') as IsActive} => {"IsActive":"Yes"}',
        '{(Score >= 80 ? \'High\' : \'Low\') as Tier} => {"Tier":"High"}',
        '{CreatedAt:format(\'yyyy-MM-dd\') as Date} => {"Date":"2024-12-25"}',
        '{Orders:count as N, Orders:sum(Total) as Sum} => {"N":3,"Sum":600}',
        'Orders.{Status, Total} => [{"Status":"Done","Total":100},{"Status":"Done","Total":200},'
        + '{"Status":"Pending","Total":300}]',
        'Orders.{Status, Total:multiply(2) as Double} => [{"Status":"Done","Double":200},'
        + '{"Status":"Done","Double":400},{"Status":"Pending","Double":600}]',
    ))('projections(%s)', check);

    it.each(cases(
        'Orders:distinct(Status) => ["Done","Pending"]',
        'Orders:distinct(Year) => [2024,2025]',
        'Orders:distinct(Status):count => 2',
        'Orders:where(Year = 2024):distinct(Status) => ["Done"]',
    ))('distinct(%s)', check);

    it.each(cases(
        'Orders:groupBy(Status).{Status, :count as Count} => [{"Status":"Done","Count":2},'
        + '{"Status":"Pending","Count":1}]',
        'Orders:groupBy(Status).{Status, :count as Count, :sum(Total) as Revenue} => '
        + '[{"Status":"Done","Count":2,"Revenue":300},{"Status":"Pending","Count":1,"Revenue":300}]',
        'Orders:groupBy(Status).{Status, :avg(Total) as Avg, :min(Total) as Min, :max(Total) as Max} => '
        + '[{"Status":"Done","Avg":150,"Min":100,"Max":200},{"Status":"Pending","Avg":300,"Min":300,"Max":300}]',
        'Orders:groupBy(Year, Status).{Year, Status, :count as N} => [{"Year":2024,"Status":"Done","N":2},'
        + '{"Year":2025,"Status":"Pending","N":1}]',
        'Orders:where(Total > 100):groupBy(Status).{Status, :count as N} => [{"Status":"Done","N":1},'
        + '{"Status":"Pending","N":1}]',
    ))('groupBy(%s)', check);

    it('aNullSafeNavigationGivesNullWhenTheNestedObjectIsMissing', () => {
        // (Address.City without the `?` is not null-safe: it fails, as LINQ over objects does)
        check('Address?.City', 'null');
        const withAddress = data({ city: 'Hanoi' });
        expect(evaluate('Address.City', withAddress)).toBe('Hanoi');
        expect(evaluate('Address?.City', withAddress)).toBe('Hanoi');
        expect(evaluate('Address?.City ?? \'Unknown\'', withAddress)).toBe('Hanoi');
        expect(() => evaluate('Address.City', data(null))).toThrow(ExpressionEvaluationError);
    });

    // JS: 'NoOrders:sum(Nope)' is not here: Java fails on the declared item type of the empty list, and JS has no
    // declared types, so a property of the items of an empty array is never read
    it.each([
        'Missing',
        'Name:nope',
        'Orders:sum(Nope)',
        'Orders:where(Nope = 1)',
        'Name:substring(\'x\')',
    ])('aWrongExpressionFailsInsteadOfAnsweringSomething(%s)', expression => {
        expect(() => evaluate(expression, data(null))).toThrow();
    });
});
