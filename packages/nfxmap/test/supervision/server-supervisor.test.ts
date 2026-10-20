import { afterEach, describe, expect, it } from 'vitest';
import {
    type RequestServer,
    type ServerHealth,
    type ServerHealthChange,
    ServerSupervisor,
    type SupervisorLogger,
    type SupervisorOptions,
} from '../../src/index.js';

/** Ported from jfxmap's ServerSupervisorTest and SupervisorOptionsTest. */

/** A server that counts its starts and stops, and fails when a test says so. */
class FakeServer implements RequestServer {
    starts = 0;
    closes = 0;
    // The failures of the next starts, in order
    private readonly startFailures: Error[] = [];
    private run: Promise<void> = Promise.resolve();
    private end: { resolve: () => void; reject: (error: unknown) => void } | null = null;

    failNextStarts(...failures: Error[]): this {
        this.startFailures.push(...failures);
        return this;
    }

    async start(): Promise<void> {
        if (this.end !== null) return;
        this.starts++;
        const failure = this.startFailures.shift();
        if (failure !== undefined) throw failure;
        this.run = new Promise((resolve, reject) => (this.end = { resolve, reject }));
        // The supervisor only listens to the failures
        this.run.catch(() => undefined);
    }

    /** Stops on its own, as a server whose consumer was cancelled. */
    fail(failure: unknown): void {
        const end = this.end;
        if (end === null) return;
        this.end = null;
        end.reject(failure);
    }

    isRunning(): boolean {
        return this.end !== null;
    }

    whenStopped(): Promise<void> {
        return this.run;
    }

    async close(): Promise<void> {
        this.closes++;
        const end = this.end;
        if (end === null) return;
        this.end = null;
        end.resolve();
    }
}

class QueueDeleted extends Error {
    constructor() {
        super('The queue was deleted.');
    }
}

const quiet: SupervisorLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const supervisors: ServerSupervisor[] = [];
let changes: ServerHealthChange[] = [];

afterEach(async () => {
    await Promise.all(supervisors.splice(0).map(supervisor => supervisor.close()));
    changes = [];
});

/** Fast options: a 10 ms backoff, no circuit breaker unless a test turns it on. */
function supervisor(options: SupervisorOptions = {}): ServerSupervisor {
    const created = new ServerSupervisor({
        initialBackoffMs: 10, maxBackoffMs: 40, circuitBreaker: false, logger: quiet, ...options,
    }).onHealthChange(change => changes.push(change));
    supervisors.push(created);
    return created;
}

async function eventually(condition: () => boolean, waitMs = 5_000): Promise<void> {
    const deadline = Date.now() + waitMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`The condition did not hold within ${waitMs} ms`);
        await sleep(5);
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function health(supervisor: ServerSupervisor, id: string): ServerHealth | undefined {
    return supervisor.states().get(id)?.health;
}

