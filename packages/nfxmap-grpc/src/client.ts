import {
    type ChannelCredentials,
    type Client,
    credentials as grpcCredentials,
    makeGenericClientConstructor,
    Metadata,
    type ServiceError,
    status,
} from '@grpc/grpc-js';
import {
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    NoHandlerForDistributedKeyError,
    ReceivedFaultError,
    type RequestClient,
    RequestTimedOutError,
} from 'nfxmap';
import {
    type DistributedKeyTypeResponse,
    ExpressionsJson,
    type FxMapItemsGrpcResponse,
    fromGrpcResponse,
    type GetFxMapGrpcQuery,
    GrpcKeyNames,
    stringValue,
} from './contract.js';
import { serviceDefinition } from './server.js';

/** FxMap's timeout of a gRPC call. */
export const DEFAULT_GRPC_TIMEOUT_MS = 3_000;

export interface GrpcRequestClientOptions {
    /** The hosts of the services that own keys (`http://host:port`, `https://host:port`, or `host:port`). */
    readonly hosts: readonly string[];
    /** How long a call may take, in milliseconds (default 3 seconds, as in FxMap). */
    readonly timeoutMs?: number;
    /** The credentials of a host; by default from its URL: TLS for `https://`, plaintext otherwise. */
    readonly credentials?: (host: string) => ChannelCredentials;
}

type Unary<Q, R> = (request: Q, metadata: Metadata, options: { deadline: Date },
                    callback: (error: ServiceError | null, response?: R) => void) => unknown;

interface FxMapClient extends Client {
    GetItems: Unary<GetFxMapGrpcQuery, FxMapItemsGrpcResponse>;
    GetDistributedKeys: Unary<Record<string, never>, DistributedKeyTypeResponse>;
}

/**
 * Sends requests over gRPC to the services that own the keys (FxMap's GrpcRequestClient and `AddGrpcClients`).
 *
 * It is given the hosts of those services. The first time a key is requested, it asks each host it has not reached yet
 * which keys it handles (`GetDistributedKeys`), and from then on sends the requests for that key to that host. A host
 * that cannot be reached is asked again on the next unknown key.
 *
 * ```ts
 * const client = new GrpcRequestClient({ hosts: ['http://user-service:9090', 'https://product-service:9443'] });
 * ```
 */
export class GrpcRequestClient implements RequestClient {
    readonly transport = 'grpc';
    readonly hosts: readonly string[];
    readonly timeoutMs: number;
    private readonly credentials: (host: string) => ChannelCredentials;
    private readonly clients = new Map<string, FxMapClient>();
    // The keys of each host that answered GetDistributedKeys
    private readonly keysByHost = new Map<string, Set<string>>();
    private probing: Promise<void> | null = null;

    constructor(options: GrpcRequestClientOptions) {
        const hosts = [...new Set((options?.hosts ?? []).map(host => {
            if (typeof host !== 'string' || host.trim().length === 0) throw new RangeError('A gRPC host is blank.');
            return host.trim();
        }))];
        if (hosts.length === 0) throw new RangeError('Give the gRPC client at least one host.');
        this.hosts = hosts;
        const timeoutMs = options.timeoutMs ?? DEFAULT_GRPC_TIMEOUT_MS;
        if (!(timeoutMs > 0)) throw new RangeError('The timeout must be positive.');
        this.timeoutMs = timeoutMs;
        this.credentials = options.credentials ?? defaultCredentials;
        for (const host of hosts) target(host);
    }

