import { describe, expect, it } from 'vitest';
import { ExpressionEvaluationError } from '../../src/expressions/errors.js';
import { ExpressionEvaluator } from '../../src/expressions/evaluator.js';
import { functionArguments, Nodes } from '../../src/expressions/nodes.js';
import { ExpressionParseError, parseExpression } from '../../src/expressions/parser.js';
import { canonical, canonicalJson } from './canonical.js';

/** :orderBy, :offset and :limit on a collection. Ported from jfxmap's CollectionFunctionsTest. */

interface Entry { name: string; day: number; by: string }
interface Owner { id: string; entries: Entry[] }

const EVALUATOR = new ExpressionEvaluator();

const DATA: Owner = {
    id: 'O1', entries: [
        { name: 'c', day: 2, by: 'z' },
        { name: 'a', day: 2, by: 'y' },
        { name: 'b', day: 1, by: 'x' },
        { name: 'd', day: 3, by: 'w' }],
};

function names(expression: string): string {
    return (EVALUATOR.evaluate(expression, DATA) as Entry[]).map(e => e.name).join(',');
}

const one = (expression: string) => EVALUATOR.evaluate(expression, DATA) as Entry;

const json = (expression: string) => canonical(EVALUATOR.evaluate(expression, DATA));

/** The `expression => expected` rows of the CsvSources; the quotes of the expected value are removed. */
function cases(...rows: string[]): [string, string][] {
    return rows.map(r => {
        const [expression, expected] = r.split(' => ');
        return [expression, expected.replace(/^'(.*)'$/, '$1')];
    });
}

