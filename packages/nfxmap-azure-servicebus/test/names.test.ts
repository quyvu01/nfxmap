import { describe, expect, it } from 'vitest';
import { ServiceBusNames, serviceBusHeaders } from '../src/index.js';
import { bodyOf, correlationIdOf, isMissingEntity, isSent } from '../src/messages.js';

describe('ServiceBusNames', () => {
    it('names the queues of a key as FxMap names them', () => {
        expect(ServiceBusNames.requestQueue('UserOf')).toBe('fxmap-request--userof');
        expect(ServiceBusNames.replyQueue('UserOf')).toBe('fxmap-reply--userof');
        expect(ServiceBusNames.requestQueue('Shop.Keys.UserOf')).toBe('fxmap-request-shop-keys-userof');
    });

    it('puts the topic prefix first', () => {
        expect(ServiceBusNames.requestQueue('UserOf', 'Tenant.A')).toBe('tenant-a-fxmap-request--userof');
        expect(ServiceBusNames.replyQueue('UserOf', '')).toBe('fxmap-reply--userof');
        expect(ServiceBusNames.replyQueue('UserOf', null)).toBe('fxmap-reply--userof');
    });
});

describe('messages', () => {
    it('reads the application properties as headers, bytes as UTF-8', () => {
        expect(serviceBusHeaders({
            authorization: 'Bearer x',
            traceparent: Buffer.from('00-abc-01'),
            count: 3,
            on: true,
            at: new Date('2026-01-02T03:04:05Z'),
            missing: null,
        })).toEqual({
            authorization: 'Bearer x',
            traceparent: '00-abc-01',
            count: '3',
            on: 'true',
            at: '2026-01-02T03:04:05.000Z',
        });
        expect(serviceBusHeaders(undefined)).toEqual({});
    });

    it('keeps the trace context back, as Service Bus refuses it as FxMap sends it', () => {
        expect(isSent('traceparent')).toBe(false);
        expect(isSent('tracestate')).toBe(false);
        expect(isSent('authorization')).toBe(true);
    });

    it('reads correlation ids and bodies of any type', () => {
        expect(correlationIdOf('c-1')).toBe('c-1');
        expect(correlationIdOf(Buffer.from('c-2'))).toBe('c-2');
        expect(correlationIdOf(7)).toBe('7');
        expect(correlationIdOf(undefined)).toBeNull();
        expect(bodyOf(Buffer.from('{"a":1}')).toString()).toBe('{"a":1}');
        expect(bodyOf('{"a":1}').toString()).toBe('{"a":1}');
        expect(bodyOf({ a: 1 }).toString()).toBe('{"a":1}');
    });

    it('knows the error of a missing queue', () => {
        expect(isMissingEntity({ code: 'MessagingEntityNotFound' })).toBe(true);
        expect(isMissingEntity({ code: 'ServiceTimeout' })).toBe(false);
        expect(isMissingEntity(new Error('other'))).toBe(false);
        expect(isMissingEntity(null)).toBe(false);
    });
});
