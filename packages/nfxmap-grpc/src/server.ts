import {
    loadPackageDefinition,
    type Metadata,
    type sendUnaryData,
    type Server,
    type ServerUnaryCall,
    type ServiceDefinition,
    status,
    type UntypedServiceImplementation,
} from '@grpc/grpc-js';
import { DistributedKeyAssignedToMultipleEntitiesError, type ErrorLogger, MapContext, type QueryHandler } from 'nfxmap';
import {
    type DistributedKeyTypeResponse,
    ExpressionsJson,
    FXMAP_PACKAGE_DEFINITION,
    type FxMapItemsGrpcResponse,
    type GetFxMapGrpcQuery,
    GrpcKeyNames,
    toGrpcResponse,
    valueOf,
} from './contract.js';

export interface FxMapGrpcServiceOptions {
    /** Where the failed requests are logged; the console by default. */
    readonly logger?: ErrorLogger;
}

/**
 * The gRPC server side (FxMap's GrpcServer): answers `GetItems` with the {@link QueryHandler} of the requested key,
 * and `GetDistributedKeys` with the keys it handles, so that the clients find which host owns a key. The metadata of a
 * call reaches the handlers as headers.
 *
 * Add it to any gRPC server:
 *
 * ```ts
 * const server = new Server();
 * new FxMapGrpcService([new InMemoryQueryHandler(new UserConfig(), users)]).addTo(server);
 * server.bindAsync('0.0.0.0:9090', ServerCredentials.createInsecure(), () => undefined);
 * ```
 */
export class FxMapGrpcService {
    /** The definition of `FxMapTransport.FxMapTransportService`, for `server.addService`. */
    readonly definition: ServiceDefinition;
    /** The methods of the service, for `server.addService`. */
    readonly implementation: UntypedServiceImplementation;
    private readonly handlers = new Map<string, QueryHandler>();
    private readonly logger: ErrorLogger;

    /** @throws DistributedKeyAssignedToMultipleEntitiesError when two handlers share a key */
    constructor(handlers: Iterable<QueryHandler>, options: FxMapGrpcServiceOptions = {}) {
        for (const handler of handlers) {
            const existing = this.handlers.get(handler.key);
            if (existing !== undefined)
                throw new DistributedKeyAssignedToMultipleEntitiesError(handler.key, [existing.entityName, handler.entityName]);
            this.handlers.set(handler.key, handler);
        }
        this.logger = options.logger ?? console;
        this.definition = serviceDefinition();
        this.implementation = {
            GetItems: (call: ServerUnaryCall<GetFxMapGrpcQuery, FxMapItemsGrpcResponse>,
                       callback: sendUnaryData<FxMapItemsGrpcResponse>) => {
                void this.getItems(call.request, call.metadata).then(
                    response => callback(null, response),
                    (error: GrpcError) => callback(error));
            },
            GetDistributedKeys: (_: ServerUnaryCall<unknown, DistributedKeyTypeResponse>,
                                 callback: sendUnaryData<DistributedKeyTypeResponse>) => {
                callback(null, { distributed_key_types: this.keys.map(GrpcKeyNames.toWire).sort() });
            },
        };
    }

    /** The keys this service answers for. */
    get keys(): string[] {
        return [...this.handlers.keys()];
    }

    /** Adds the service to a gRPC server. */
    addTo(server: Server): void {
        server.addService(this.definition, this.implementation);
    }

    private async getItems(request: GetFxMapGrpcQuery, metadata: Metadata): Promise<FxMapItemsGrpcResponse> {
        const wireName = valueOf(request.distributed_key_assembly_type);
        const key = GrpcKeyNames.fromWire(wireName);
        const handler = key === null ? undefined : this.handlers.get(key);
        if (handler === undefined)
            throw grpcError(status.NOT_FOUND, `The FxMap distributed key seems not a part of this application: ${wireName}`);
        let expressions: (string | null)[];
        try {
            expressions = ExpressionsJson.read(valueOf(request.expression));
        } catch (error) {
            throw grpcError(status.INVALID_ARGUMENT, (error as Error).message);
        }
        try {
            const response = await handler.handle({ selectorIds: request.selector_ids ?? [], expressions },
                new MapContext(grpcHeaders(metadata)));
            return toGrpcResponse(response);
        } catch (error) {
            this.logger.error(`The request for the distributed key ${handler.key} failed.`, error);
            throw grpcError(status.INTERNAL, error instanceof Error ? error.message : String(error));
        }
    }
}

/** The text metadata of a call as headers; the first value of a repeated name wins, binary ones are left out. */
export function grpcHeaders(metadata: Metadata): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(metadata.getMap()))
        if (typeof value === 'string' && !name.endsWith('-bin')) headers[name] = value;
    return headers;
}

type GrpcError = Error & { code: number; details: string };

function grpcError(code: number, details: string): GrpcError {
    return Object.assign(new Error(details), { code, details });
}

let definition: ServiceDefinition | undefined;

export function serviceDefinition(): ServiceDefinition {
    if (definition === undefined) {
        const loaded = loadPackageDefinition(FXMAP_PACKAGE_DEFINITION) as unknown as {
            FxMapTransport: { FxMapTransportService: { service: ServiceDefinition } };
        };
        definition = loaded.FxMapTransport.FxMapTransportService.service;
    }
    return definition;
}