describe('ServerSupervisor', () => {
    it('starts every server', async () => {
        const nats = new FakeServer();
        const kafka = new FakeServer();
        const supervised = supervisor().register('nats', nats).register('kafka', kafka);

        await supervised.start();

        expect(supervised.isRunning()).toBe(true);
        expect(nats.isRunning()).toBe(true);
        expect(kafka.isRunning()).toBe(true);
        expect([...supervised.states().keys()]).toEqual(['nats', 'kafka']);
        expect([...supervised.states().values()].map(state => state.health)).toEqual(['healthy', 'healthy']);
        expect(supervised.strategy).toBe('oneForOne');
    });

    it('restarts a server that fails on its own', async () => {
        const nats = new FakeServer();
        const kafka = new FakeServer();
        const supervised = supervisor().register('nats', nats).register('kafka', kafka);
        await supervised.start();

        kafka.fail(new QueueDeleted());

        await eventually(() => kafka.starts === 2 && kafka.isRunning());
        await eventually(() => health(supervised, 'kafka') === 'healthy');
        expect(nats.starts).toBe(1);
        const state = supervised.states().get('kafka')!;
        expect(state.restartCount).toBe(1);
        expect(state.consecutiveFailures).toBe(1);
        expect(state.lastFailure).toBeInstanceOf(QueueDeleted);
        expect(state.lastFailureTime).toBeInstanceOf(Date);
        const kafkaChanges = changes.filter(change => change.serverId === 'kafka').map(change => change.current);
        expect(kafkaChanges.slice(kafkaChanges.indexOf('degraded'))).toEqual(['degraded', 'healthy']);
    });

    it('restarts in the background a server that cannot start', async () => {
        const kafka = new FakeServer().failNextStarts(new Error('broker down'), new Error('broker down'));
        const supervised = supervisor().register('kafka', kafka);

        await supervised.start();

        await eventually(() => kafka.isRunning());
        expect(kafka.starts).toBe(3);
        await eventually(() => health(supervised, 'kafka') === 'healthy');
    });

    it('grows the backoff up to its maximum', async () => {
        const kafka = new FakeServer().failNextStarts(new Error('1'), new Error('2'), new Error('3'), new Error('4'));
        const supervised = supervisor().register('kafka', kafka);

        await supervised.start();

        await eventually(() => kafka.isRunning());
        expect(supervised.states().get('kafka')!.currentBackoffMs).toBe(40);
    });

    it('restarts every server with oneForAll', async () => {
        const nats = new FakeServer();
        const kafka = new FakeServer();
        const supervised = supervisor({ strategy: 'oneForAll' }).register('nats', nats).register('kafka', kafka);
        await supervised.start();

        kafka.fail(new QueueDeleted());

        await eventually(() => nats.starts === 2 && kafka.starts === 2);
        await eventually(() => nats.isRunning() && kafka.isRunning());
        expect(nats.closes).toBeGreaterThanOrEqual(1);
    });

    it('restarts the failed server and those registered after it with restForOne', async () => {
        const first = new FakeServer();
        const second = new FakeServer();
        const third = new FakeServer();
        const supervised = supervisor({ strategy: 'restForOne' })
            .register('first', first).register('second', second).register('third', third);
        await supervised.start();

        second.fail(new QueueDeleted());

        await eventually(() => second.starts === 2 && third.starts === 2);
        await eventually(() => second.isRunning() && third.isRunning());
        expect(first.starts).toBe(1);
        expect(first.isRunning()).toBe(true);
    });

    it('stops a server for good after too many restarts in the window', async () => {
        const kafka = new FakeServer();
        for (let i = 0; i < 10; i++) kafka.failNextStarts(new Error('broker down'));
        const supervised = supervisor({ maxRestarts: 2 }).register('kafka', kafka);

        await supervised.start();

        await eventually(() => health(supervised, 'kafka') === 'stopped');
        expect(kafka.starts).toBe(3);
        expect(kafka.isRunning()).toBe(false);
    });

    it('forgets the restarts after a stable window', async () => {
        const kafka = new FakeServer();
        const supervised = supervisor({ maxRestarts: 1, maxRestartWindowMs: 100 }).register('kafka', kafka);
        await supervised.start();

        kafka.fail(new QueueDeleted());
        await eventually(() => kafka.starts === 2 && kafka.isRunning());
        await sleep(200);
        kafka.fail(new QueueDeleted());

        await eventually(() => kafka.starts === 3 && kafka.isRunning());
        expect(supervised.states().get('kafka')!.restartCount).toBe(1);
    });

    it('opens the circuit breaker after failures in a row, until its reset time', async () => {
        const kafka = new FakeServer().failNextStarts(new Error('1'), new Error('2'));
        const supervised = supervisor({ circuitBreaker: true, circuitBreakerThreshold: 2, circuitBreakerResetMs: 300 })
            .register('kafka', kafka);

        await supervised.start();

        await eventually(() => health(supervised, 'kafka') === 'circuitOpen');
        expect(supervised.states().get('kafka')!.circuitResetTime).toBeInstanceOf(Date);
        expect(kafka.starts).toBe(2);
        await eventually(() => kafka.isRunning());
        expect(kafka.starts).toBe(3);
        expect(supervised.states().get('kafka')!.consecutiveFailures).toBe(0);
        expect(supervised.states().get('kafka')!.circuitResetTime).toBeNull();
    });

    it('stops, escalates or resumes as the directive of a failure says', async () => {
        const stopped = new FakeServer();
        const escalated = new FakeServer();
        const resumed = new FakeServer();
        const supervised = supervisor({
            directives: [[QueueDeleted, 'stop'], [SyntaxError, 'escalate'], [TypeError, 'resume']],
        }).register('stopped', stopped).register('escalated', escalated).register('resumed', resumed);
        await supervised.start();

        stopped.fail(new QueueDeleted());
        escalated.fail(new SyntaxError('denied'));
        resumed.fail(new TypeError('ignored'));

        await eventually(() => health(supervised, 'stopped') === 'stopped');
        await eventually(() => health(supervised, 'escalated') === 'stopped');
        await eventually(() => health(supervised, 'resumed') === 'unhealthy');
        for (const server of [stopped, escalated, resumed]) {
            expect(server.starts).toBe(1);
            expect(server.isRunning()).toBe(false);
        }
    });

    it('closes the servers on stop and ignores their later failures', async () => {
        const kafka = new FakeServer();
        const supervised = supervisor().register('kafka', kafka);
        await supervised.start();

        await supervised.stop();
        kafka.fail(new QueueDeleted());

        expect(supervised.isRunning()).toBe(false);
        expect(kafka.isRunning()).toBe(false);
        expect(health(supervised, 'kafka')).toBe('stopped');
        await supervised.start();
        expect(kafka.isRunning()).toBe(true);
        expect(kafka.starts).toBe(2);
    });

    it('cancels a pending restart on stop', async () => {
        const kafka = new FakeServer().failNextStarts(new Error('broker down'));
        const supervised = supervisor({ initialBackoffMs: 200 }).register('kafka', kafka);
        await supervised.start();

        await supervised.stop();
        await sleep(400);

        expect(kafka.starts).toBe(1);
        expect(kafka.isRunning()).toBe(false);
    });

    it('starts at once a server registered while it runs', async () => {
        const supervised = supervisor();
        await supervised.start();
        const nats = new FakeServer();

        supervised.register('nats', nats);

        await eventually(() => nats.isRunning());
        expect(() => supervised.register('nats', new FakeServer())).toThrow(/already registered/);
    });

    it('goes on when a listener fails', async () => {
        const supervised = supervisor();
        supervised.onHealthChange(() => {
            throw new Error('listener');
        });

        await supervised.register('kafka', new FakeServer()).start();

        expect(changes.map(change => change.current)).toContain('healthy');
    });

    it('cannot start once closed', async () => {
        const kafka = new FakeServer();
        const supervised = supervisor().register('kafka', kafka);
        await supervised.start();

        await supervised.close();
        await supervised.close();

        expect(kafka.isRunning()).toBe(false);
        await expect(supervised.start()).rejects.toThrow(/closed/);
    });
});

