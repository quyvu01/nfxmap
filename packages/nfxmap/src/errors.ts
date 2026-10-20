import type { ExpressionError } from './responses.js';

/** The base of every error thrown by nfxmap's mapping. Each failure has its own subclass. */
export class DistributedMapError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = new.target.name;
    }
}

export class DistributedKeyNullOrEmptyError extends DistributedMapError {
    constructor() {
        super('The distributed key must not be null or empty.');
    }
}

export class InvalidDistributedKeyNameError extends DistributedMapError {
    constructor(readonly key: string) {
        super(`The distributed key '${key}' is not valid: it must start with a letter or an underscore and contain `
            + 'only letters, digits, underscores and dots.');
    }
}

export class InvalidDistributedKeyConfigurationError extends DistributedMapError {
    constructor(configName: string) {
        super(`${configName} must call useDistributedKey(...) exactly once.`);
    }
}

export class EntityIdNotConfiguredError extends DistributedMapError {
    constructor(entityName: string) {
        super(`The entity ${entityName} has no id: call id(...) in configure().`);
    }
}

export class InvalidEntitySelectorError extends DistributedMapError {
    constructor(entityName: string, selectorName: string, reason: string) {
        super(`The ${selectorName} selector of ${entityName} is not valid: ${reason}`);
    }
}

export class InvalidProfileSelectorError extends DistributedMapError {
    constructor(modelName: string, reason: string) {
        super(`A selector of the profile of ${modelName} is not valid: ${reason}`);
    }
}

export class DuplicatedNameByExposedNameError extends DistributedMapError {
    constructor(entityName: string, exposedName: string) {
        super(`The exposed name '${exposedName}' is used more than once on ${entityName}.`);
    }
}

export class AmbiguousProfileConfigurationError extends DistributedMapError {
    constructor(modelName: string) {
        super(`More than one profile is registered for ${modelName}.`);
    }
}

export class DistributedKeyAssignedToMultipleEntitiesError extends DistributedMapError {
    constructor(readonly key: string, entityNames: readonly string[]) {
        super(`The distributed key ${key} is assigned to several entities: ${entityNames.join(', ')}.`);
    }
}

export class MaxNestingDepthReachedError extends DistributedMapError {
    constructor(readonly maxNestingDepth: number) {
        super(`The maximum nesting depth (${maxNestingDepth}) was reached while mapping.`);
    }
}

export class NoRequestClientError extends DistributedMapError {
    constructor() {
        super('No request client is configured: give one to createDistributedMapper({ requestClient }).');
    }
}

export class NoHandlerForDistributedKeyError extends DistributedMapError {
    constructor(readonly key: string) {
        super(`No handler is registered for the distributed key ${key}.`);
    }
}

export class NoProfileError extends DistributedMapError {
    constructor(readonly model: string) {
        super(`No profile is registered for ${model}.`);
    }
}

/** The owner of a key could not evaluate some expressions. */
export class ExpressionsFailedError extends DistributedMapError {
    constructor(readonly key: string, readonly errors: readonly ExpressionError[]) {
        super(`The owner of the distributed key ${key} could not evaluate: `
            + errors.map(e => `'${e.expression}' (${e.message})`).join(', '));
    }
}

export class ValueWriteFailedError extends DistributedMapError {
    constructor(modelName: string, property: string, cause: unknown) {
        super(`The value of ${modelName}.${property} could not be written: ${messageOf(cause)}`, { cause });
    }
}

/** One exception of a fault. */
export interface ExceptionInfo {
    /** The full name of its type, on the owner. */
    readonly exceptionType: string | null;
    readonly message: string | null;
    readonly stackTrace: string | null;
}

/** The owner of a key answered with a failure (a `Fault` of FxMap). */
export class ReceivedFaultError extends DistributedMapError {
    constructor(readonly faultId: string | null, readonly exceptions: readonly ExceptionInfo[]) {
        super(exceptions.length === 0
            ? 'The owner of the distributed key failed.'
            : `The owner of the distributed key failed: ${exceptions[0].exceptionType}: ${exceptions[0].message}`);
    }
}

/** A request was sent, but its reply did not come in time. */
export class RequestTimedOutError extends DistributedMapError {
    constructor(readonly key: string, readonly timeoutMs: number) {
        super(`No reply for the distributed key ${key} came within ${timeoutMs} ms.`);
    }
}

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
