import { DistributedKey } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { NatsSubjects } from '../src/index.js';

describe('NatsSubjects', () => {
    it('gives a string key an empty namespace', () => {
        expect(NatsSubjects.of('UserOf')).toBe('fxmap--userof');
        expect(NatsSubjects.of('UserOf', null)).toBe('fxmap--userof');
        expect(NatsSubjects.of('UserOf', '')).toBe('fxmap--userof');
    });

    it('splits a dotted key into namespace and name', () => {
        expect(NatsSubjects.of('Shop.Keys.UserOf')).toBe('fxmap-shop.keys-userof');
    });

    it('puts the prefix first, lower-cased too', () => {
        expect(NatsSubjects.of('UserOf', 'Prod')).toBe('prod-fxmap--userof');
    });

    it('names a class key after the class', () => {
        class CountryOf extends DistributedKey {}
        expect(NatsSubjects.of(CountryOf)).toBe('fxmap--countryof');
    });
});
