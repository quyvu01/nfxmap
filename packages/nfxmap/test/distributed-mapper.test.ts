import { beforeEach, describe, expect, it } from 'vitest';
import {
    createDistributedMapper,
    ExpressionsFailedError,
    MaxNestingDepthReachedError,
    type ProfileLike,
    ProfileOf,
    type RequestClient,
    ValueWriteFailedError,
} from '../src/index.js';
import { FakeRequestClient } from './fake-request-client.js';
import {
    Country,
    MemberDto,
    MemberProfile,
    PageDto,
    PageProfile,
    UserDetailDto,
    UserDetailProfile,
    UserOf,
    UserSummaryDto,
    UserSummaryProfile,
} from './models.js';

const USER = 'UserOf';
const PROVINCE = 'ProvinceOf';
// JS: the ids are strings where Java has UUIDs
const ALICE = '00000000-0000-0000-0000-00000000000a';
const BOB = '00000000-0000-0000-0000-00000000000b';

const silent = { warn() {} };

describe('DistributedMapper', () => {
    let client: FakeRequestClient;

    beforeEach(() => {
        client = new FakeRequestClient()
            .value(USER, ALICE, null, '"Alice"')
            .value(USER, ALICE, 'UserEmail', '"alice@example.com"')
            .value(USER, ALICE, 'Country.Name', '"Vietnam"')
            .value(USER, BOB, null, '"Bob"')
            .value(USER, BOB, 'UserEmail', '"bob@example.com"')
            .value(USER, BOB, 'Country.Name', '"Japan"');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function mapper(...profiles: ProfileLike<any>[]) {
        return createDistributedMapper({ profiles, requestClient: client, throwIfException: true });
    }

    it('fillsEveryRuleOfAnObject', async () => {
        const dto = new UserSummaryDto(ALICE);

        await mapper(new UserSummaryProfile()).map(dto);

        expect(dto.userName).toBe('Alice');
        expect(dto.userEmail).toBe('alice@example.com');
        expect(dto.countryName).toBe('Vietnam');
    });

    it('batchesDistinctIdsAndExpressionsIntoOneRequestPerKey', async () => {
        const dtos = [new UserSummaryDto(ALICE), new UserSummaryDto(BOB), new UserSummaryDto(ALICE)];

        await mapper(new UserSummaryProfile()).map(dtos);

        expect(client.sent).toHaveLength(1);
        const request = client.sent[0].request;
        expect([...request.selectorIds].sort()).toEqual([ALICE, BOB]);
        expect(new Set(request.expressions)).toEqual(new Set([null, 'UserEmail', 'Country.Name']));
        expect(request.expressions).toHaveLength(3);
        expect(dtos.map(d => d.userName)).toEqual(['Alice', 'Bob', 'Alice']);
        expect(dtos.map(d => d.countryName)).toEqual(['Vietnam', 'Japan', 'Vietnam']);
    });

    it('sendsNothingWhenNoObjectHasAnId', async () => {
        const dto = new UserSummaryDto(null);

        await mapper(new UserSummaryProfile()).map([dto]);

        expect(client.sent).toHaveLength(0);
        expect(dto.userName).toBeNull();
    });

    it('leavesThePropertiesOfAnUnknownIdAlone', async () => {
        const dto = new UserSummaryDto('00000000-0000-0000-0000-0000000000ff');
        dto.userName = 'unchanged';

        await mapper(new UserSummaryProfile()).map(dto);

        expect(dto.userName).toBe('unchanged');
    });

    it('runsTheRulesWhoseKeyIsFilledByAnotherRuleAfterIt', async () => {
        client.value(USER, ALICE, 'ProvinceId', '7')
            .value(USER, BOB, 'ProvinceId', '8')
            .value(PROVINCE, 7, null, '"Hanoi"')
            .value(PROVINCE, 8, null, '"Osaka"');
        const members = [new MemberDto(ALICE), new MemberDto(BOB)];

        await mapper(new MemberProfile()).map(members);

        expect(client.sent.map(s => s.key)).toEqual([USER, PROVINCE]);
        expect([...client.sent[1].request.selectorIds].sort()).toEqual(['7', '8']);
        expect(members.map(m => m.provinceId)).toEqual([7, 8]);
        expect(members.map(m => m.provinceName)).toEqual(['Hanoi', 'Osaka']);
    });

    it('readsTheJsonValuesAsTheTypesOfTheTargetProperties', async () => {
        // JS: there are no declared types; the rules of UserDetailProfile convert the parsed values
        client.value(USER, ALICE, 'Birthday', '"1990-04-30"')
            .value(USER, ALICE, 'Country', '{"Name":"Vietnam","Code":"VN"}')
            .value(USER, ALICE, 'Tags', '["admin","owner"]');
        const dto = new UserDetailDto(ALICE);

        await mapper(new UserDetailProfile()).map(dto);

        expect(dto.birthday).toEqual(new Date(Date.UTC(1990, 3, 30)));
        expect(dto.country).toEqual(new Country('Vietnam', 'VN'));
        expect(dto.country).toBeInstanceOf(Country);
        expect(dto.tags).toEqual(['admin', 'owner']);
    });

    it('mapsTheObjectsItWritesOnTheNextLevel', async () => {
        client.value(USER, ALICE, 'Summary', `{"userId":"${BOB}"}`);
        const dto = new UserDetailDto(ALICE);

        await mapper(new UserDetailProfile(), new UserSummaryProfile()).map(dto);

        expect(dto.summary!.userId).toBe(BOB);
        expect(dto.summary!.userName).toBe('Bob');
        expect(client.sent).toHaveLength(2);
    });

    it('walksCollectionsMapsArraysAndNestedObjects', async () => {
        const page = new PageDto();
        page.items.push(new UserSummaryDto(ALICE));
        page.byName = new Map([['bob', new UserSummaryDto(BOB)]]);
        page.pinned = [new UserSummaryDto(BOB)];
        page.featured = new UserSummaryDto(ALICE);

        await mapper(new PageProfile(), new UserSummaryProfile()).map(page);

        expect(page.items[0].userName).toBe('Alice');
        expect(page.byName.get('bob')!.userName).toBe('Bob');
        expect(page.pinned[0].userName).toBe('Bob');
        expect(page.featured.userName).toBe('Alice');
        expect(client.sent).toHaveLength(1);
    });

    it('mapsAnObjectReachedTwiceOnce', async () => {
        const shared = new UserSummaryDto(ALICE);

        await mapper(new UserSummaryProfile()).map([shared, shared]);

        expect(client.sent).toHaveLength(1);
        expect(shared.userName).toBe('Alice');
    });

    it('usesTheProfileOfTheNearestSuperclass', async () => {
        class SpecialSummary extends UserSummaryDto {
        }
        const dto = new SpecialSummary(BOB);

        await mapper(new UserSummaryProfile()).map(dto);

        expect(dto.userName).toBe('Bob');
    });

    it('choosesConditionalExpressionsPerCallAndSendsTheHeaders', async () => {
        class Profile extends ProfileOf<UserSummaryDto> {
            constructor() {
                super(UserSummaryDto);
            }

            protected configure(): void {
                this.useDistributedKey(UserOf)
                    .of('userId')
                    .for('userName', c => c
                        .when(ctx => 'x-email' in ctx.headers)
                        .expression('UserEmail')
                        .otherwise(null));
            }
        }
        const m = mapper(new Profile());
        const plain = new UserSummaryDto(ALICE);
        const withEmail = new UserSummaryDto(ALICE);

        await m.map(plain);
        await m.map(withEmail, { headers: { 'x-email': '1' } });

        expect(plain.userName).toBe('Alice');
        expect(withEmail.userName).toBe('alice@example.com');
        expect(client.sent[1].context.headers).toHaveProperty('x-email', '1');
    });

    it('conditionalExpressionsCanUseTheRegisteredServices', async () => {
        class Flags {
            constructor(readonly emailAsName: boolean) {
            }
        }
        class Profile extends ProfileOf<UserSummaryDto> {
            constructor() {
                super(UserSummaryDto);
            }

            protected configure(): void {
                this.useDistributedKey(UserOf)
                    .of('userId')
                    // JS: Java's whenAsync is when(...) returning a promise
                    .for('userName', c => c
                        .when(async ctx => ctx.service(Flags)!.emailAsName)
                        .expression('UserEmail')
                        .otherwise('Country.Name'));
            }
        }
        const m = createDistributedMapper({
            profiles: [new Profile()], requestClient: client, logger: silent,
            services: type => type === Flags ? new Flags(false) : undefined,
        });
        const dto = new UserSummaryDto(BOB);

        await m.map(dto);

        expect(dto.userName).toBe('Japan');
    });

    it('throwsTheExpressionsTheOwnerCouldNotEvaluate', async () => {
        const failing: RequestClient = {
            request: async () => ({ items: [], errors: [{ expression: 'Country.Name', message: 'boom' }] }),
        };
        const m = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: failing, throwIfException: true,
        });

        const result = m.map(new UserSummaryDto(ALICE));

        await expect(result).rejects.toBeInstanceOf(ExpressionsFailedError);
        await expect(result).rejects.toThrow('Country.Name');
    });

    it('withoutThrowIfExceptionSkipsOnlyThePropertiesOfAFailedExpression', async () => {
        const partly: RequestClient = {
            request: async (key, request, context) => {
                const response = await client.request(key, request, context);
                return { items: response.items, errors: [{ expression: 'Country.Name', message: 'boom' }] };
            },
        };
        const m = createDistributedMapper({ profiles: [new UserSummaryProfile()], requestClient: partly, logger: silent });
        const dto = new UserSummaryDto(ALICE);

        await m.map(dto);

        expect(dto.userName).toBe('Alice');
        expect(dto.countryName).toBeNull();
    });

    it('failedRequestsAreThrownOrSkipped', async () => {
        const down: RequestClient = { request: () => Promise.reject(new Error('down')) };
        const throwing = createDistributedMapper({
            profiles: [new UserSummaryProfile()], requestClient: down, throwIfException: true,
        });
        const lenient = createDistributedMapper({ profiles: [new UserSummaryProfile()], requestClient: down, logger: silent });
        const dto = new UserSummaryDto(ALICE);

        await expect(throwing.map(dto)).rejects.toThrow(new Error('down'));
        await lenient.map(dto);
        expect(dto.userName).toBeNull();
    });

    it('aValueThatDoesNotFitThePropertyIsThrownOrSkipped', async () => {
        // JS: the value does not fit when the convert of the rule throws
        client.value(USER, ALICE, 'Birthday', '"not a date"');
        const dto = new UserDetailDto(ALICE);

        const result = mapper(new UserDetailProfile()).map(dto);

        await expect(result).rejects.toBeInstanceOf(ValueWriteFailedError);
        await expect(result).rejects.toThrow('birthday');
        await createDistributedMapper({ profiles: [new UserDetailProfile()], requestClient: client, logger: silent })
            .map(dto);
        expect(dto.birthday).toBeNull();
    });

    class Node {
        id: string | null;
        next: Node | null = null;

        constructor(id: string | null = null) {
            this.id = id;
        }
    }

    class NodeProfile extends ProfileOf<Node> {
        constructor() {
            super(Node);
        }

        protected configure(): void {
            // JS: convert makes the written value a Node, which has a profile
            this.useDistributedKey(UserOf).of('id')
                .for('next', 'Next', { convert: value => Object.assign(new Node(), value) });
        }
    }

    it('stopsAtTheMaximumNestingDepth', async () => {
        // Each node maps to another node that needs mapping: an endless chain
        client.value(USER, ALICE, 'Next', `{"id":"${ALICE}"}`);

        const throwing = createDistributedMapper({
            profiles: [new NodeProfile()], requestClient: client, throwIfException: true, maxNestingDepth: 3,
        });
        await expect(throwing.map(new Node(ALICE))).rejects.toBeInstanceOf(MaxNestingDepthReachedError);

        client.sent.length = 0;
        const node = new Node(ALICE);
        await createDistributedMapper({ profiles: [new NodeProfile()], requestClient: client, maxNestingDepth: 3 })
            .map(node);
        expect(client.sent).toHaveLength(3);
        expect(node.next!.next!.next).not.toBeNull();
        expect(node.next!.next!.next!.next).toBeNull();
    });

    it('fetchSendsDistinctIdsAndExpressions', async () => {
        const response = await mapper(new UserSummaryProfile()).fetch(USER, {
            // JS: a null id is outside the types, but is dropped as in Java
            selectorIds: [ALICE, ALICE, null as unknown as string],
            expressions: [null, null, 'UserEmail'],
        });

        expect(client.sent[0].request.selectorIds).toEqual([ALICE]);
        expect(client.sent[0].request.expressions).toEqual([null, 'UserEmail']);
        expect(response.items).toHaveLength(1);
    });

    it('anObjectWithoutProfileIsLeftAlone', async () => {
        await mapper(new UserSummaryProfile()).map(['text', 42, {}]);

        expect(client.sent).toHaveLength(0);
    });

    it('mapsOnlyTheChosenPropertiesOfTheObjects', async () => {
        const dtos = [new UserSummaryDto(ALICE), new UserSummaryDto(BOB)];

        await mapper(new UserSummaryProfile()).mapProperties(dtos, new Set(['userEmail']), { headers: { h: 'v' } });

        expect(client.sent).toHaveLength(1);
        expect(client.sent[0].request.expressions).toEqual(['UserEmail']);
        expect(client.sent[0].context.headers).toHaveProperty('h', 'v');
        expect(dtos.map(d => d.userEmail)).toEqual(['alice@example.com', 'bob@example.com']);
        expect(dtos.map(d => d.userName)).toEqual([null, null]);
    });

    it('mapsTheRulesThatFillTheKeysOfTheChosenProperties', async () => {
        client.value(USER, ALICE, 'ProvinceId', '7').value(PROVINCE, 7, null, '"Hanoi"');
        const member = new MemberDto(ALICE);

        await mapper(new MemberProfile()).mapProperties([member], new Set(['provinceName']));

        expect(client.sent.map(s => s.key)).toEqual([USER, PROVINCE]);
        expect(member.provinceName).toBe('Hanoi');
    });

    it('mappingChosenPropertiesLeavesTheObjectsOfTheValuesAlone', async () => {
        client.value(USER, ALICE, 'Summary', `{"userId":"${BOB}"}`);
        const dto = new UserDetailDto(ALICE);

        await mapper(new UserDetailProfile(), new UserSummaryProfile())
            .mapProperties([dto], new Set(['summary', 'unknown']));

        expect(dto.summary!.userId).toBe(BOB);
        expect(dto.summary!.userName).toBeNull();
        expect(client.sent).toHaveLength(1);
    });

    it('mappingChosenPropertiesSkipsNullsRepeatsAndObjectsWithoutProfile', async () => {
        const dto = new UserSummaryDto(ALICE);

        await mapper(new UserSummaryProfile()).mapProperties([dto, null, dto, 'text'], new Set(['userName']));

        expect(client.sent).toHaveLength(1);
        expect(client.sent[0].request.selectorIds).toEqual([ALICE]);
        expect(dto.userName).toBe('Alice');
    });

    it('aFailedChosenMappingCompletesExceptionally', async () => {
        const failing = createDistributedMapper({
            profiles: [new UserSummaryProfile()],
            requestClient: {
                request: () => {
                    throw new Error('down');
                },
            },
            throwIfException: true,
        });

        await expect(failing.mapProperties([new UserSummaryDto(ALICE)], new Set(['userName']))).rejects.toThrow('down');
    });

    it('listsTheMappedPropertiesOfEachProfiledType', () => {
        const mapped = mapper(new UserSummaryProfile(), new MemberProfile()).mappedProperties();

        expect(new Set(mapped.keys())).toEqual(new Set([UserSummaryDto, MemberDto]));
        expect([...mapped.get(UserSummaryDto)!]).toEqual(['userName', 'userEmail', 'countryName']);
        expect(new Set(mapped.get(MemberDto))).toEqual(new Set(['provinceId', 'provinceName']));
    });

    // Not ported: anotherMapperMapsEverythingForChosenPropertiesAndListsNoProperty. It tests the default methods of
    // the Java DistributedMapper interface; DistributedMapper is a TS interface, which has no default methods.
});
