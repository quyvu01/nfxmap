import { ProfileOf } from 'nfxmap';
import type { Order } from './orders.js';

/** An order with its user's fields, which nfxmap fills from the user service. */
export class OrderResponse {
    readonly id: number;
    readonly product: string;
    readonly total: number;
    readonly userId: string;
    userName: string | null = null;
    userEmail: string | null = null;
    userCountry: string | null = null;
    userNameUpper: string | null = null;
    userAddressCount: number | null = null;

    constructor(order: Order) {
        this.id = order.id;
        this.product = order.product;
        this.total = order.total;
        this.userId = order.userId;
    }
}

/** Which user fields an order shows, read from the user service by the 'UserOf' key. */
export class OrderResponseProfile extends ProfileOf<OrderResponse> {
    constructor() {
        super(OrderResponse);
    }

    protected configure(): void {
        this.useDistributedKey('UserOf')
            .of('userId')
            .for('userName')                              // the default property
            .for('userEmail', 'UserEmail')                // an exposed name
            .for('userCountry', 'Country?.Name')          // a navigation
            .for('userNameUpper', 'Name:upper')           // a function
            .for('userAddressCount', 'Addresses:count');  // a collection
    }
}