describe('SupervisorOptions', () => {
    it('restarts by default and stops on an abort', () => {
        const supervised = new ServerSupervisor();

        expect(supervised.strategy).toBe('oneForOne');
        expect(supervised.directiveOf(new Error())).toBe('restart');
        expect(supervised.directiveOf('a string')).toBe('restart');
        expect(supervised.directiveOf(new DOMException('aborted', 'AbortError'))).toBe('stop');
        const abort = new AbortController();
        abort.abort();
        expect(supervised.directiveOf(abort.signal.reason)).toBe('stop');
    });

    it('takes the exact class first, then the first class the failure is an instance of', () => {
        const supervised = new ServerSupervisor({ directives: [[Error, 'resume'], [RangeError, 'stop']] });

        expect(supervised.directiveOf(new RangeError())).toBe('stop');
        expect(supervised.directiveOf(new TypeError())).toBe('resume');
        expect(supervised.directiveOf(42)).toBe('restart');
    });

    it('rejects values that make no sense', () => {
        const invalid: SupervisorOptions[] = [
            { maxRestarts: -1 },
            { maxRestarts: 1.5 },
            { maxRestartWindowMs: 0 },
            { initialBackoffMs: -1 },
            { maxBackoffMs: -1 },
            { backoffMultiplier: 0.5 },
            { backoffMultiplier: Number.NaN },
            { circuitBreakerThreshold: 0 },
            { circuitBreakerResetMs: -1 },
            { strategy: 'oneForNone' as never },
            { directives: [[Error, 'ignore' as never]] },
        ];
        for (const options of invalid) expect(() => new ServerSupervisor(options)).toThrow(RangeError);
        expect(() => new ServerSupervisor({ directives: [[null as never, 'stop']] })).toThrow(TypeError);
        expect(() => new ServerSupervisor().register('', new FakeServer())).toThrow(TypeError);
        expect(() => new ServerSupervisor().register('kafka', null as never)).toThrow(TypeError);
        expect(() => new ServerSupervisor().onHealthChange(null as never)).toThrow(TypeError);
    });
});