    async request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        const wireName = GrpcKeyNames.toWire(key);
        const host = await this.hostOf(key, wireName);
        const metadata = new Metadata();
        for (const [name, value] of Object.entries(context.headers)) {
            if (value === null || value === undefined || name.toLowerCase().endsWith('-bin')) continue;
            try {
                metadata.add(name, value);
            } catch {
                // Not a valid metadata name or value: it cannot travel
            }
        }
        const response = await call(this.client(host).GetItems.bind(this.client(host)), {
            selector_ids: [...request.selectorIds],
            expression: stringValue(ExpressionsJson.write(request.expressions)),
            distributed_key_assembly_type: stringValue(wireName),
        }, metadata, this.timeoutMs).catch(error => {
            throw translate(key, this.timeoutMs, error);
        });
        return fromGrpcResponse(response);
    }

    /** Closes the channels. */
    close(): void {
        for (const client of this.clients.values()) client.close();
        this.clients.clear();
    }

    private async hostOf(key: string, wireName: string): Promise<string> {
        let host = this.knownHostOf(wireName);
        if (host !== null) return host;
        // One lookup at a time: the requests for unknown keys wait for the same answers
        while (this.probing !== null) await this.probing;
        host = this.knownHostOf(wireName);
        if (host !== null) return host;
        const failures: unknown[] = [];
        this.probing = Promise.all(this.hosts.filter(candidate => !this.keysByHost.has(candidate)).map(async candidate => {
            try {
                const response = await call(this.client(candidate).GetDistributedKeys.bind(this.client(candidate)), {},
                    new Metadata(), this.timeoutMs);
                this.keysByHost.set(candidate, new Set(response.distributed_key_types ?? []));
            } catch (error) {
                failures.push(error);
                // A new channel next time: the host is asked at once, not after the reconnect backoff of this one
                this.clients.get(candidate)?.close();
                this.clients.delete(candidate);
            }
        })).then(() => undefined);
        try {
            await this.probing;
        } finally {
            this.probing = null;
        }
        host = this.knownHostOf(wireName);
        if (host !== null) return host;
        throw Object.assign(new NoHandlerForDistributedKeyError(key),
            failures.length > 0 ? { cause: new AggregateError(failures, 'Some gRPC hosts did not tell their keys.') } : {});
    }

    private knownHostOf(wireName: string): string | null {
        for (const host of this.hosts) if (this.keysByHost.get(host)?.has(wireName)) return host;
        return null;
    }

    private client(host: string): FxMapClient {
        let client = this.clients.get(host);
        if (client === undefined) {
            const Constructor = makeGenericClientConstructor(serviceDefinition(), 'FxMapTransportService');
            client = new Constructor(target(host), this.credentials(host)) as unknown as FxMapClient;
            this.clients.set(host, client);
        }
        return client;
    }
}

function call<Q, R>(method: Unary<Q, R>, request: Q, metadata: Metadata, timeoutMs: number): Promise<R> {
    return new Promise((resolve, reject) => {
        method(request, metadata, { deadline: new Date(Date.now() + timeoutMs) }, (error, response) => {
            if (error) reject(error);
            else resolve(response as R);
        });
    });
}

function translate(key: string, timeoutMs: number, error: unknown): unknown {
    const grpc = error as Partial<ServiceError>;
    if (typeof grpc?.code !== 'number') return error;
    if (grpc.code === status.DEADLINE_EXCEEDED) return new RequestTimedOutError(key, timeoutMs);
    // The owner failed or refused the request: what it said comes back as a fault
    return new ReceivedFaultError(null, [{
        exceptionType: `gRPC ${status[grpc.code] ?? grpc.code}`,
        message: grpc.details || null,
        stackTrace: null,
    }]);
}

/** The address of a host: `host:port`. */
function target(host: string): string {
    if (!host.includes('://')) return host;
    let url: URL;
    try {
        url = new URL(host);
    } catch {
        throw new RangeError(`The gRPC host must be http://, https:// or host:port: ${host}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new RangeError(`The gRPC host must be http://, https:// or host:port: ${host}`);
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
}

function defaultCredentials(host: string): ChannelCredentials {
    return host.toLowerCase().startsWith('https://') ? grpcCredentials.createSsl() : grpcCredentials.createInsecure();
}
