import { fromJSON } from '@grpc/proto-loader';
import { DotNetKeyNames, type ItemsResponse } from 'nfxmap';
import { FXMAP_DESCRIPTOR } from './descriptor.js';

/** FxMap's gRPC contract (`fxMap.proto`, package `FxMapTransport`), loaded with the field names of the proto. */
export const FXMAP_PACKAGE_DEFINITION = fromJSON(FXMAP_DESCRIPTOR as unknown as Parameters<typeof fromJSON>[0], {
    keepCase: true,
    defaults: false,
});

/** The full name of the service. */
export const FXMAP_SERVICE_NAME = 'FxMapTransport.FxMapTransportService';

/** A `google.protobuf.StringValue`: absent stands for null. */
export interface StringValue {
    value?: string;
}

export interface GetFxMapGrpcQuery {
    selector_ids?: string[];
    expression?: StringValue | null;
    distributed_key_assembly_type?: StringValue | null;
}

export interface FxMapItemsGrpcResponse {
    items?: {
        id?: string;
        fxmap_values?: { expression?: StringValue | null; value?: StringValue | null }[];
    }[];
    errors?: { expression?: StringValue | null; message?: StringValue | null }[];
}

export interface DistributedKeyTypeResponse {
    distributed_key_types?: string[];
}

/**
 * The names of the keys on the gRPC wire, as FxMap 5.1.1 writes them: the assembly-qualified name of the key's type
 * (`UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null`).
 */
export const GrpcKeyNames = {
    toWire(key: string): string {
        return DotNetKeyNames.assemblyQualifiedName(key);
    },

    /** The key of a received name, or of a bare key name; `null` for a key declared with a .NET type. */
    fromWire(wireName: string | null | undefined): string | null {
        return DotNetKeyNames.fromAssemblyQualifiedName(wireName);
    },
} as const;

/**
 * The expressions of a request travel as one JSON array in the `expression` field, as FxMap's
 * `JsonSerializer.Serialize(string[])` writes them: `[null,"Email","Country.Name"]`.
 */
export const ExpressionsJson = {
    write(expressions: readonly (string | null)[]): string {
        return JSON.stringify(expressions);
    },

    /** @throws TypeError when the text is not a JSON array of strings */
    read(json: string | null | undefined): (string | null)[] {
        if (json === null || json === undefined || json.trim().length === 0) return [];
        let parsed: unknown;
        try {
            parsed = JSON.parse(json);
        } catch (error) {
            throw new TypeError(`The expressions are not a JSON array of strings: ${json}`, { cause: error });
        }
        if (parsed === null) return [];
        if (!Array.isArray(parsed) || parsed.some(e => e !== null && typeof e !== 'string'))
            throw new TypeError(`The expressions are not a JSON array of strings: ${json}`);
        return parsed as (string | null)[];
    },
} as const;

export function stringValue(value: string | null | undefined): StringValue | null {
    return value === null || value === undefined ? null : { value };
}

export function valueOf(wrapper: StringValue | null | undefined): string | null {
    return wrapper === null || wrapper === undefined ? null : wrapper.value ?? '';
}

export function toGrpcResponse(response: ItemsResponse): FxMapItemsGrpcResponse {
    return {
        items: response.items.map(item => ({
            id: item.id,
            fxmap_values: item.values.map(value => ({
                expression: stringValue(value.expression),
                value: stringValue(value.value),
            })),
        })),
        errors: response.errors.map(error => ({
            expression: stringValue(error.expression),
            message: stringValue(error.message),
        })),
    };
}

export function fromGrpcResponse(response: FxMapItemsGrpcResponse): ItemsResponse {
    return {
        items: (response.items ?? []).map(item => ({
            id: item.id ?? '',
            values: (item.fxmap_values ?? []).map(value => ({
                expression: valueOf(value.expression),
                value: valueOf(value.value),
            })),
        })),
        errors: (response.errors ?? []).map(error => ({
            expression: valueOf(error.expression),
            message: valueOf(error.message) ?? '',
        })),
    };
}
