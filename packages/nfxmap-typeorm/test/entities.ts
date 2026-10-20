import { Column, Entity, ManyToOne, OneToMany, PrimaryColumn } from 'typeorm';
import { DataSource, type DataSourceOptions } from 'typeorm';

export class Address {
    @Column('varchar', { nullable: true })
    city!: string | null;
}

@Entity()
export class Country {
    @PrimaryColumn('int')
    id!: number;

    @Column('varchar')
    name!: string;
}

@Entity()
export class Product {
    @PrimaryColumn('int')
    id!: number;

    /** A natural key, which is not the primary key. */
    @Column('varchar', { unique: true })
    code!: string;

    @Column('varchar')
    title!: string;
}

@Entity({ name: 'app_user' })
export class User {
    @PrimaryColumn('uuid')
    id!: string;

    @Column('varchar')
    name!: string;

    @Column('varchar')
    email!: string;

    @ManyToOne(() => Country, { nullable: true })
    country!: Country | null;

    @OneToMany(() => PurchaseOrder, order => order.user)
    orders!: PurchaseOrder[];

    @Column('int', { default: 0 })
    age!: number;

    @Column('float', { nullable: true })
    score!: number | null;

    @Column('varchar', { nullable: true })
    level!: string | null;

    @Column(() => Address)
    address!: Address;

    @Column('simple-json', { nullable: true })
    tags!: string[] | null;

    /** Not a column: computed from the name. */
    get nickname(): string {
        return this.name.toLowerCase();
    }
}

@Entity()
export class PurchaseOrder {
    @PrimaryColumn('int')
    id!: number;

    @Column('varchar')
    status!: string;

    @Column('int')
    total!: number;

    @Column('int', { default: 1 })
    quantity!: number;

    @ManyToOne(() => User, user => user.orders)
    user!: User;

    @ManyToOne(() => Product, { nullable: true })
    product!: Product | null;
}

/** An entity that is not part of the data source. */
export class Unmapped {
    id!: number;
}

export const ALICE = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
export const BOB = '0b6e1b9a-55b1-4c5e-9f57-0a3c3a0d7e11';
export const NOBODY = '00000000-0000-0000-0000-000000000001';

/** The databases the tests run on: SQLite in memory, and PostgreSQL when `PG_URL` is set (CI runs one). */
export const DATABASES: [string, DataSourceOptions][] = [
    ['sqlite', { type: 'better-sqlite3', database: ':memory:' }],
    ...(process.env.PG_URL ? [['postgres', { type: 'postgres', url: process.env.PG_URL }] as [string, DataSourceOptions]] : []),
];

export async function seededDataSource(options: DataSourceOptions): Promise<DataSource> {
    const dataSource = new DataSource({
        ...options,
        entities: [Country, Product, User, PurchaseOrder],
        synchronize: true,
        dropSchema: true,
    } as DataSourceOptions);
    await dataSource.initialize();
    const vietnam = await dataSource.getRepository(Country).save({ id: 1, name: 'Vietnam' });
    const pen = await dataSource.getRepository(Product).save({ id: 7, code: 'P-7', title: 'Pen' });
    const users = dataSource.getRepository(User);
    const alice = await users.save(users.create({
        id: ALICE, name: 'Alice', email: 'alice@example.com', country: vietnam, age: 30, score: 7.5, level: 'GOLD',
        address: { city: 'Hanoi' }, tags: ['a', 'b'],
    }));
    await users.save(users.create({
        id: BOB, name: 'Bob', email: 'bob@example.org', country: null, age: 25, score: null, level: null,
        address: { city: 'Paris' }, tags: [],
    }));
    const orders = dataSource.getRepository(PurchaseOrder);
    await orders.save([
        orders.create({ id: 1, status: 'Done', total: 10, quantity: 2, user: alice, product: pen }),
        orders.create({ id: 2, status: 'Done', total: 4, quantity: 1, user: alice, product: null }),
        orders.create({ id: 3, status: 'Open', total: 100, quantity: 5, user: alice, product: pen }),
    ]);
    return dataSource;
}
