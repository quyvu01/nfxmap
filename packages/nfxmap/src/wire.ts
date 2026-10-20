import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Headers } from './context.js';
import { MapContext } from './context.js';
import {
    DistributedKeyAssignedToMultipleEntitiesError,
    type ExceptionInfo,
    NoHandlerForDistributedKeyError,
    ReceivedFaultError,
} from './errors.js';
import type { DataResponse, ExpressionError, ItemsResponse, MapRequest, ValueResponse } from './responses.js';
import type { QueryHandler } from './transport.js';

/**
 * The names that FxMap 5.1.1 (.NET) derives from a distributed key, which the transports put on the wire (topics,
 * subjects, exchanges, the type of a message).
 *
 * FxMap turns a string key (`UseDistributedKey("UserOf")`) into a type generated at runtime in the assembly
 * `FxMap.DynamicDistributedKeys`, named after the key: its namespace is what comes before the last dot (`""` for
 * `UserOf`) and its name what follows it. nfxmap reads every key the same way, so a Node service and a .NET or Java
 * service that use the same string key find each other.
 */
export const DotNetKeyNames = {
    /** What follows the key name in the assembly-qualified name of a .NET string key. */
    DYNAMIC_ASSEMBLY: 'FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null',

    /** The full name of the key's type (`Type.FullName`): the key itself. */
    fullName(key: string): string {
        return key;
    },

    /** The namespace of the key's type (`Type.Namespace`), or `""` when it has none. */
    namespace(key: string): string {
        const dot = key.lastIndexOf('.');
        return dot < 0 ? '' : key.slice(0, dot);
    },

    /** The simple name of the key's type (`Type.Name`). */
    name(key: string): string {
        return key.slice(key.lastIndexOf('.') + 1);
    },

    /** `UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null` */
    assemblyQualifiedName(key: string): string {
        return `${key}, ${DotNetKeyNames.DYNAMIC_ASSEMBLY}`;
    },

    /**
     * The key of a received assembly-qualified name, or of a bare key name; `null` for a name from another .NET
     * assembly (a key declared with a .NET type), which no Node key matches.
     */
    fromAssemblyQualifiedName(assemblyQualifiedName: string | null | undefined): string | null {
        if (assemblyQualifiedName === null || assemblyQualifiedName === undefined) return null;
        let name = assemblyQualifiedName.trim();
        const suffix = `, ${DotNetKeyNames.DYNAMIC_ASSEMBLY}`;
        if (name.endsWith(suffix)) name = name.slice(0, name.length - suffix.length).trim();
        if (name.length === 0 || name.includes(',')) return null;
        return name;
    },
} as const;

/** The bytes or the text of a JSON message. */
export type WireData = Uint8Array | string;

const MAX_EXCEPTION_DEPTH = 16;

/**
 * The JSON messages of the message transports (NATS, RabbitMQ, Kafka...), as FxMap 5.1.1 writes them with
 * System.Text.Json, in PascalCase:
 * - a request (`DistributedMapRequest`): `{"SelectorIds":["1"],"Expressions":[null,"Email"]}`;
 * - a reply (`Result`): `{"IsSuccess":true,"Data":{"Items":[{"Id":"1","Values":[{"Expression":null,"Value":"\"Ann\""}]}],
 *   "Errors":[]},"Fault":null}`, or `IsSuccess` false with a `Fault` that lists the exceptions, outermost first.
 *
 * Names are read without case, and missing or null members are read as empty, as .NET may leave nulls out.
 */
export const WireMessages = {
    /** The JSON object of a request. */
    requestObject(request: MapRequest): Record<string, unknown> {
        return { SelectorIds: [...request.selectorIds], Expressions: [...request.expressions] };
    },

    writeRequest(request: MapRequest): Buffer {
        return Buffer.from(JSON.stringify(WireMessages.requestObject(request)));
    },

    /** @throws TypeError when the data is not a JSON request */
    readRequest(data: WireData | Record<string, unknown>): MapRequest {
        const node = isData(data) ? read(data) : data;
        if (!isObject(node)) throw new TypeError('The request is not a JSON object.');
        return { selectorIds: strings(member(node, 'SelectorIds')) as string[], expressions: strings(member(node, 'Expressions')) };
    },

    /** The reply of a request that was answered. */
    writeSuccess(response: ItemsResponse): Buffer {
        return Buffer.from(JSON.stringify({ IsSuccess: true, Data: WireMessages.itemsObject(response), Fault: null }));
    },

    /** The reply of a request that failed: a `Fault` with the error and its causes. */
    writeFailure(failure: unknown): Buffer {
        return Buffer.from(JSON.stringify({ IsSuccess: false, Data: null, Fault: WireMessages.faultObject(failure) }));
    },

    /**
     * The answer of a reply.
     *
     * @throws ReceivedFaultError when the owner failed
     * @throws TypeError when the data is not a reply
     */
    readResult(data: WireData): ItemsResponse {
        const node = read(data);
        if (!isObject(node)) throw new TypeError('The reply is not a JSON object.');
        if (member(node, 'IsSuccess') !== true) throw WireMessages.fault(member(node, 'Fault'));
        return WireMessages.items(member(node, 'Data'));
    },

    itemsObject(response: ItemsResponse): Record<string, unknown> {
        return {
            Items: response.items.map(item => ({
                Id: item.id,
                Values: item.values.map(value => ({ Expression: value.expression, Value: value.value })),
            })),
            Errors: response.errors.map(error => ({ Expression: error.expression, Message: error.message })),
        };
    },

    items(node: unknown): ItemsResponse {
        const items: DataResponse[] = elements(member(node, 'Items')).map(item => ({
            id: text(member(item, 'Id')) as string,
            values: elements(member(item, 'Values')).map((value): ValueResponse => ({
                expression: text(member(value, 'Expression')),
                value: text(member(value, 'Value')),
            })),
        }));
        const errors: ExpressionError[] = elements(member(node, 'Errors')).map(error => ({
            expression: text(member(error, 'Expression')),
            message: text(member(error, 'Message')) ?? '',
        }));
        return { items, errors };
    },

    faultObject(failure: unknown): Record<string, unknown> {
        const exceptions: Record<string, unknown>[] = [];
        let current: unknown = failure;
        for (let depth = 0; current !== null && current !== undefined && depth < MAX_EXCEPTION_DEPTH; depth++) {
            const error = current instanceof Error ? current : null;
            exceptions.push({
                ExceptionType: error?.name ?? typeof current,
                Message: error?.message || (error?.name ?? String(current)),
                StackTrace: error?.stack?.split('\n').slice(1).join('\n') ?? null,
                Source: null,
            });
            current = error?.cause;
        }
        return {
            FaultId: randomUUID(),
            FaultedMessageId: null,
            Timestamp: new Date().toISOString(),
            Exceptions: exceptions,
            Host: { MachineName: hostname(), ProcessName: 'node', ProcessId: process.pid, Assembly: 'nfxmap' },
        };
    },

    fault(node: unknown): ReceivedFaultError {
        const exceptions = elements(member(node, 'Exceptions')).map((exception): ExceptionInfo => ({
            exceptionType: text(member(exception, 'ExceptionType')),
            message: text(member(exception, 'Message')),
            stackTrace: text(member(exception, 'StackTrace')),
        }));
        return new ReceivedFaultError(text(member(node, 'FaultId')), exceptions);
    },
} as const;

