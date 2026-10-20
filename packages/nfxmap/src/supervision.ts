import type { RequestServer } from './transport.js';

/**
 * Which servers a {@link ServerSupervisor} starts again when one fails, as in Erlang/OTP and Akka: `oneForOne` only the
 * server that failed (independent servers), `oneForAll` every server (servers that only work together), `restForOne`
 * the server that failed and those registered after it (servers that depend on the earlier ones).
 */
export type SupervisionStrategy = 'oneForOne' | 'oneForAll' | 'restForOne';

/**
 * What a {@link ServerSupervisor} does with a server that failed: `resume` nothing (the failure is only logged),
 * `restart` start it again after a backoff, `stop` leave it stopped, `escalate` leave it stopped and report the failure
 * as one that needs someone to look at it.
 */
export type SupervisorDirective = 'resume' | 'restart' | 'stop' | 'escalate';

/**
 * The health of a supervised server: `healthy` running, `degraded` failed and about to be started again, `unhealthy`
 * failed and not started again (the failure was resumed), `circuitOpen` failed too many times in a row and not started
 * again before the circuit breaker closes, `stopped` stopped for good (its directive said so, or it was restarted too
 * many times) or not started.
 */
export type ServerHealth = 'healthy' | 'degraded' | 'unhealthy' | 'circuitOpen' | 'stopped';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ErrorType = abstract new (...args: any[]) => unknown;

/**
 * How a {@link ServerSupervisor} handles failures (FxMap's `SupervisorOptions`). The defaults are FxMap's: restart only
 * the server that failed, at most 32 times a minute, after a backoff from 1 second doubling up to 5 minutes; after 3
 * failures in a row the circuit breaker opens for a minute.
 */
export interface SupervisorOptions {
    /** Which servers start again when one fails; `oneForOne` by default. */
    readonly strategy?: SupervisionStrategy;
    /** The restarts allowed within `maxRestartWindowMs` (default 32); beyond, the server stops for good. */
    readonly maxRestarts?: number;
    /** The window the restarts are counted in, in milliseconds (default 1 minute); they are forgotten after it. */
    readonly maxRestartWindowMs?: number;
    /** The delay before the first restart, in milliseconds (default 1 second). */
    readonly initialBackoffMs?: number;
    /** The longest delay between restarts, in milliseconds (default 5 minutes). */
    readonly maxBackoffMs?: number;
    /** What the delay is multiplied by after each restart (default 2). */
    readonly backoffMultiplier?: number;
    /** Whether failures in a row open the circuit breaker (default true). */
    readonly circuitBreaker?: boolean;
    /** The failures in a row that open it (default 3). */
    readonly circuitBreakerThreshold?: number;
    /** How long it stays open, in milliseconds (default 1 minute). */
    readonly circuitBreakerResetMs?: number;
    /**
     * The directive of each error class: the exact class first, then the first class the failure is an instance of;
     * `restart` for the others, but an `AbortError`, which stops the server as FxMap stops on a cancellation.
     */
    readonly directives?: Iterable<readonly [ErrorType, SupervisorDirective]>;
    /** Where the supervisor reports what it does; the console by default. */
    readonly logger?: SupervisorLogger;
}

export interface SupervisorLogger {
    info(message: string): void;
    warn(message: string, error?: unknown): void;
    error(message: string, error?: unknown): void;
}

/** What a {@link ServerSupervisor} knows of a server, at one moment. */
export interface ServerState {
    /** The id the server was registered with. */
    readonly serverId: string;
    readonly health: ServerHealth;
    /** Its restarts within the current window. */
    readonly restartCount: number;
    /** Its failures since the circuit breaker or the window last reset. */
    readonly consecutiveFailures: number;
    /** Its last failure, or `null`. */
    readonly lastFailure: unknown;
    /** When it last failed, or `null`. */
    readonly lastFailureTime: Date | null;
    /** The delay before its next restart, in milliseconds. */
    readonly currentBackoffMs: number;
    /** When its circuit breaker closes, or `null` when it is not open. */
    readonly circuitResetTime: Date | null;
}

/** A server of a {@link ServerSupervisor} changed health. */
export interface ServerHealthChange {
    readonly serverId: string;
    readonly previous: ServerHealth;
    readonly current: ServerHealth;
    /** Its last failure, or `null` when it has not failed. */
    readonly failure: unknown;
    readonly at: Date;
}

const DEFAULTS = {
    strategy: 'oneForOne' as SupervisionStrategy,
    maxRestarts: 32,
    maxRestartWindowMs: 60_000,
    initialBackoffMs: 1_000,
    maxBackoffMs: 300_000,
    backoffMultiplier: 2,
    circuitBreaker: true,
    circuitBreakerThreshold: 3,
    circuitBreakerResetMs: 60_000,
};

