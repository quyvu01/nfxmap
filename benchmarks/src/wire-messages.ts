import { type ItemsResponse, type MapRequest, WireMessages } from 'nfxmap';

export const EXPRESSIONS = [null, 'UserEmail', 'Country.Name', "Orders:where(Status = 'Done'):sum(Total)"];

/** A request for a batch of ids and its reply, in objects and in the JSON that travels on every transport. */
export interface WireData {
    readonly request: MapRequest;
    readonly response: ItemsResponse;
    readonly requestJson: Buffer;
    readonly responseJson: Buffer;
}

/** The request of that many ids, and its reply with as many items. */
export function wireData(ids: number): WireData {
    const selectorIds = Array.from({ length: ids }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const request: MapRequest = { selectorIds, expressions: EXPRESSIONS };
    const response: ItemsResponse = {
        items: selectorIds.map(id => ({
            id,
            values: [
                { expression: null, value: `"User ${id}"` },
                { expression: 'UserEmail', value: `"user${id}@example.com"` },
                { expression: 'Country.Name', value: '"Vietnam"' },
                { expression: "Orders:where(Status = 'Done'):sum(Total)", value: '1234.5' },
            ],
        })),
        errors: [],
    };
    return {
        request,
        response,
        requestJson: WireMessages.writeRequest(request),
        responseJson: WireMessages.writeSuccess(response),
    };
}
