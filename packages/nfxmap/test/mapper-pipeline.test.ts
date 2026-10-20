import { beforeEach, describe, expect, it } from 'vitest';
import {
    createDistributedMapper,
    type Headers,
    LocalRequestClient,
    MapContext,
    type QueryHandler,
    type RequestClient,
    RetryPolicy,
    type SendBehavior,
} from '../src/index.js';
import { FakeRequestClient } from './fake-request-client.js';
import { UserSummaryDto, UserSummaryProfile } from './models.js';

const USER = 'UserOf';
const ALICE = '00000000-0000-0000-0000-00000000000a';

const silent = { warn() {} };

/** The headers as Java prints a TreeMap: `{a=1, b=2}`. */
function sorted(headers: Headers): string {
    return `{${Object.keys(headers).sort().map(name => `${name}=${headers[name]}`).join(', ')}}`;
}

/** The send behaviors and the retry policy of the mapper, around its transport. */
describe('MapperPipeline', () => {
    let users: FakeRequestClient;
    let attempts: number;
    let calls: string[];

    beforeEach(() => {
        users = new FakeRequestClient().value(USER, ALICE, null, '"Alice"');
        attempts = 0;
        calls = [];
    });

    /** Fails the first `failures` requests, then answers from `users`. */
    function flaky(failures: number): RequestClient {
        return {
            request: async (key, request, context) => {
                calls.push(`transport ${sorted(context.headers)}`);
                if (++attempts <= failures) throw new Error('broker down');
                return users.request(key, request, context);
            },
        };
    }

    it('theRetryPolicyRecoversAFailedRequest', async () => {
        const mapper = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: flaky(2),
            retryPolicy: RetryPolicy.retries(3).delay(10), throwIfException: true,
        });
        const dto = new UserSummaryDto(ALICE);

        await mapper.map(dto);

        expect(dto.userName).toBe('Alice');
        expect(attempts).toBe(3);
    });

    it('withoutARetryPolicyAFailedRequestFailsTheMapping', async () => {
        const mapper = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: flaky(1), throwIfException: true,
        });

        await expect(mapper.map(new UserSummaryDto(ALICE))).rejects.toThrow(new Error('broker down'));
        expect(attempts).toBe(1);
    });

    it('whenTheRetriesAreUsedUpTheLastFailureIsLoggedOrThrownAsBefore', async () => {
        const logging = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: flaky(10), retryPolicy: RetryPolicy.retries(1),
            logger: silent,
        });
        const dto = new UserSummaryDto(ALICE);

        await logging.map(dto);

        expect(dto.userName).toBeNull();
        expect(attempts).toBe(2);
    });

    it('theBehaviorsRunInTheirOrderOnEachAttemptInsideTheRetries', async () => {
        const tenant: SendBehavior = (request, next) => {
            calls.push('tenant');
            return next(request.withHeader('x-tenant', 'acme'));
        };
        const timing: SendBehavior = (request, next) => {
            calls.push(`timing ${sorted(request.headers)}`);
            return next(request);
        };
        const mapper = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: flaky(1), retryPolicy: RetryPolicy.retries(1),
            sendBehaviors: [tenant, timing], throwIfException: true,
        });

        await mapper.map(new UserSummaryDto(ALICE), { headers: { 'x-caller': 'orders' } });

        expect(calls).toEqual([
            'tenant', 'timing {x-caller=orders, x-tenant=acme}', 'transport {x-caller=orders, x-tenant=acme}',
            'tenant', 'timing {x-caller=orders, x-tenant=acme}', 'transport {x-caller=orders, x-tenant=acme}']);
    });

    it('fetchAsyncGoesThroughTheBehaviorsToo', async () => {
        const tenant: SendBehavior = (request, next) => next(request.withHeader('x-tenant', 'acme'));
        const mapper = createDistributedMapper({ requestClient: users, sendBehaviors: [tenant] });

        await mapper.fetch(USER, { selectorIds: [ALICE], expressions: [] });

        expect(users.sent[0].context.headers).toHaveProperty('x-tenant', 'acme');
    });

    // Not ported: theBuilderRejectsNullBehaviorsAndPolicies. The mapper takes an options object whose types rule out
    // a null behavior or policy; there is no builder to check them.

    it('theContextGetsAHeaderWithoutChanging', () => {
        const context = new MapContext({ a: '1' }, () => 'service');

        const changed = context.withHeader('b', '2').withHeader('a', null);

        expect(context.headers).toEqual({ a: '1' });
        expect(changed.headers).toEqual({ b: '2' });
        expect(changed.service(String)).toBe('service');
        // JS: withHeader(null, ...) is ruled out by the types
    });

    it('transportsAndHandlersNameThemselves', () => {
        const custom: RequestClient = { request: async () => ({ items: [], errors: [] }) };
        const handler: QueryHandler = {
            key: USER,
            entityName: 'Object',
            handle: async () => ({ items: [], errors: [] }),
        };

        // JS: a client that does not name its transport leaves `transport` undefined, which telemetry reads as
        // 'custom'; a handler without a database leaves `dbSystem` undefined
        expect(custom.transport).toBeUndefined();
        expect(new LocalRequestClient().transport).toBe('local');
        expect(handler.dbSystem).toBeUndefined();
    });
});