type Settings = typeof DEFAULTS & { readonly directives: ReadonlyMap<ErrorType, SupervisorDirective> };

const STRATEGIES: readonly SupervisionStrategy[] = ['oneForOne', 'oneForAll', 'restForOne'];
const DIRECTIVES: readonly SupervisorDirective[] = ['resume', 'restart', 'stop', 'escalate'];

function settingsOf(options: SupervisorOptions): Settings {
    const settings = {
        strategy: options.strategy ?? DEFAULTS.strategy,
        maxRestarts: options.maxRestarts ?? DEFAULTS.maxRestarts,
        maxRestartWindowMs: options.maxRestartWindowMs ?? DEFAULTS.maxRestartWindowMs,
        initialBackoffMs: options.initialBackoffMs ?? DEFAULTS.initialBackoffMs,
        maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
        backoffMultiplier: options.backoffMultiplier ?? DEFAULTS.backoffMultiplier,
        circuitBreaker: options.circuitBreaker ?? DEFAULTS.circuitBreaker,
        circuitBreakerThreshold: options.circuitBreakerThreshold ?? DEFAULTS.circuitBreakerThreshold,
        circuitBreakerResetMs: options.circuitBreakerResetMs ?? DEFAULTS.circuitBreakerResetMs,
        directives: new Map<ErrorType, SupervisorDirective>(),
    };
    if (!STRATEGIES.includes(settings.strategy)) throw new RangeError(`Unknown strategy '${settings.strategy}'.`);
    if (!Number.isInteger(settings.maxRestarts) || settings.maxRestarts < 0)
        throw new RangeError('maxRestarts must be a whole number, not negative.');
    if (!(settings.maxRestartWindowMs > 0)) throw new RangeError('maxRestartWindowMs must be positive.');
    if (!(settings.initialBackoffMs >= 0)) throw new RangeError('initialBackoffMs must not be negative.');
    if (!(settings.maxBackoffMs >= 0)) throw new RangeError('maxBackoffMs must not be negative.');
    if (!(settings.backoffMultiplier >= 1)) throw new RangeError('backoffMultiplier must be at least 1.');
    if (!Number.isInteger(settings.circuitBreakerThreshold) || settings.circuitBreakerThreshold < 1)
        throw new RangeError('circuitBreakerThreshold must be a whole number, at least 1.');
    if (!(settings.circuitBreakerResetMs >= 0)) throw new RangeError('circuitBreakerResetMs must not be negative.');
    for (const [type, directive] of options.directives ?? []) {
        if (typeof type !== 'function') throw new TypeError('The error class of a directive is required.');
        if (!DIRECTIVES.includes(directive)) throw new RangeError(`Unknown directive '${directive}'.`);
        settings.directives.set(type, directive);
    }
    return settings;
}

/**
 * The directive of a failure: the one of its exact class, then of the first class it is an instance of; `stop` for an
 * `AbortError` (FxMap stops on a cancellation) and `restart` for the others.
 */
function directiveOf(failure: unknown, directives: ReadonlyMap<ErrorType, SupervisorDirective>):
    SupervisorDirective {
    if (failure !== null && typeof failure === 'object') {
        const exact = directives.get((failure as object).constructor as ErrorType);
        if (exact !== undefined) return exact;
        for (const [type, directive] of directives) if (failure instanceof type) return directive;
        if ((failure as { name?: unknown }).name === 'AbortError') return 'stop';
    }
    return 'restart';
}

interface Supervised {
    readonly serverId: string;
    readonly server: RequestServer;
    health: ServerHealth;
    restartCount: number;
    consecutiveFailures: number;
    windowStart: number | null;
    lastFailure: unknown;
    lastFailureTime: number | null;
    currentBackoffMs: number;
    circuitResetTime: number | null;
    // Each start is a new run; what an earlier run reports is ignored
    generation: number;
}

/**
 * Starts the {@link RequestServer}s of a service and starts them again when they fail (FxMap's `ServerSupervisor`): a
 * server that cannot start, or that stops on its own because of a failure, gets the {@link SupervisorDirective} of
 * its failure. A restart waits for a backoff that grows after each restart; the restarts are limited within a window,
 * and failures in a row open a circuit breaker that holds the restarts for a while.
 *
 * ```ts
 * const supervisor = new ServerSupervisor()
 *     .register('kafka', kafkaServer)
 *     .register('rabbitmq', rabbitMqServer);
 * await supervisor.start();
 * // When the application stops:
 * await supervisor.close();
 * ```
 *
 * What the supervisor does runs one step at a time, so a server is never started and stopped at once.
 */
