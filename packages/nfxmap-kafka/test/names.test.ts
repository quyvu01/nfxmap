import { describe, expect, it } from 'vitest';
import { KafkaMessages, KafkaNames } from '../src/index.js';

describe('KafkaNames', () => {
    it('names the request topic of a key as FxMap names it, in lower case', () => {
        expect(KafkaNames.requestTopic('UserOf')).toBe('fxmap-request-topic-userof');
        expect(KafkaNames.requestTopic('Shop.Keys.UserOf')).toBe('fxmap-request-topic-shop.keys.userof');
    });

    it('gives each client a reply topic of its own', () => {
        const first = KafkaNames.newResponseTopic('OrderService');
        const second = KafkaNames.newResponseTopic('OrderService');

        expect(first).toMatch(/^fxmap-response-topic-orderservice-[0-9a-f]{32}$/);
        expect(second).not.toBe(first);
        expect(() => KafkaNames.newResponseTopic(' ')).toThrow(RangeError);
        expect(() => KafkaNames.newResponseTopic(undefined as unknown as string)).toThrow(RangeError);
    });

    it("keeps FxMap's group of the servers", () => {
        expect(KafkaNames.SERVER_GROUP_ID).toBe('fxmap-rpc-server-group');
    });
});

describe('KafkaMessages', () => {
    it('wraps a request with the topic to reply on', () => {
        const json = KafkaMessages.writeRequest({ selectorIds: ['1'], expressions: [null, 'Email'] }, 'replies');

        expect(JSON.parse(json.toString())).toEqual({
            Message: { SelectorIds: ['1'], Expressions: [null, 'Email'] },
            ReplyTo: 'replies',
        });
    });

    it('reads a wrapped request, without case', () => {
        expect(KafkaMessages.readRequest('{"message":{"selectorIds":["2"],"expressions":["Name"]},"replyTo":"r"}'))
            .toEqual({ request: { selectorIds: ['2'], expressions: ['Name'] }, replyTo: 'r' });
        expect(KafkaMessages.readRequest(Buffer.from('{"Message":{"SelectorIds":[],"Expressions":[]},"ReplyTo":null}')))
            .toEqual({ request: { selectorIds: [], expressions: [] }, replyTo: null });
    });

    it('refuses what is not a wrapped request', () => {
        expect(() => KafkaMessages.readRequest('not json')).toThrow(TypeError);
        expect(() => KafkaMessages.readRequest('[]')).toThrow(TypeError);
        expect(() => KafkaMessages.readRequest('{"ReplyTo":"r"}')).toThrow(TypeError);
    });

    it('sends the headers as strings', () => {
        expect(KafkaMessages.toKafkaHeaders({ tenant: 'a', empty: null })).toEqual({ tenant: 'a', empty: '' });
    });

    it('reads the headers as strings, the first value of a repeated name', () => {
        expect(KafkaMessages.fromKafkaHeaders({
            bytes: Buffer.from('b'),
            text: 't',
            repeated: [Buffer.from('first'), 'second'],
            none: undefined,
        })).toEqual({ bytes: 'b', text: 't', repeated: 'first', none: '' });
        expect(KafkaMessages.fromKafkaHeaders(undefined)).toEqual({});
    });
});
