/** Thrown when an expression cannot be evaluated on an object: a missing property, a value of the wrong kind... */
export class ExpressionEvaluationError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ExpressionEvaluationError';
    }
}
