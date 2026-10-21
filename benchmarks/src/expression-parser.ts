import { type ExpressionNode, parseExpression } from 'nfxmap/expressions';

/** Expressions from a property name to a projection over a filter, as in the benchmarks of jfxmap. */
export const EXPRESSIONS = {
    simple: 'Name',
    medium: "Country?.Name ?? 'Unknown'",
    complex: "Orders:where(Status = 'Done' && Total > 100):orderBy(Total desc):limit(10)"
        + '.{Id, Total, Customer.Name:upper as CustomerName, (Nickname ?? Name) as DisplayName}',
} as const;

export type Complexity = keyof typeof EXPRESSIONS;

/** Tokenizing and parsing an expression into its syntax tree. */
export function parse(complexity: Complexity): ExpressionNode {
    return parseExpression(EXPRESSIONS[complexity]);
}
