/** An order of this service: it holds only the id of its user, who is owned by the user service. */
export interface Order {
    readonly id: number;
    readonly product: string;
    readonly total: number;
    readonly userId: string;
}

// The users of the user service, and one it does not know
const ALICE = '0b6e1b9a-55b1-4c5e-9f57-0a3c3a0d7e11';
const BOB = '6f9619ff-8b86-d011-b42d-00c04fc964ff';
const CAROL = 'c3a1e5b2-0d4f-4e6a-9b8c-7d2e1f0a3b4c';
const UNKNOWN = '00000000-0000-0000-0000-000000000000';

export const SAMPLE_ORDERS: readonly Order[] = [
    { id: 1, product: 'Keyboard', total: 49.9, userId: ALICE },
    { id: 2, product: 'Monitor', total: 219, userId: BOB },
    { id: 3, product: 'Mouse', total: 19.5, userId: ALICE },
    { id: 4, product: 'Headset', total: 89, userId: CAROL },
    { id: 5, product: 'Cable', total: 5, userId: UNKNOWN },
];
