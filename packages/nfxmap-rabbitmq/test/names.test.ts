import { describe, expect, it } from 'vitest';
import { fromAmqpHeaders, RabbitMqNames, toAmqpHeaders } from '../src/index.js';

describe('RabbitMqNames', () => {
    it('names the exchange of a key as FxMap names it', () => {
        expect(RabbitMqNames.exchange('UserOf')).toBe('FxMap-:UserOf');
        expect(RabbitMqNames.exchange('Shop.Keys.UserOf')).toBe('FxMap-Shop.Keys:UserOf');
    });

    it('gives back the key of an exchange name', () => {
        expect(RabbitMqNames.keyOfExchange('FxMap-:UserOf')).toBe('UserOf');
        expect(RabbitMqNames.keyOfExchange('FxMap-Shop.Keys:UserOf')).toBe('Shop.Keys.UserOf');
    });

    it('gives no key for other exchange names', () => {
        expect(RabbitMqNames.keyOfExchange('amq.direct')).toBeNull();
        expect(RabbitMqNames.keyOfExchange('FxMap-NoColon')).toBeNull();
        expect(RabbitMqNames.keyOfExchange('FxMap-Shop:')).toBeNull();
        expect(RabbitMqNames.keyOfExchange('')).toBeNull();
        expect(RabbitMqNames.keyOfExchange(null)).toBeNull();
        expect(RabbitMqNames.keyOfExchange(undefined)).toBeNull();
    });

    it('names the queue of a service after the service, in lower case', () => {
        expect(RabbitMqNames.queue('UserService')).toBe('fxmap-rpc-queue-userservice');
        expect(() => RabbitMqNames.queue(' ')).toThrow(RangeError);
        expect(() => RabbitMqNames.queue(undefined as unknown as string)).toThrow(RangeError);
    });

    it("keeps FxMap's spelling of the routing key", () => {
        expect(RabbitMqNames.ROUTING_KEY).toBe('fxmap-rpc-rounting-key');
    });
});

describe('the AMQP headers', () => {
    it('are sent as strings, without the missing values', () => {
        expect(toAmqpHeaders({ tenant: 'a', empty: null, none: undefined })).toEqual({ tenant: 'a' });
    });

    it('are read from text, bytes and other values', () => {
        expect(fromAmqpHeaders({ text: 'a', bytes: Buffer.from('b'), number: 7, none: null }))
            .toEqual({ text: 'a', bytes: 'b', number: '7' });
        expect(fromAmqpHeaders(undefined)).toEqual({});
        expect(fromAmqpHeaders(null)).toEqual({});
    });
});
