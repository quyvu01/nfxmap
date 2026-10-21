import {
    createDistributedMapper,
    DistributedKey,
    type DistributedMapper,
    EntityConfigureOf,
    InMemoryQueryHandler,
    LocalRequestClient,
    ProfileOf,
} from 'nfxmap';

export const USERS = 1_000;
export const PROVINCES = 64;
export const PRODUCTS = 50;

export class UserOf extends DistributedKey {
}

export class ProductOf extends DistributedKey {
}

class Country {
    constructor(readonly name: string) {}
}

class Order {
    constructor(readonly status: string, readonly total: number) {}
}

class User {
    constructor(readonly id: number, readonly name: string, readonly email: string, readonly country: Country | null,
        readonly provinceId: number, readonly orders: readonly Order[]) {}
}

class Province {
    constructor(readonly id: number, readonly name: string) {}
}

class Product {
    constructor(readonly id: number, readonly name: string) {}
}

class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey(UserOf);
        this.exposedName('email', 'UserEmail');
    }
}

class ProvinceConfig extends EntityConfigureOf<Province> {
    constructor() {
        super(Province);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('ProvinceOf');
    }
}

class ProductConfig extends EntityConfigureOf<Product> {
    constructor() {
        super(Product);
    }

    protected configure() {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey(ProductOf);
    }
}

export class LineDto {
    productName: string | null = null;

    constructor(readonly productId: number) {}
}

export class OrderDto {
    userName: string | null = null;
    userEmail: string | null = null;
    countryName: string | null = null;
    doneTotal = 0;
    provinceId: number | null = null;
    provinceName: string | null = null;
    readonly lines: LineDto[] = [];

    constructor(readonly userId: number) {}
}

class OrderProfile extends ProfileOf<OrderDto> {
    constructor() {
        super(OrderDto);
    }

    protected configure() {
        this.useDistributedKey(UserOf)
            .of('userId')
            .for('userName')
            .for('userEmail', 'UserEmail')
            .for('countryName', 'Country?.Name')
            .for('doneTotal', "Orders:where(Status = 'Done'):sum(Total)")
            .for('provinceId', 'ProvinceId');
        // A chained rule: the province id comes from the user, the province name from the province
        this.useDistributedKey('ProvinceOf')
            .of('provinceId')
            .for('provinceName');
    }
}

class LineProfile extends ProfileOf<LineDto> {
    constructor() {
        super(LineDto);
    }

    protected configure() {
        this.useDistributedKey(ProductOf)
            .of('productId')
            .for('productName');
    }
}

/**
 * The whole engine in one process: a mapper over a {@link LocalRequestClient} and {@link InMemoryQueryHandler}s,
 * filling DTOs with plain properties, navigations, an aggregation, a chained rule and nested DTOs with their own
 * profile.
 */
export function createMapper(): DistributedMapper {
    const users = Array.from({ length: USERS }, (_, i) => new User(i, `User ${i}`, `user${i}@example.com`,
        i % 10 === 0 ? null : new Country(`Country ${i % 7}`), i % PROVINCES,
        [new Order('Done', i), new Order('Open', 1), new Order('Done', 2.5)]));
    const provinces = Array.from({ length: PROVINCES }, (_, i) => new Province(i, `Province ${i}`));
    const products = Array.from({ length: PRODUCTS }, (_, i) => new Product(i, `Product ${i}`));
    const client = new LocalRequestClient(
        new InMemoryQueryHandler(new UserConfig(), users),
        new InMemoryQueryHandler(new ProvinceConfig(), provinces),
        new InMemoryQueryHandler(new ProductConfig(), products));
    return createDistributedMapper({
        profiles: [new OrderProfile(), new LineProfile()],
        requestClient: client,
        throwIfException: true,
    });
}

/** New DTOs each time, as an application maps the ones it has just read. */
export function newDtos(count: number): OrderDto[] {
    const result: OrderDto[] = [];
    for (let i = 0; i < count; i++) {
        const dto = new OrderDto(i % USERS);
        dto.lines.push(new LineDto(i % PRODUCTS), new LineDto((i + 1) % PRODUCTS));
        result.push(dto);
    }
    return result;
}

export async function map(mapper: DistributedMapper, dtos: number): Promise<OrderDto[]> {
    const result = newDtos(dtos);
    await mapper.map(result);
    return result;
}
