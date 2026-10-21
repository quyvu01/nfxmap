import { WireMessages } from 'nfxmap';
import { describe, expect, it } from 'vitest';
import { type Complexity, parse } from '../src/expression-parser.js';
import { createMapper, map, PRODUCTS, PROVINCES } from '../src/mapping.js';
import { wireData } from '../src/wire-messages.js';

// The code of each benchmark run once: what it measures works and gives the expected result
describe('benchmarks', () => {
    it.each<Complexity>(['simple', 'medium', 'complex'])('parses the %s expression', complexity => {
        expect(parse(complexity)).toBeDefined();
    });

    it('parses expressions that grow in complexity', () => {
        expect(parse('simple').kind).toBe('Property');
        expect(parse('complex').kind).toBe('Projection');
    });

    it.each([1, 100, 10_000])('maps every rule of %i DTOs', async dtos => {
        const result = await map(createMapper(), dtos);

        expect(result).toHaveLength(dtos);
        const last = result[result.length - 1];
        const user = last.userId;
        expect(last.userName).toBe(`User ${user}`);
        expect(last.userEmail).toBe(`user${user}@example.com`);
        expect(last.countryName).toBe(user % 10 === 0 ? null : `Country ${user % 7}`);
        expect(last.doneTotal).toBe(user + 2.5);
        // The chained rule: the province id from the user, then its name from the province
        expect(last.provinceId).toBe(user % PROVINCES);
        expect(last.provinceName).toBe(`Province ${user % PROVINCES}`);
        // The nested DTOs, mapped by their own profile
        for (const line of result.flatMap(dto => dto.lines)) {
            expect(line.productId).toBeLessThan(PRODUCTS);
            expect(line.productName).toBe(`Product ${line.productId}`);
        }
    });

    it('reads the wire messages back to what was written', () => {
        const data = wireData(10);

        expect(WireMessages.readRequest(WireMessages.writeRequest(data.request))).toEqual(data.request);
        expect(WireMessages.readRequest(data.requestJson)).toEqual(data.request);
        expect(WireMessages.readResult(WireMessages.writeSuccess(data.response))).toEqual(data.response);
        expect(WireMessages.readResult(data.responseJson).items).toHaveLength(10);
    });
});
