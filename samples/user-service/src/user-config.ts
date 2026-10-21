import { EntityConfigureOf } from 'nfxmap';
import { User } from './entities.js';

/**
 * What the user service exposes. The string key 'UserOf' is the one a .NET service declares with
 * `UseDistributedKey("UserOf")` and a Java one with `useDistributedKey("UserOf")`, so any of them can call this service.
 */
export class UserConfig extends EntityConfigureOf<User> {
    constructor() {
        super(User);
    }

    protected configure(): void {
        this.id('id');
        this.defaultProperty('name');
        this.useDistributedKey('UserOf');
        this.exposedName('email', 'UserEmail');
    }
}
