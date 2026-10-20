/** The type of a token of the FxMap expression language. */
export type TokenType =
    // Literals
    | 'Identifier' | 'String' | 'Number' | 'Boolean' | 'Null'
    // Comparison operators
    | 'Equal' | 'NotEqual' | 'GreaterThan' | 'LessThan' | 'GreaterThanOrEqual' | 'LessThanOrEqual'
    // String operators
    | 'Contains' | 'StartsWith' | 'EndsWith'
    // Logical operators
    | 'And' | 'Or' | 'Not'
    // Punctuation
    | 'Dot' | 'Colon' | 'Comma' | 'Question' | 'QuestionQuestion'
    // Brackets
    | 'OpenParen' | 'CloseParen' | 'OpenBracket' | 'CloseBracket' | 'OpenBrace' | 'CloseBrace'
    // Order direction, alias
    | 'Asc' | 'Desc' | 'As'
    | 'EndOfExpression';

/** A token: its type, its text (the unescaped content for a string) and its position in the expression. */
export interface Token {
    readonly type: TokenType;
    readonly value: string;
    readonly position: number;
}

/** Thrown when an expression has a character that is not part of the language. */
export class ExpressionTokenizeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExpressionTokenizeError';
    }
}

// Keywords are case-insensitive
const KEYWORDS: ReadonlyMap<string, TokenType> = new Map<string, TokenType>([
    ['true', 'Boolean'],
    ['false', 'Boolean'],
    ['null', 'Null'],
    ['and', 'And'],
    ['or', 'Or'],
    ['not', 'Not'],
    ['asc', 'Asc'],
    ['desc', 'Desc'],
    ['as', 'As'],
    ['contains', 'Contains'],
    ['startswith', 'StartsWith'],
    ['endswith', 'EndsWith'],
]);

const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const WHITESPACE = /\s/;

/** Splits an expression into tokens; the last one is always `EndOfExpression`. */
export function tokenize(expression: string): Token[] {
    if (typeof expression !== 'string') throw new TypeError('The expression must be a string.');
    const tokens: Token[] = [];
    let position = 0;

    const isAtEnd = () => position >= expression.length;
    const peek = () => (isAtEnd() ? '\0' : expression[position]);
    const advance = () => expression[position++];
    const match = (expected: string) => {
        if (isAtEnd() || expression[position] !== expected) return false;
        position++;
        return true;
    };
    const token = (type: TokenType, value: string, start: number): Token => ({ type, value, position: start });

    const scanString = (quote: string, start: number): Token => {
        let text = '';
        while (!isAtEnd() && peek() !== quote) {
            if (peek() === '\\' && position + 1 < expression.length) {
                advance(); // the backslash
                const escaped = advance();
                switch (escaped) {
                    case 'n': text += '\n'; break;
                    case 'r': text += '\r'; break;
                    case 't': text += '\t'; break;
                    default: text += escaped; break; // \\, \', \" and any other character as it is
                }
            } else {
                text += advance();
            }
        }
        if (isAtEnd()) throw new ExpressionTokenizeError(`Unterminated string starting at position ${start}`);
        advance(); // the closing quote
        return token('String', text, start);
    };

    const isDigit = (c: string) => c >= '0' && c <= '9';

    const scanNumber = (first: string, start: number): Token => {
        let text = first;
        while (!isAtEnd() && (isDigit(peek()) || peek() === '.')) {
            // A '.' followed by something else than a digit is a navigation: "123.Name"
            if (peek() === '.' && position + 1 < expression.length && !isDigit(expression[position + 1])) break;
            text += advance();
        }
        return token('Number', text, start);
    };

    const scanIdentifier = (first: string, start: number): Token => {
        let text = first;
        while (!isAtEnd() && (LETTER_OR_DIGIT.test(peek()) || peek() === '_')) text += advance();
        return token(KEYWORDS.get(text.toLowerCase()) ?? 'Identifier', text, start);
    };

    const scanToken = (): Token => {
        const start = position;
        const c = advance();
        switch (c) {
            case '.': return token('Dot', '.', start);
            case ':': return token('Colon', ':', start);
            case ',': return token('Comma', ',', start);
            case '?': return match('?') ? token('QuestionQuestion', '??', start) : token('Question', '?', start);
            case '(': return token('OpenParen', '(', start);
            case ')': return token('CloseParen', ')', start);
            case '[': return token('OpenBracket', '[', start);
            case ']': return token('CloseBracket', ']', start);
            case '{': return token('OpenBrace', '{', start);
            case '}': return token('CloseBrace', '}', start);
            case '=': return token('Equal', '=', start);
            case '!': return match('=') ? token('NotEqual', '!=', start) : token('Not', '!', start);
            case '>': return match('=') ? token('GreaterThanOrEqual', '>=', start) : token('GreaterThan', '>', start);
            case '<': return match('=') ? token('LessThanOrEqual', '<=', start) : token('LessThan', '<', start);
            case '&':
                if (match('&')) return token('And', '&&', start);
                throw new ExpressionTokenizeError(`Expected '&&' at position ${start}`);
            case '|':
                if (match('|')) return token('Or', '||', start);
                throw new ExpressionTokenizeError(`Expected '||' at position ${start}`);
            case '\'':
            case '"':
                return scanString(c, start);
            default:
                if (c === '-' || isDigit(c)) return scanNumber(c, start);
                if (LETTER.test(c) || c === '_') return scanIdentifier(c, start);
                throw new ExpressionTokenizeError(`Unexpected character '${c}' at position ${start}`);
        }
    };

    while (!isAtEnd()) {
        while (!isAtEnd() && WHITESPACE.test(peek())) position++;
        if (isAtEnd()) break;
        tokens.push(scanToken());
    }
    tokens.push(token('EndOfExpression', '', position));
    return tokens;
}
