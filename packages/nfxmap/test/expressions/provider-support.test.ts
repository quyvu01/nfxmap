import { describe, expect, it } from 'vitest';
import { ExpressionEvaluator } from '../../src/expressions/evaluator.js';
import { ExpressionEvaluationError } from '../../src/expressions/errors.js';
import { referencedNames } from '../../src/expressions/nodes.js';
import { parseExpression } from '../../src/expressions/parser.js';

describe('a navigation through null', () => {
    const user = { name: 'Bob', country: null, orders: [{ id: 1, product: null }] };

    it('fails by default, unless it is null-safe', () => {
        const evaluator = new ExpressionEvaluator();

        expect(() => evaluator.evaluate('Country.Name', user)).toThrow(ExpressionEvaluationError);
        expect(() => evaluator.evaluate('{Country.Name}', user)).toThrow(ExpressionEvaluationError);
        expect(evaluator.evaluate('Country?.Name', user)).toBeNull();
    });

    it('gives null as a left join does when asked to', () => {
        const evaluator = new ExpressionEvaluator({ nullNavigation: 'null' });

        expect(evaluator.evaluate('Country.Name', user)).toBeNull();
        expect(evaluator.evaluate('Country.Name:upper', user)).toBeNull();
        expect(evaluator.evaluate('{Country.Name as CountryName}', user)).toEqual({ CountryName: null });
        expect(evaluator.evaluate('Orders.{Id, Product.Title as Title}', user)).toEqual([{ Id: 1, Title: null }]);
        // A missing property still fails
        expect(() => evaluator.evaluate('Missing', user)).toThrow(ExpressionEvaluationError);
    });
});

describe('the names an expression references', () => {
    it('are its identifiers, path segments and string arguments', () => {
        expect(referencedNames(parseExpression("Orders:where(Status = 'Done'):orderBy(Total).{Id, Product.Code as Code}")))
            .toEqual(expect.arrayContaining(['Orders', 'Status', 'Done', 'Total', 'Id', 'Product', 'Code']));
        expect(referencedNames(parseExpression('Name:upper'))).toEqual(['Name']);
        expect(referencedNames(parseExpression("Orders:distinct('Status')"))).toEqual(['Orders', 'Status']);
    });
});
