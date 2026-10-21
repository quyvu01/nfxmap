import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startUserService, type UserService } from '../../user-service/src/app.js';
import { startOrderService, type OrderService } from '../src/app.js';

/** Both services on free ports, each with its own data, and what /orders shows. */
describe('the order service with the user service', () => {
    let users: UserService;
    let orders: OrderService;

    beforeAll(async () => {
        users = await startUserService({ httpPort: 0, grpcPort: 0 });
        orders = await startOrderService({ httpPort: 0, userService: `http://localhost:${users.grpcPort}` });
    });

    afterAll(async () => {
        await orders?.close();
        await users?.close();
    });

    const get = async (path: string) => {
        const response = await fetch(`http://localhost:${orders.httpPort}${path}`);
        return { status: response.status, body: await response.json() as Record<string, unknown> };
    };

    it('shows the fields of the user of each order', async () => {
        const { status, body } = await get('/orders');

        expect(status).toBe(200);
        expect(body).toEqual([
            {
                id: 1, product: 'Keyboard', total: 49.9, userId: '0b6e1b9a-55b1-4c5e-9f57-0a3c3a0d7e11',
                userName: 'Alice Nguyen', userEmail: 'alice@example.com', userCountry: 'Vietnam',
                userNameUpper: 'ALICE NGUYEN', userAddressCount: 2,
            },
            {
                id: 2, product: 'Monitor', total: 219, userId: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
                userName: 'Bob Martin', userEmail: 'bob@example.com', userCountry: 'France',
                userNameUpper: 'BOB MARTIN', userAddressCount: 1,
            },
            expect.objectContaining({ id: 3, userName: 'Alice Nguyen', userAddressCount: 2 }),
            // Carol has no country and no address
            expect.objectContaining({ id: 4, userName: 'Carol Tran', userCountry: null, userAddressCount: 0 }),
            // A user the user service does not know
            expect.objectContaining({ id: 5, userName: null, userEmail: null, userCountry: null, userAddressCount: null }),
        ]);
    });

    it('shows one order', async () => {
        expect(await get('/orders/2')).toEqual({ status: 200, body: expect.objectContaining({ userName: 'Bob Martin' }) });
        expect((await get('/orders/9')).status).toBe(404);
    });

    it('lists the users', async () => {
        const response = await fetch(`http://localhost:${users.httpPort}/users`);

        expect(await response.json()).toEqual([
            { id: '0b6e1b9a-55b1-4c5e-9f57-0a3c3a0d7e11', name: 'Alice Nguyen', email: 'alice@example.com', country: 'Vietnam' },
            { id: '6f9619ff-8b86-d011-b42d-00c04fc964ff', name: 'Bob Martin', email: 'bob@example.com', country: 'France' },
            { id: 'c3a1e5b2-0d4f-4e6a-9b8c-7d2e1f0a3b4c', name: 'Carol Tran', email: 'carol@example.com', country: null },
        ]);
    });
});