export class ServerSupervisor {
    private readonly settings: Settings;
    private readonly logger: SupervisorLogger;
    // In the order of registration, which restForOne follows
    private readonly servers = new Map<string, Supervised>();
    private readonly listeners: ((change: ServerHealthChange) => void)[] = [];
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private queue: Promise<unknown> = Promise.resolve();
    private running = false;
    private closed = false;

    constructor(options: SupervisorOptions = {}) {
        this.settings = settingsOf(options);
        this.logger = options.logger ?? console;
    }

    get strategy(): SupervisionStrategy {
        return this.settings.strategy;
    }

    /** The directive of a failure, with the directives of the options. */
    directiveOf(failure: unknown): SupervisorDirective {
        return directiveOf(failure, this.settings.directives);
    }

    /**
     * Supervises a server; one registered while the supervisor runs is started at once, in the background.
     *
     * @throws Error when the id is already registered
     */
    register(serverId: string, server: RequestServer): this {
        if (typeof serverId !== 'string' || serverId === '') throw new TypeError('The server id is required.');
        if (server === null || server === undefined) throw new TypeError('The server is required.');
        if (this.servers.has(serverId)) throw new Error(`A server is already registered as '${serverId}'.`);
        const state: Supervised = {
            serverId, server, health: 'stopped', restartCount: 0, consecutiveFailures: 0, windowStart: null,
            lastFailure: null, lastFailureTime: null, currentBackoffMs: this.settings.initialBackoffMs,
            circuitResetTime: null, generation: 0,
        };
        this.servers.set(serverId, state);
        if (this.running) void this.run(() => this.startServer(state));
        return this;
    }

    /** Called with each change of health. */
    onHealthChange(listener: (change: ServerHealthChange) => void): this {
        if (typeof listener !== 'function') throw new TypeError('The listener is required.');
        this.listeners.push(listener);
        return this;
    }

