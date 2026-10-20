import { describe, expect, it } from 'vitest';
import { createDistributedMapper, defineEntity, defineProfile, InMemoryQueryHandler, LocalRequestClient, NoProfileError } from '../src/index.js';

class OrderDto {
    userId: string | null = null;
    userName: string | null = null;
}

interface PlainOrder {
    userId: string;
    userName?: string;
}

const users = new InMemoryQueryHandler(
    defineEntity<{ id: string; name: string }>('User', { key: 'UserOf', id: 'id', defaultProperty: 'name' }),
    [{ id: '1', name: 'Ann' }, { id: '2', name: 'Bob' }]);

describe('plain objects', () => {
    it('looks into a plain envelope for the objects with a profile', async () => {
        const mapper = createDistributedMapper({
            profiles: [defineProfile(OrderDto, p => p.useDistributedKey('UserOf').of('userId').for('userName'))],
            requestClient: new LocalRequestClient(users),
        });
        const order = Object.assign(new OrderDto(), { userId: '2' });
        await mapper.map({ data: { items: [order] }, total: 1 });
        expect(order.userName).toBe('Bob');
    });

    it('maps plain objects with a named profile', async () => {
        const mapper = createDistributedMapper({
            profiles: [defineProfile<PlainOrder>('PlainOrder', p => p.useDistributedKey('UserOf').of('userId').for('userName'))],
            requestClient: new LocalRequestClient(users),
            throwIfException: true,
        });
        const orders: PlainOrder[] = [{ userId: '1' }, { userId: '2' }];
        await mapper.mapAs('PlainOrder', orders);
        expect(orders.map(o => o.userName)).toEqual(['Ann', 'Bob']);
        await expect(mapper.mapAs('Unknown', orders)).rejects.toBeInstanceOf(NoProfileError);
    });
});
