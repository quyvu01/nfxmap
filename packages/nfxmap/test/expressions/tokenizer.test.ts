import { describe, expect, it } from 'vitest';
import { ExpressionTokenizeError, type TokenType, tokenize } from '../../src/expressions/tokenizer.js';

const types = (expression: string): TokenType[] => tokenize(expression).map(t => t.type);

describe('tokenize', () => {
    it('ends with EndOfExpression, also for an empty expression', () => {
        expect(tokenize('')).toEqual([{ type: 'EndOfExpression', value: '', position: 0 }]);
        expect(tokenize('   ')).toEqual([{ type: 'EndOfExpression', value: '', position: 3 }]);
    });

    it('scans the punctuation and the brackets', () => {
        expect(types('. : , ? ?? ( ) [ ] { }')).toEqual([
            'Dot', 'Colon', 'Comma', 'Question', 'QuestionQuestion',
            'OpenParen', 'CloseParen', 'OpenBracket', 'CloseBracket', 'OpenBrace', 'CloseBrace',
            'EndOfExpression',
        ]);
    });

    it('scans the operators, the longest first', () => {
        expect(types('= != > >= < <= ! && ||')).toEqual([
            'Equal', 'NotEqual', 'GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Not', 'And', 'Or',
            'EndOfExpression',
        ]);
        expect(tokenize('A>=1').map(t => t.value)).toEqual(['A', '>=', '1', '']);
    });

    it('keeps the position of each token', () => {
        expect(tokenize("Name = 'x'").map(t => t.position)).toEqual([0, 5, 7, 10]);
    });

    it('scans the keywords case-insensitively and keeps their text', () => {
        expect(types('true FALSE Null AND or Not ASC desc As CONTAINS startsWith EndsWith')).toEqual([
            'Boolean', 'Boolean', 'Null', 'And', 'Or', 'Not', 'Asc', 'Desc', 'As', 'Contains', 'StartsWith', 'EndsWith',
            'EndOfExpression',
        ]);
        expect(tokenize('FALSE')[0].value).toBe('FALSE');
    });

    it('scans identifiers with digits, underscores and letters of any language', () => {
        const tokens = tokenize('_id Name2 Tên android');
        expect(tokens.map(t => t.type)).toEqual(['Identifier', 'Identifier', 'Identifier', 'Identifier', 'EndOfExpression']);
        expect(tokens.map(t => t.value)).toEqual(['_id', 'Name2', 'Tên', 'android', '']);
    });

    it('scans strings with either quote and unescapes them', () => {
        expect(tokenize("'Done'")[0]).toEqual({ type: 'String', value: 'Done', position: 0 });
        expect(tokenize('"Done"')[0].value).toBe('Done');
        expect(tokenize("'it\\'s'")[0].value).toBe("it's");
        expect(tokenize('"say \\"hi\\""')[0].value).toBe('say "hi"');
        expect(tokenize("'a\\nb\\tc\\rd'")[0].value).toBe('a\nb\tc\rd');
        expect(tokenize("'back\\\\slash'")[0].value).toBe('back\\slash');
        expect(tokenize("'\\x'")[0].value).toBe('x');
        // The other quote is a plain character
        expect(tokenize(`'say "hi"'`)[0].value).toBe('say "hi"');
    });

    it('scans numbers: integers, decimals, negatives', () => {
        expect(tokenize('123 1.15 -10 -0.5').filter(t => t.type === 'Number').map(t => t.value))
            .toEqual(['123', '1.15', '-10', '-0.5']);
    });

    it('stops a number at a dot that is a navigation: 123.Name', () => {
        const tokens = tokenize('123.Name');
        expect(tokens.map(t => t.type)).toEqual(['Number', 'Dot', 'Identifier', 'EndOfExpression']);
        expect(tokens[0].value).toBe('123');
    });

    it('throws on an unterminated string', () => {
        expect(() => tokenize("Name = 'Done")).toThrow(ExpressionTokenizeError);
        expect(() => tokenize("Name = 'Done")).toThrow('Unterminated string starting at position 7');
    });

    it('throws on an unexpected character', () => {
        expect(() => tokenize('Price * 2')).toThrow(ExpressionTokenizeError);
        expect(() => tokenize('Price * 2')).toThrow("Unexpected character '*' at position 6");
    });

    it('throws on a single & or |', () => {
        expect(() => tokenize('A = 1 & B = 2')).toThrow(ExpressionTokenizeError);
        expect(() => tokenize('A = 1 & B = 2')).toThrow("Expected '&&' at position 6");
        expect(() => tokenize('A = 1 | B = 2')).toThrow("Expected '||' at position 6");
    });
});