/** FxMap's `DefaultRequestTimeout`, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Where the responder logs the requests that failed. */
export interface ErrorLogger {
    error(message: string, error?: unknown): void;
}

/**
 * The server side shared by the message transports: answers a received request with the {@link QueryHandler} of its
 * key, and always gives the bytes of a reply, a `Result` of FxMap: the answer, or the failure (an unknown key, a
 * request that is not JSON, a handler that failed or did not answer within the timeout).
 */
export class WireResponder {
    private readonly handlers = new Map<string, QueryHandler>();

    /**
     * @param handlers the handlers of the keys this service owns
     * @param timeoutMs how long a handler may take before the request fails
     * @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key
     */
    constructor(handlers: Iterable<QueryHandler>, private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
                private readonly logger: ErrorLogger = console) {
        for (const handler of handlers) {
            const existing = this.handlers.get(handler.key);
            if (existing !== undefined)
                throw new DistributedKeyAssignedToMultipleEntitiesError(handler.key, [existing.entityName, handler.entityName]);
            this.handlers.set(handler.key, handler);
        }
        if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
    }

    /** The keys this service answers for. */
    get keys(): string[] {
        return [...this.handlers.keys()];
    }

    /** The reply to a request, given as JSON (`{"SelectorIds":[...],"Expressions":[...]}`) or parsed. */
    async answer(key: string | null, request: WireData | MapRequest, headers: Headers = {}): Promise<Buffer> {
        let parsed: MapRequest;
        try {
            parsed = isData(request) ? WireMessages.readRequest(request) : request;
        } catch (error) {
            return this.failure(key, error);
        }

        const handler = key === null ? undefined : this.handlers.get(key);
        if (handler === undefined)
            return this.failure(key, key === null
                ? new TypeError('The request names no distributed key.')
                : new NoHandlerForDistributedKeyError(key));

        let timer: NodeJS.Timeout | undefined;
        try {
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new TimeoutError(`Request timeout for ${key} after ${this.timeoutMs} ms`)),
                    this.timeoutMs);
            });
            const response = await Promise.race([handler.handle(parsed, new MapContext(headers)), timeout]);
            return WireMessages.writeSuccess(response);
        } catch (error) {
            return this.failure(key, error);
        } finally {
            clearTimeout(timer);
        }
    }

    private failure(key: string | null, error: unknown): Buffer {
        this.logger.error(`The request for the distributed key ${key} failed.`, error);
        return WireMessages.writeFailure(error);
    }
}

/** A handler did not answer in time. */
export class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TimeoutException';
    }
}

function isData(value: unknown): value is WireData {
    return typeof value === 'string' || value instanceof Uint8Array;
}

/** @throws TypeError when the data is not JSON */
function read(data: WireData): unknown {
    const json = typeof data === 'string' ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    if (json.length === 0) throw new TypeError('The message is empty.');
    try {
        return JSON.parse(json);
    } catch (error) {
        throw new TypeError(`The message is not JSON: ${(error as Error).message}`, { cause: error });
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The member of an object, matched without case; `undefined` when there is none. */
function member(node: unknown, name: string): unknown {
    if (!isObject(node)) return undefined;
    if (Object.prototype.hasOwnProperty.call(node, name)) return node[name];
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(node)) if (key.toLowerCase() === lower) return value;
    return undefined;
}

function elements(node: unknown): unknown[] {
    return Array.isArray(node) ? node : [];
}

function strings(node: unknown): (string | null)[] {
    if (node === null || node === undefined) return [];
    if (!Array.isArray(node)) throw new TypeError(`Expected a JSON array of strings: ${JSON.stringify(node)}`);
    return node.map(text);
}

function text(node: unknown): string | null {
    if (node === null || node === undefined) return null;
    return typeof node === 'string' ? node : typeof node === 'object' ? JSON.stringify(node) : String(node);
}
