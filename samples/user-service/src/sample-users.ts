import type { DataSource } from 'typeorm';
import { Address, Country, User } from './entities.js';

// The same users as the samples of jfxmap, so that its order service can be served by this one
export const ALICE = '0b6e1b9a-55b1-4c5e-9f57-0a3c3a0d7e11';
export const BOB = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
export const CAROL = 'c3a1e5b2-0d4f-4e6a-9b8c-7d2e1f0a3b4c';

/** Seeds the users that the order service's sample orders refer to. */
export async function seedUsers(dataSource: DataSource): Promise<void> {
    const countries = dataSource.getRepository(Country);
    const users = dataSource.getRepository(User);
    const addresses = dataSource.getRepository(Address);
    const vietnam = await countries.save({ code: 'VN', name: 'Vietnam' });
    const france = await countries.save({ code: 'FR', name: 'France' });
    const alice = await users.save({ id: ALICE, name: 'Alice Nguyen', email: 'alice@example.com', country: vietnam });
    const bob = await users.save({ id: BOB, name: 'Bob Martin', email: 'bob@example.com', country: france });
    await users.save({ id: CAROL, name: 'Carol Tran', email: 'carol@example.com', country: null });
    await addresses.save([{ city: 'Hanoi', user: alice }, { city: 'Da Nang', user: alice }, { city: 'Lyon', user: bob }]);
}