describe('CollectionFunctionsTest', () => {
    it.each(cases(
        "Entries:orderBy(Name) => 'a,b,c,d'",
        "Entries:orderBy(Name asc) => 'a,b,c,d'",
        "Entries:orderBy(Name desc) => 'd,c,b,a'",
        "Entries:orderBy(Day, By) => 'b,a,c,d'",
        "Entries:orderBy(Day, By desc) => 'b,c,a,d'",
        "Entries:orderBy(Day desc, Name asc) => 'd,a,c,b'",
        "Entries:orderBy(Day, Name, By desc) => 'b,a,c,d'",
    ))('orderByOrdersByTheFirstKeyThenByTheOthers(%s)', (expression, expected) => {
        expect(names(expression)).toBe(expected);
    });

    it.each(cases(
        "Entries:offset(0) => 'c,a,b,d'",
        "Entries:offset(1) => 'a,b,d'",
        "Entries:offset(4) => ''",
        "Entries:offset(10) => ''",
        "Entries:limit(0) => ''",
        "Entries:limit(2) => 'c,a'",
        "Entries:limit(10) => 'c,a,b,d'",
    ))('offsetAndLimit(%s)', (expression, expected) => {
        expect(names(expression)).toBe(expected);
    });

    it.each(cases(
        'Entries:first => c',
        'Entries:last => d',
        'Entries:orderBy(Name):first => a',
        'Entries:orderBy(Name):last => d',
        'Entries:orderBy(Day desc, Name):first => d',
        'Entries:orderBy(Day, By desc):last => d',
        'Entries:offset(1):first => a',
        'Entries:limit(2):last => a',
    ))('firstAndLastGiveOneItem(%s)', (expression, expected) => {
        expect(one(expression).name).toBe(expected);
    });

    it.each(['Entries:first', 'Entries:last'])('firstAndLastOfAnEmptyCollectionAreNull(%s)', expression => {
        const empty: Owner = { id: 'O2', entries: [] };

        expect(EVALUATOR.evaluate(expression, empty)).toBeNull();
    });

    it('offsetAndLimitAreAPageOfTheOrderedCollection', () => {
        expect(names('Entries:orderBy(Name desc):offset(1):limit(2)')).toBe('c,b');
    });

    it('offsetBeforeOrderByOrdersOnlyWhatIsLeft', () => {
        expect(names('Entries:offset(1):orderBy(Name)')).toBe('a,b,d');
    });

    it.each([
        'Entries:offset(-1)',
        'Entries:limit(1.5)',
        'Entries:limit(Name)',
        'Entries:orderBy(Missing)',
        'Entries:first(Name)',
    ])('aWrongArgumentIsRejected(%s)', expression => {
        expect(() => names(expression)).toThrow();
    });

    it('anOrderByOfAnEmptyCollectionStillChecksTheProperty', () => {
        // JS: there are no declared item types, so the property of the items of an empty array cannot be checked;
        // the orderBy of an empty array is an empty array, and a wrong property fails on an array that has items
        const empty: Owner = { id: 'O2', entries: [] };

        expect(EVALUATOR.evaluate('Entries:orderBy(Missing)', empty)).toEqual([]);
        expect(() => EVALUATOR.evaluate('Entries:orderBy(Missing)', DATA)).toThrow(ExpressionEvaluationError);
    });

    it('orderByParsesTheKeysWithTheirDirections', () => {
        const node = parseExpression('Entries:orderBy(Day, By desc)');

        expect(node.kind).toBe('Function');
        if (node.kind !== 'Function') return;
        expect(node.functionName).toBe('OrderBy');
        expect(functionArguments(node)).toEqual([Nodes.sortKey('Day', 'Asc'), Nodes.sortKey('By', 'Desc')]);
    });

    // Data, in the order of the list: c(Day 2, z), a(Day 2, y), b(Day 1, x), d(Day 3, w)
    it.each(cases(
        // order, page, then project the page
        'Entries:orderBy(Day, By desc):offset(1):limit(2).{Name, Day} => [{"Name":"c","Day":2},{"Name":"a","Day":2}]',
        'Entries:orderBy(Name):limit(2).{Name} => [{"Name":"a"},{"Name":"b"}]',
        // one item, then project it or read one property of it
        'Entries:orderBy(Name desc):first.{Name, Day} => {"Name":"d","Day":3}',
        'Entries:orderBy(Name):first.{Name} => {"Name":"a"}',
        'Entries:orderBy(Name):first.Name => "a"',
        // a filter before the order
        'Entries:where(Day > 1):orderBy(Name desc):limit(1) => [{"Name":"d","Day":3,"By":"w"}]',
        // a filter before the order, then the projection or a property of the item
        'Entries:where(Day > 1):orderBy(Name desc):first.{Name} => {"Name":"d"}',
        'Entries:where(Day > 1):orderBy(Name desc):first.{Name, Day} => {"Name":"d","Day":3}',
        'Entries:where(Day > 1):orderBy(Name):limit(2).{Name} => [{"Name":"a"},{"Name":"c"}]',
        'Entries:where(Day > 1):first.{Name} => {"Name":"c"}',
        'Entries:where(Day > 1):orderBy(Name desc):first.Name => "d"',
        // where can follow other functions, and a function or a second where can follow it
        'Entries:orderBy(Name):where(Day > 1).{Name} => [{"Name":"a"},{"Name":"c"},{"Name":"d"}]',
        'Entries:where(Day > 1):where(By != \'z\').{Name} => [{"Name":"a"},{"Name":"d"}]',
        'Entries:where(Day > 1, By != \'z\'):count => 2',
        'Entries:limit(3):where(Day > 1):count => 2',
        'Entries:where(Name startswith \'a\' || Name = \'d\'):orderBy(Name desc).{Name} => [{"Name":"d"},{"Name":"a"}]',
        'Entries:where(Day > 5):first => null',
        'Entries:where(Day > 5):count => 0',
        // aggregate or distinct values of a page
        'Entries:orderBy(Name):limit(2):count => 2',
        'Entries:orderBy(Name):limit(3):sum(Day) => 5',
        'Entries:orderBy(Name):offset(1):limit(2):distinct(By) => ["x","z"]',
    ))('functionsChainWithProjectionsAndAggregates(%s)', (expression, expected) => {
        expect(json(expression)).toEqual(canonicalJson(expected));
    });

    it.each([
        'Entries:where(Day > 1):orderBy(Name) garbage',
        'Entries:first )',
        'Entries:limit(2) Name',
        'Name }',
    ])('textThatIsLeftAfterTheExpressionIsAnError(%s)', expression => {
        expect(() => parseExpression(expression)).toThrow(ExpressionParseError);
    });
});
