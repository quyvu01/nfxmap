import { DistributedKey, ProfileOf } from '../src/index.js';

/** The keys, entities, DTOs and profiles shared by the tests. Ported from jfxmap's Models. */

export class UserOf extends DistributedKey {
}

export class Country {
    constructor(readonly name: string, readonly code: string) {
    }
}

export class UserSummaryDto {
    userId: string | null;
    userName: string | null = null;
    userEmail: string | null = null;
    countryName: string | null = null;

    constructor(userId: string | null = null) {
        this.userId = userId;
    }
}

export class UserSummaryProfile extends ProfileOf<UserSummaryDto> {
    constructor() {
        super(UserSummaryDto);
    }

    protected configure(): void {
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('userName')
            .for('userEmail', 'UserEmail')
            .for('countryName', 'Country.Name');
    }
}

/** Two levels: the province id comes from the user, the province name from the province. */
export class MemberDto {
    userId: string | null;
    provinceId: number | null = null;
    provinceName: string | null = null;

    constructor(userId: string | null) {
        this.userId = userId;
    }
}

export class MemberProfile extends ProfileOf<MemberDto> {
    constructor() {
        super(MemberDto);
    }

    protected configure(): void {
        // Declared before the rule that fills its key: the order does not matter
        this.useDistributedKey('ProvinceOf')
            .of('provinceId')
            .for('provinceName');
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('provinceId', 'ProvinceId');
    }
}

/** Values of several types, and a property of a type that has its own profile. */
export class UserDetailDto {
    userId: string | null;
    birthday: Date | null = null;
    country: Country | null = null;
    tags: string[] | null = null;
    summary: UserSummaryDto | null = null;

    constructor(userId: string | null) {
        this.userId = userId;
    }
}

/** A date from an ISO string (`1990-04-30`), as Jackson reads a LocalDate. */
export function toDate(value: unknown): Date {
    const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) throw new RangeError(`${JSON.stringify(value)} is not a date`);
    return date;
}

export class UserDetailProfile extends ProfileOf<UserDetailDto> {
    constructor() {
        super(UserDetailDto);
    }

    protected configure(): void {
        // JS: the values are written as parsed from JSON; `convert` turns them into the types Java reads them as
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('birthday', 'Birthday', { convert: toDate })
            .for('country', 'Country', {
                convert: value => {
                    const country = value as { Name: string; Code: string };
                    return new Country(country.Name, country.Code);
                },
            })
            .for('tags', 'Tags')
            .for('summary', 'Summary', { convert: value => Object.assign(new UserSummaryDto(), value) });
    }
}

/** A DTO without a profile of its own, holding DTOs that have one. */
export class PageDto {
    readonly items: UserSummaryDto[] = [];
    byName: Map<string, UserSummaryDto> | null = null;
    pinned: UserSummaryDto[] | null = null;
    featured: UserSummaryDto | null = null;
}

export class PageProfile extends ProfileOf<PageDto> {
    constructor() {
        super(PageDto);
    }

    protected configure(): void {
    }
}
