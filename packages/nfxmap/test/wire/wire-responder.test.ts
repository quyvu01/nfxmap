import { describe, expect, it } from 'vitest';
import {
    DistributedKeyAssignedToMultipleEntitiesError,
    type ItemsResponse,
    type MapContext,
    type MapRequest,
    type QueryHandler,
    ReceivedFaultError,
    WireMessages,
    WireResponder,
} from '../../src/index.js';

const USER_OF = 'UserOf';
const ANN: ItemsResponse = { items: [{ id: '1', values: [{ expression: null, value: '"Ann"' }] }], errors: [] };
const silent = { error() {} };

// JS: a handler names its entity where Java gives its class
function handler(key: string, entityName: string,
                 answer: (request: MapRequest, context: MapContext) => Promise<ItemsResponse>): QueryHandler {
    return { key, entityName, handle: answer };
}

describe('WireResponder', () => {
    it('answersWithTheHandlerOfTheKeyAndPassesTheHeaders', async () => {
        let seen: MapContext | null = null;
        let seenRequest: MapRequest | null = null;
        const responder = new WireResponder([handler('UserOf', 'String', async (request, context) => {
            seenRequest = request;
            seen = context;
            return ANN;
        })], 1_000, silent);

        const reply = await responder.answer(USER_OF, Buffer.from('{"SelectorIds":["1"],"Expressions":[null]}'),
            { tenant: 'a' });

        expect(WireMessages.readResult(reply)).toEqual(ANN);
        expect(seenRequest!.selectorIds).toEqual(['1']);
        expect(seen!.headers).toHaveProperty('tenant', 'a');
        expect(responder.keys).toEqual([USER_OF]);
    });

    it('anUnknownKeyIsAFault', async () => {
        const responder = new WireResponder([], 1_000, silent);

        const reply = await responder.answer(USER_OF, { selectorIds: ['1'], expressions: [] });

        expect(() => WireMessages.readResult(reply)).toThrow(ReceivedFaultError);
        expect(() => WireMessages.readResult(reply)).toThrow('NoHandlerForDistributedKey');
    });

    it('aMissingKeyIsAFault', async () => {
        const responder = new WireResponder([], 1_000, silent);

        const reply = await responder.answer(null, { selectorIds: ['1'], expressions: [] });

        expect(() => WireMessages.readResult(reply)).toThrow('names no distributed key');
    });

    it('aRequestThatIsNotJsonIsAFault', async () => {
        const responder = new WireResponder([handler('UserOf', 'String', async () => ANN)], 1_000, silent);

        const reply = await responder.answer(USER_OF, Buffer.from('nope'));

        expect(() => WireMessages.readResult(reply)).toThrow('not JSON');
    });

    it('aHandlerThatFailsOrThrowsIsAFault', async () => {
        const failing = new WireResponder([handler('UserOf', 'String', () => Promise.reject(new Error('db down')))],
            1_000, silent);
        const throwing = new WireResponder([handler('UserOf', 'String', () => {
            throw new Error('bug');
        })], 1_000, silent);

        const request: MapRequest = { selectorIds: ['1'], expressions: [] };
        const failed = await failing.answer(USER_OF, request);
        expect(() => WireMessages.readResult(failed)).toThrow('db down');
        const thrown = await throwing.answer(USER_OF, request);
        expect(() => WireMessages.readResult(thrown)).toThrow('bug');
    });

    it('aHandlerThatDoesNotAnswerInTimeIsATimeoutFault', async () => {
        const responder = new WireResponder([handler('UserOf', 'String', () => new Promise(() => {}))], 50, silent);

        const reply = await responder.answer(USER_OF, { selectorIds: ['1'], expressions: [] });

        // JS: the type of the timeout is named TimeoutException, as .NET names it, without a Java package
        expect(() => WireMessages.readResult(reply)).toThrow('TimeoutException: Request timeout for UserOf');
    });

    it('twoHandlersOfOneKeyOrABadTimeoutAreRejected', () => {
        const first = handler('UserOf', 'String', async () => ANN);
        const second = handler('UserOf', 'Integer', async () => ANN);

        expect(() => new WireResponder([first, second], 1_000)).toThrow(DistributedKeyAssignedToMultipleEntitiesError);
        // JS: Java's IllegalArgumentException is a RangeError; the types rule out a null timeout
        expect(() => new WireResponder([], 0)).toThrow(RangeError);
    });
});
