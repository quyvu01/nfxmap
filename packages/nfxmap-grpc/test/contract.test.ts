import { describe, expect, it } from 'vitest';
// @ts-expect-error: the script has no types
import { descriptor } from '../scripts/descriptor.mjs';
import { FXMAP_DESCRIPTOR } from '../src/descriptor.js';
import { ExpressionsJson, GrpcKeyNames } from '../src/index.js';

describe("FxMap's gRPC contract", () => {
    it('is the descriptor of proto/fxMap.proto', () => {
        expect(JSON.parse(JSON.stringify(FXMAP_DESCRIPTOR))).toEqual(descriptor());
    });
});

describe('GrpcKeyNames', () => {
    it('sends the assembly-qualified name FxMap gives a string key', () => {
        expect(GrpcKeyNames.toWire('UserOf'))
            .toBe('UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null');
    });

    it('reads the key of an FxMap name or of a bare name, and nothing of a .NET type', () => {
        expect(GrpcKeyNames.fromWire(GrpcKeyNames.toWire('Shop.UserOf'))).toBe('Shop.UserOf');
        expect(GrpcKeyNames.fromWire('UserOf')).toBe('UserOf');
        expect(GrpcKeyNames.fromWire('Shop.UserOf, Shop.Contracts, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null'))
            .toBeNull();
        expect(GrpcKeyNames.fromWire(null)).toBeNull();
    });
});

describe('ExpressionsJson', () => {
    it('writes the expressions as one JSON array', () => {
        expect(ExpressionsJson.write([null, 'Email', 'Country.Name'])).toBe('[null,"Email","Country.Name"]');
    });

    it('reads them back, and nothing as none', () => {
        expect(ExpressionsJson.read('[null,"Email"]')).toEqual([null, 'Email']);
        expect(ExpressionsJson.read(null)).toEqual([]);
        expect(ExpressionsJson.read(' ')).toEqual([]);
        expect(ExpressionsJson.read('null')).toEqual([]);
    });

    it('refuses what is not a JSON array of strings', () => {
        expect(() => ExpressionsJson.read('Email')).toThrow(TypeError);
        expect(() => ExpressionsJson.read('[1]')).toThrow(TypeError);
        expect(() => ExpressionsJson.read('{"a":"b"}')).toThrow(TypeError);
    });
});
