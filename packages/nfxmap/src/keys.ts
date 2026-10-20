import { DistributedKeyNullOrEmptyError, InvalidDistributedKeyNameError } from './errors.js';

/**
 * A marker for the classes that name a distributed key, shared by the owner of an entity and its consumers:
 * `class UserOf extends DistributedKey {}`. Any class works; the key is the name of the class.
 */
export abstract class DistributedKey {
}

/**
 * A distributed key: a string (`'UserOf'`), or a class whose name is the key (`UserOf`). A string survives bundlers
 * that rename classes, and is what a .NET or Java service uses on the other side (`UseDistributedKey("UserOf")`).
 */
export type DistributedKeyLike = string | (abstract new (...args: never[]) => unknown);

const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * The name of a distributed key.
 *
 * @throws DistributedKeyNullOrEmptyError when the key is null or blank
 * @throws InvalidDistributedKeyNameError when the key is not a (dotted) identifier
 */
export function keyName(key: DistributedKeyLike): string {
    const name = typeof key === 'function' ? key.name : key;
    if (typeof name !== 'string' || name.trim().length === 0) throw new DistributedKeyNullOrEmptyError();
    if (!VALID_NAME.test(name)) throw new InvalidDistributedKeyNameError(name);
    return name;
}