    /**
     * Starts the servers, and resolves once each one has started or failed: one that cannot start is restarted in the
     * background, as its directive says. Does nothing when the supervisor already runs.
     */
    start(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('The supervisor is closed.'));
        return this.run(async () => {
            if (this.running) return;
            this.running = true;
            this.logger.info(`Starting ${this.servers.size} server(s) with the ${this.strategy} strategy.`);
            for (const state of [...this.servers.values()]) await this.startServer(state);
        });
    }

    /** Stops the servers and the pending restarts; the supervisor can start again. */
    stop(): Promise<void> {
        if (this.closed) return Promise.resolve();
        return this.run(async () => {
            if (!this.running) return;
            this.running = false;
            for (const timer of this.timers) clearTimeout(timer);
            this.timers.clear();
            for (const state of [...this.servers.values()]) {
                state.generation++;
                await this.closeQuietly(state);
                state.circuitResetTime = null;
                this.setHealth(state, 'stopped');
            }
            this.logger.info('The supervisor stopped.');
        });
    }

    isRunning(): boolean {
        return this.running;
    }

    /** What the supervisor knows of each server, by id, in the order of registration. */
    states(): ReadonlyMap<string, ServerState> {
        const states = new Map<string, ServerState>();
        for (const state of this.servers.values()) {
            states.set(state.serverId, {
                serverId: state.serverId,
                health: state.health,
                restartCount: state.restartCount,
                consecutiveFailures: state.consecutiveFailures,
                lastFailure: state.lastFailure,
                lastFailureTime: state.lastFailureTime === null ? null : new Date(state.lastFailureTime),
                currentBackoffMs: state.currentBackoffMs,
                circuitResetTime: state.circuitResetTime === null ? null : new Date(state.circuitResetTime),
            });
        }
        return states;
    }

    /** Stops the servers; the supervisor cannot start again. */
    async close(): Promise<void> {
        if (this.closed) return;
        await this.stop();
        this.closed = true;
    }

    // One step at a time: a step waits for the previous ones, and a failed step does not stop the next ones
    private run<T>(step: () => Promise<T>): Promise<T> {
        const result = this.queue.then(step);
        this.queue = result.catch(() => undefined);
        return result;
    }

    private schedule(delayMs: number, step: () => Promise<void>): void {
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            void this.run(step);
        }, delayMs);
        this.timers.add(timer);
    }

    private async startServer(state: Supervised): Promise<void> {
        if (!this.running) return;
        const generation = ++state.generation;
        this.setHealth(state, 'healthy');
        try {
            await state.server.start();
        } catch (error) {
            this.failed(state, generation, error);
            return;
        }
        state.server.whenStopped().then(undefined,
            (failure: unknown) => this.run(async () => this.failed(state, generation, failure)));
    }

    private failed(state: Supervised, generation: number, failure: unknown): void {
        // A failure of a run that was stopped or replaced since is not this run's
        if (!this.running || generation !== state.generation) return;
        state.lastFailure = failure;
        state.lastFailureTime = Date.now();
        state.consecutiveFailures++;
        const directive = this.directiveOf(failure);
        this.logger.warn(`The server ${state.serverId} failed (${state.consecutiveFailures} in a row); directive: `
            + `${directive}.`, failure);
        switch (directive) {
            case 'resume':
                this.setHealth(state, 'unhealthy');
                break;
            case 'restart':
                this.restart(state);
                break;
            case 'stop':
                this.setHealth(state, 'stopped');
                this.logger.warn(`The server ${state.serverId} is stopped for good.`);
                break;
            case 'escalate':
                this.setHealth(state, 'stopped');
                this.logger.error(`The failure of the server ${state.serverId} needs someone to look at it: it is `
                    + 'stopped.', failure);
                break;
        }
    }

    private restart(state: Supervised): void {
        const settings = this.settings;
        const now = Date.now();
        // Stable for longer than the window: the earlier restarts are forgotten
        if (state.windowStart !== null && now - state.windowStart > settings.maxRestartWindowMs) {
            state.restartCount = 0;
            state.consecutiveFailures = 1;
            state.windowStart = null;
            state.currentBackoffMs = settings.initialBackoffMs;
        }
        if (state.windowStart === null) state.windowStart = now;
        state.restartCount++;

        if (state.restartCount > settings.maxRestarts) {
            this.setHealth(state, 'stopped');
            this.logger.error(`The server ${state.serverId} was restarted more than ${settings.maxRestarts} times `
                + `within ${settings.maxRestartWindowMs} ms: it is stopped for good.`);
            return;
        }

        if (settings.circuitBreaker && state.consecutiveFailures >= settings.circuitBreakerThreshold) {
            state.circuitResetTime = now + settings.circuitBreakerResetMs;
            this.setHealth(state, 'circuitOpen');
            this.logger.warn(`The circuit breaker of the server ${state.serverId} is open until `
                + `${new Date(state.circuitResetTime).toISOString()}.`);
            const generation = state.generation;
            this.schedule(settings.circuitBreakerResetMs, async () => {
                if (!this.running || generation !== state.generation) return;
                state.consecutiveFailures = 0;
                state.circuitResetTime = null;
                this.logger.info(`The circuit breaker of the server ${state.serverId} is closed.`);
                this.restartAfterBackoff(state);
            });
            return;
        }
        this.restartAfterBackoff(state);
    }

    private restartAfterBackoff(state: Supervised): void {
        const settings = this.settings;
        this.setHealth(state, 'degraded');
        const backoff = state.currentBackoffMs;
        this.logger.info(`Restarting the server ${state.serverId} in ${backoff} ms (restart ${state.restartCount} of `
            + `${settings.maxRestarts}).`);
        const generation = state.generation;
        this.schedule(backoff, async () => {
            if (!this.running || generation !== state.generation) return;
            state.currentBackoffMs = Math.max(0, Math.min(backoff * settings.backoffMultiplier, settings.maxBackoffMs));
            const all = [...this.servers.values()];
            switch (settings.strategy) {
                case 'oneForOne':
                    await this.closeQuietly(state);
                    await this.startServer(state);
                    break;
                case 'oneForAll':
                    await this.restartFrom(all, 0);
                    break;
                case 'restForOne':
                    await this.restartFrom(all, all.indexOf(state));
                    break;
            }
        });
    }

    private async restartFrom(all: readonly Supervised[], index: number): Promise<void> {
        if (index < 0) return;
        const restarted = all.slice(index);
        this.logger.info(`Restarting the servers ${restarted.map(state => state.serverId).join(', ')}.`);
        for (const state of restarted) {
            state.generation++;
            await this.closeQuietly(state);
        }
        for (const state of restarted) await this.startServer(state);
    }

    private async closeQuietly(state: Supervised): Promise<void> {
        try {
            await state.server.close();
        } catch (error) {
            this.logger.warn(`The server ${state.serverId} did not close.`, error);
        }
    }

    private setHealth(state: Supervised, health: ServerHealth): void {
        const previous = state.health;
        if (previous === health) return;
        state.health = health;
        this.logger.info(`The server ${state.serverId} is ${health} (was ${previous}).`);
        const change: ServerHealthChange = {
            serverId: state.serverId, previous, current: health, failure: state.lastFailure, at: new Date(),
        };
        for (const listener of this.listeners) {
            try {
                listener(change);
            } catch (error) {
                this.logger.warn('A health listener failed.', error);
            }
        }
    }
}
