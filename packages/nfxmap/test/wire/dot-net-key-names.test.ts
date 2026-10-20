import { describe, expect, it } from 'vitest';
import { DotNetKeyNames } from '../../src/index.js';

describe('DotNetKeyNames', () => {
    it('aKeyWithoutDotsHasNoNamespace', () => {
        const key = 'UserOf';

        expect(DotNetKeyNames.fullName(key)).toBe('UserOf');
        expect(DotNetKeyNames.namespace(key)).toBe('');
        expect(DotNetKeyNames.name(key)).toBe('UserOf');
        expect(DotNetKeyNames.assemblyQualifiedName(key)).toBe(
            'UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null');
    });

    it('theNamespaceOfADottedKeyIsWhatComesBeforeTheLastDot', () => {
        const key = 'Shop.Keys.UserOf';

        expect(DotNetKeyNames.namespace(key)).toBe('Shop.Keys');
        expect(DotNetKeyNames.name(key)).toBe('UserOf');
        expect(DotNetKeyNames.fullName(key)).toBe('Shop.Keys.UserOf');
    });

    it('readsAnAssemblyQualifiedNameOrABareName', () => {
        expect(DotNetKeyNames.fromAssemblyQualifiedName(
            'UserOf, FxMap.DynamicDistributedKeys, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null'))
            .toBe('UserOf');
        expect(DotNetKeyNames.fromAssemblyQualifiedName(' UserOf ')).toBe('UserOf');
    });

    it('aNameOfAnotherAssemblyOrNothingGivesNoKey', () => {
        // JS: no key is null where Java has an empty Optional
        expect(DotNetKeyNames.fromAssemblyQualifiedName('Shop.UserOf, Shop.Contracts, Version=1.0.0.0')).toBeNull();
        expect(DotNetKeyNames.fromAssemblyQualifiedName('  ')).toBeNull();
        expect(DotNetKeyNames.fromAssemblyQualifiedName(null)).toBeNull();
    });
});
