import { describe, expect, it } from 'vitest';
import { EntityConfigureOf, EntityExpressionEvaluator } from '../../src/index.js';

class Item {
    constructor(readonly id: number, readonly name: string, readonly code: string) {
    }
}

class ItemConfig extends EntityConfigureOf<Item> {
    constructor() {
        super(Item);
    }

    protected configure(): void {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('ItemOf');
        this.exposedName('code', 'ItemCode');
    }
}

class NoKeyConfig extends EntityConfigureOf<Item> {
    constructor() {
        super(Item);
    }

    protected configure(): void {
        this.id('id');
    }
}

describe('EntityExpressionEvaluator', () => {
    const config = new ItemConfig();
    const evaluator = new EntityExpressionEvaluator(config);

    it('answersFromTheLookupInTheRequestedOrder', () => {
        const items = new Map([['1', new Item(1, 'Pen', 'P-1')], ['2', new Item(2, 'Ink', 'I-2')]]);

        const response = evaluator.answer({ selectorIds: ['2', '9', '1'], expressions: [null, 'ItemCode'] },
            id => items.get(id));

        expect(response.items).toEqual([
            { id: '2', values: [{ expression: null, value: '"Ink"' }, { expression: 'ItemCode', value: '"I-2"' }] },
            { id: '1', values: [{ expression: null, value: '"Pen"' }, { expression: 'ItemCode', value: '"P-1"' }] },
        ]);
        expect(response.errors).toEqual([]);
    });

    it('reportsAnExpressionThatDoesNotParseWithoutAnyEntity', () => {
        const response = evaluator.answer({ selectorIds: ['1'], expressions: ['Name:'] }, () => null);

        expect(response.items).toEqual([]);
        expect(response.errors.map(e => e.expression)).toEqual(['Name:']);
    });

    it('exposesItsConfiguration', () => {
        // JS: the evaluator exposes the definition of its configuration, not the configuration object
        expect(evaluator.definition).toBe(config.definition);
    });

    it('rejectsAnIncompleteConfigurationAndAMissingLookup', () => {
        expect(() => new EntityExpressionEvaluator(new NoKeyConfig())).toThrow('useDistributedKey');
        // JS: the types rule out a missing lookup
    });
});
