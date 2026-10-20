import { describe, expect, it } from 'vitest';
import { type ItemsResponse, ReceivedFaultError, WireMessages } from '../../src/index.js';

const utf8 = (text: string) => Buffer.from(text, 'utf8');

/** The fault a reply carries. */
function faultOf(read: () => unknown): ReceivedFaultError {
    try {
        read();
    } catch (error) {
        if (error instanceof ReceivedFaultError) return error;
        throw error;
    }
    throw new Error('The reply was read without a fault.');
}

describe('WireMessages', () => {
    it('writesARequestAsFxMapDoes', () => {
        const json = WireMessages.writeRequest({ selectorIds: ['1', '2'], expressions: [null, 'Email'] }).toString('utf8');

        expect(json).toBe('{"SelectorIds":["1","2"],"Expressions":[null,"Email"]}');
    });

    it('readsARequestWhateverTheCaseOfItsNames', () => {
        const request = WireMessages.readRequest(utf8('{"selectorIds":["1"],"EXPRESSIONS":[null,"Country.Name"]}'));

        expect(request.selectorIds).toEqual(['1']);
        expect(request.expressions).toEqual([null, 'Country.Name']);
    });

    it('aRequestWithoutMembersIsEmpty', () => {
        const request = WireMessages.readRequest(utf8('{}'));

        expect(request.selectorIds).toEqual([]);
        expect(request.expressions).toEqual([]);
    });

    it('aRequestThatIsNotOneIsRejected', () => {
        // JS: Java's IllegalArgumentException is a TypeError
        expect(() => WireMessages.readRequest(utf8('[1]'))).toThrow(TypeError);
        expect(() => WireMessages.readRequest(utf8('{"SelectorIds":"1"}'))).toThrow(TypeError);
        expect(() => WireMessages.readRequest(utf8('not json'))).toThrow(TypeError);
        expect(() => WireMessages.readRequest(new Uint8Array(0))).toThrow(TypeError);
    });

    it('writesASuccessAsFxMapDoes', () => {
        const response: ItemsResponse = {
            items: [{ id: '1', values: [{ expression: null, value: '"Ann"' }, { expression: 'Email', value: null }] }],
            errors: [{ expression: 'Bad(', message: 'syntax' }],
        };

        const json = WireMessages.writeSuccess(response).toString('utf8');

        expect(json).toBe('{"IsSuccess":true,"Data":{"Items":[{"Id":"1","Values":['
            + '{"Expression":null,"Value":"\\"Ann\\""},{"Expression":"Email","Value":null}]}],'
            + '"Errors":[{"Expression":"Bad(","Message":"syntax"}]},"Fault":null}');
    });

    it('aSuccessReadsBackToTheSameResponse', () => {
        const response: ItemsResponse = {
            items: [{ id: '1', values: [{ expression: null, value: '"Ann"' }] }],
            errors: [{ expression: 'Bad(', message: 'syntax' }],
        };

        expect(WireMessages.readResult(WireMessages.writeSuccess(response))).toEqual(response);
    });

    it('readsASuccessThatLeavesNullsOut', () => {
        const response = WireMessages.readResult(
            utf8('{"isSuccess":true,"data":{"items":[{"id":"7","values":[{"value":"1"}]}]}}'));

        expect(response.items).toEqual([{ id: '7', values: [{ expression: null, value: '1' }] }]);
        expect(response.errors).toEqual([]);
    });

    it('aFailureCarriesTheExceptionAndItsCauses', () => {
        // JS: there is no CompletionException to unwrap; the causes are the `cause` chain of the error
        const failure = new Error('outer', { cause: new RangeError('inner') });

        const json = WireMessages.writeFailure(failure);

        const text = json.toString('utf8');
        for (const part of ['"IsSuccess":false', '"Data":null', '"FaultId"', '"Timestamp"', '"Host"', '"ProcessId"'])
            expect(text).toContain(part);
        const fault = faultOf(() => WireMessages.readResult(json));
        expect(fault.message).toBe('The owner of the distributed key failed: Error: outer');
        expect(fault.faultId).toMatch(/\S/);
        expect(fault.exceptions.map(e => e.exceptionType)).toEqual(['Error', 'RangeError']);
        expect(fault.exceptions[0].stackTrace).toContain('wire-messages.test');
    });

    it('aFailureWithoutMessageUsesTheTypeName', () => {
        expect(() => WireMessages.readResult(WireMessages.writeFailure(new TypeError())))
            .toThrow(/TypeError: TypeError$/);
    });

    it('readsAFaultOfFxMap', () => {
        const json = '{"IsSuccess":false,"Data":null,"Fault":{"FaultId":"f1","Exceptions":[{'
            + '"ExceptionType":"System.TimeoutException","Message":"Request timeout for UserOf",'
            + '"StackTrace":null,"Source":null}]}}';

        expect(() => WireMessages.readResult(utf8(json))).toThrow(ReceivedFaultError);
        expect(() => WireMessages.readResult(utf8(json))).toThrow('System.TimeoutException: Request timeout for UserOf');
    });

    it('aFaultWithoutExceptionsStillFails', () => {
        expect(() => WireMessages.readResult(utf8('{"IsSuccess":false}'))).toThrow(ReceivedFaultError);
        expect(() => WireMessages.readResult(utf8('{"IsSuccess":false}')))
            .toThrow(/^The owner of the distributed key failed\.$/);
    });

    it('aReplyThatIsNotAnObjectIsRejected', () => {
        expect(() => WireMessages.readResult(utf8('true'))).toThrow(TypeError);
    });
});
