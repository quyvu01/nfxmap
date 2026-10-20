import {
    type DataResponse,
    type DistributedKeyLike,
    type ItemsResponse,
    keyName,
    type MapContext,
    type MapRequest,
    type RequestClient,
    type ValueResponse,
} from '../src/index.js';

export interface Sent {
    readonly key: string;
    readonly request: MapRequest;
    readonly context: MapContext;
}

/** Answers from a table of (key, id, expression) to JSON values, and records every request. */
export class FakeRequestClient implements RequestClient {
    private readonly values = new Map<string, Map<string, Map<string | null, string>>>();
    readonly sent: Sent[] = [];

    value(key: DistributedKeyLike, id: unknown, expression: string | null, json: string): this {
        const name = keyName(key);
        let byId = this.values.get(name);
        if (byId === undefined) this.values.set(name, (byId = new Map()));
        let row = byId.get(String(id));
        if (row === undefined) byId.set(String(id), (row = new Map()));
        row.set(expression, json);
        return this;
    }

    request(key: string, request: MapRequest, context: MapContext): Promise<ItemsResponse> {
        this.sent.push({ key, request, context });
        const byId = this.values.get(key) ?? new Map<string, Map<string | null, string>>();
        const items: DataResponse[] = [];
        for (const id of request.selectorIds) {
            const row = byId.get(id);
            if (row === undefined) continue;
            const answered: ValueResponse[] = [];
            for (const expression of request.expressions)
                if (row.has(expression)) answered.push({ expression, value: row.get(expression)! });
            items.push({ id, values: answered });
        }
        return Promise.resolve({ items, errors: [] });
    }
}
