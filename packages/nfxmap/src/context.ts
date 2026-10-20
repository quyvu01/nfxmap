/** Headers sent with each request of a mapping call. */
export type Headers = Readonly<Record<string, string>>;

/** Finds a service by a token (a class, a symbol, a string), or gives `undefined`. */
export type ServiceLookup = (token: unknown) => unknown;

const NO_SERVICES: ServiceLookup = () => undefined;

/**
 * What a mapping call carries with it: the headers that travel with each request, and a lookup for the services that
 * conditional expressions may need (`when(ctx => ctx.service(FeatureFlags)?.isOn('x'))`).
 */
export class MapContext {
    readonly headers: Headers;
    private readonly services: ServiceLookup;

    constructor(headers: Headers = {}, services: ServiceLookup = NO_SERVICES) {
        this.headers = Object.freeze({ ...headers });
        this.services = services;
    }

    static empty(): MapContext {
        return new MapContext();
    }

    /**
     * The same context with one more header, or with a new value for it; a `null` value removes it. The context itself
     * does not change.
     */
    withHeader(name: string, value: string | null): MapContext {
        const headers: Record<string, string> = { ...this.headers };
        if (value === null) delete headers[name];
        else headers[name] = value;
        return new MapContext(headers, this.services);
    }

    /** The service registered for the token, or `undefined`. */
    service<T>(token: abstract new (...args: never[]) => T): T | undefined;
    service<T = unknown>(token: unknown): T | undefined;
    service(token: unknown): unknown {
        return this.services(token);
    }
}
