import { beforeEach, describe, expect, it } from 'vitest';
import {
    type ItemsResponse,
    MapContext,
    type MapRequest,
    type QueryHandler,
    type ReceiveBehavior,
    receivePipeline,
    type RequestClient,
    RequestContext,
    type SendBehavior,
    sendPipeline,
} from '../../src/index.js';

const USER = 'UserOf';
const REQUEST: MapRequest = { selectorIds: ['1'], expressions: ['Name'] };
const ANSWER: ItemsResponse = { items: [{ id: '1', values: [] }], errors: [] };

function context(): MapContext {
    return new MapContext({ 'x-caller': 'orders' });
}

/** JS: Java's Pipelines.send and Pipelines.receive are sendPipeline and receivePipeline. */
describe('Pipelines', () => {
    let calls: string[];
    let seen: MapContext | null;
    let client: RequestClient;
    let handler: QueryHandler;

    beforeEach(() => {
        calls = [];
        seen = null;
        client = {
            transport: 'nats',
            request: async (key, request, ctx) => {
                calls.push(`transport ${key} [${request.selectorIds.join(', ')}]`);
                seen = ctx;
                return ANSWER;
            },
        };
        handler = {
            key: USER,
            entityName: 'String',
            dbSystem: 'jpa',
            handle: async (request, ctx) => {
                calls.push(`handler [${request.selectorIds.join(', ')}]`);
                seen = ctx;
                return ANSWER;
            },
        };
    });

    function sendStep(name: string): SendBehavior {
        return async (request, next) => {
            calls.push(`${name} before`);
            const response = await next(request);
            calls.push(`${name} after`);
            return response;
        };
    }

    function receiveStep(name: string): ReceiveBehavior {
        return async (request, next) => {
            calls.push(`${name} before`);
            const response = await next(request);
            calls.push(`${name} after`);
            return response;
        };
    }

    it('sendRunsTheBehaviorsInTheirOrderAroundTheTransport', async () => {
        const piped = sendPipeline(client, [sendStep('first'), sendStep('second')]);

        const response = await piped.request(USER, REQUEST, context());

        expect(response).toEqual(ANSWER);
        expect(calls).toEqual(['first before', 'second before', 'transport UserOf [1]', 'second after', 'first after']);
    });

    it('aSendBehaviorCanChangeTheHeadersAndTheRequest', async () => {
        const tenant: SendBehavior = (request, next) => next(request.withHeader('x-tenant', 'acme')
            .withHeader('x-caller', null)
            .withRequest({ selectorIds: ['2'], expressions: request.request.expressions }));

        await sendPipeline(client, [tenant]).request(USER, REQUEST, context());

        expect(seen!.headers).toEqual({ 'x-tenant': 'acme' });
        expect(calls).toEqual(['transport UserOf [2]']);
    });

    it('aSendBehaviorCanAnswerWithoutTheTransport', async () => {
        const cached: ItemsResponse = { items: [], errors: [] };
        const cache: SendBehavior = async () => cached;

        const response = await sendPipeline(client, [cache]).request(USER, REQUEST, context());

        expect(response).toBe(cached);
        expect(calls).toEqual([]);
    });

    it('aBehaviorThatThrowsFailsTheRequestInsteadOfThrowing', async () => {
        const broken: SendBehavior = () => {
            throw new Error('broken');
        };
        const piped = sendPipeline(client, [broken]);

        let response: Promise<ItemsResponse> | undefined;
        expect(() => {
            response = piped.request(USER, REQUEST, context());
        }).not.toThrow();

        await expect(response).rejects.toThrow('broken');
    });

    it('aBehaviorThatReturnsNoStageFailsTheRequest', async () => {
        // JS: outside the types, a behavior can return no promise at all
        const none: SendBehavior = () => null as unknown as Promise<ItemsResponse>;

        const response = sendPipeline(client, [none]).request(USER, REQUEST, context());

        await expect(response).rejects.toBeInstanceOf(TypeError);
    });

    it('aTransportThatThrowsFailsTheRequest', async () => {
        const throwing: RequestClient = {
            request: () => {
                throw new RangeError('down');
            },
        };

        const response = sendPipeline(throwing, [sendStep('only')]).request(USER, REQUEST, context());

        await expect(response).rejects.toBeInstanceOf(RangeError);
    });

    it('sendKeepsTheNameOfTheTransport', () => {
        expect(sendPipeline(client, [sendStep('only')]).transport).toBe('nats');
    });

    it('withoutBehaviorsTheClientAndTheHandlerAreReturnedAsTheyAre', () => {
        expect(sendPipeline(client, [])).toBe(client);
        expect(receivePipeline(handler, [])).toBe(handler);
    });

    it('receiveRunsTheBehaviorsInTheirOrderAroundTheHandler', async () => {
        const piped = receivePipeline(handler, [receiveStep('first'), receiveStep('second')]);

        const response = await piped.handle(REQUEST, context());

        expect(response).toEqual(ANSWER);
        expect(calls).toEqual(['first before', 'second before', 'handler [1]', 'second after', 'first after']);
    });

    it('receiveKeepsTheKeyTheEntityAndTheDatabaseOfTheHandler', () => {
        const piped = receivePipeline(handler, [receiveStep('only')]);

        expect(piped.key).toBe(USER);
        // JS: a handler names its entity instead of giving its class
        expect(piped.entityName).toBe('String');
        expect(piped.dbSystem).toBe('jpa');
    });

    it('aReceiveBehaviorSeesTheKeyAndCanRefuseTheRequest', async () => {
        class SecurityError extends Error {
        }
        let refused: string | null = null;
        const guard: ReceiveBehavior = (request, next) => {
            refused = request.key;
            if (!('x-tenant' in request.headers)) return Promise.reject(new SecurityError('no tenant'));
            return next(request);
        };

        const response = receivePipeline(handler, [guard]).handle(REQUEST, context());

        await expect(response).rejects.toBeInstanceOf(SecurityError);
        expect(refused).toBe(USER);
        expect(calls).toEqual([]);
    });

    it('receiveWrapsEachHandlerOfAList', async () => {
        // JS: receivePipeline has no overload for a list; each handler is wrapped with map
        const piped = [handler, handler].map(h => receivePipeline(h, [receiveStep('only')]));

        expect(piped).toHaveLength(2);
        await piped[1].handle(REQUEST, context());
        expect(calls).toEqual(['only before', 'handler [1]', 'only after']);
    });

    it('theRequestContextNeedsAKeyARequestAndAContext', () => {
        // JS: the types rule out a null key, request or context
        expect(new RequestContext(USER, REQUEST, context()).headers).toHaveProperty('x-caller', 'orders');
    });
});
