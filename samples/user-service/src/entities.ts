import { Column, Entity, ManyToOne, OneToMany, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Country {
    @PrimaryColumn('varchar')
    code!: string;

    @Column('varchar')
    name!: string;
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

    @OneToMany(() => Address, address => address.user)
    addresses!: Address[];
}

@Entity()
export class Address {
    @PrimaryGeneratedColumn()
    id!: number;

    @Column('varchar')
    city!: string;

    @ManyToOne(() => User, user => user.addresses)
    user!: User;
}
