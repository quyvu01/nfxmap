import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * A service of another FxMap port, started as a process: dotnet-probe (FxMap 5.1.1) or java-probe (jfxmap). Both take
 * `owner|consumer <transport> <address> [trace]`:
 *
 * - an owner owns the string key UserOf (users 1 Alice and 2 Bob, emailed `alice@<name>`), prints `READY` and answers
 *   until it is stopped;
 * - a consumer maps the orders of users 1, 2 and 3 and prints them as `RESULT <json>`;
 * - with `trace`, each prints its spans as they end: `SPAN <name> <trace id> <span id> <parent span id>`.
 */
export interface Peer {
    /** dotnet or java: the domain of the emails of its users, and the `x-probe` header it sends. */
    readonly name: string;
    readonly command: readonly string[];
}

/**
 * The probes the tests run against: `NFXMAP_DOTNET_PROBE` and `NFXMAP_JAVA_PROBE` give the command that starts each
 * (`dotnet interop/dotnet-probe/out/DotnetProbe.dll`, `interop/java-probe/build/install/java-probe/bin/java-probe`).
 */
export const PEERS: readonly Peer[] = [
    ['dotnet', process.env.NFXMAP_DOTNET_PROBE],
    ['java', process.env.NFXMAP_JAVA_PROBE],
].filter((peer): peer is [string, string] => (peer[1] ?? '').trim() !== '')
    .map(([name, command]) => ({ name, command: command.trim().split(/\s+/) }));

/** A span a probe printed. */
export interface ProbeSpan {
    readonly name: string;
    readonly traceId: string;
    readonly spanId: string;
    readonly parentSpanId: string;
}

export interface RunningOwner {
    /** Each line it printed so far. */
    readonly output: readonly string[];
    stop(): Promise<void>;
}

/** An owner of UserOf, ready to answer. */
export async function startOwner(peer: Peer, transport: string, address: string, trace = false):
    Promise<RunningOwner> {
    const args = [...peer.command.slice(1), 'owner', transport, address, ...(trace ? ['trace'] : [])];
    const child = spawn(peer.command[0], args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const ready = new Promise<void>((resolve, reject) => {
        const read = (stream: NodeJS.ReadableStream) => createInterface({ input: stream }).on('line', line => {
            output.push(line);
            if (line.includes('READY')) resolve();
        });
        read(child.stdout!);
        read(child.stderr!);
        child.once('error', reject);
        void exited.then(() => reject(new Error(`The ${peer.name} owner stopped before it was ready:\n${output.join('\n')}`)));
    });
    const stop = async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        const killed = await Promise.race([exited.then(() => true), sleep(30_000).then(() => false)]);
        if (!killed) {
            child.kill('SIGKILL');
            await exited;
        }
    };
    try {
        await withTimeout(ready, 180_000, () => `The ${peer.name} owner was not ready:\n${output.join('\n')}`);
    } catch (error) {
        await stop();
        throw error;
    }
    // Its servers subscribe in the background once it started
    await sleep(3_000);
    return { output, stop };
}

/** What a consumer printed, once it mapped the orders of users 1, 2 and 3. */
export async function runConsumer(peer: Peer, transport: string, address: string, trace = false): Promise<string[]> {
    const args = [...peer.command.slice(1), 'consumer', transport, address, ...(trace ? ['trace'] : [])];
    const child = spawn(peer.command[0], args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const output: string[] = [];
    createInterface({ input: child.stdout! }).on('line', line => output.push(line));
    createInterface({ input: child.stderr! }).on('line', line => output.push(line));
    const code = await withTimeout(new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
    }), 180_000, () => {
        child.kill('SIGKILL');
        return `The ${peer.name} consumer did not finish:\n${output.join('\n')}`;
    });
    if (code !== 0) throw new Error(`The ${peer.name} consumer exited with ${code}:\n${output.join('\n')}`);
    return output;
}

/** The orders a consumer mapped. */
export function orders(output: readonly string[]): Record<string, unknown>[] {
    const result = output.find(line => line.startsWith('RESULT '));
    if (result === undefined) throw new Error(`No result in:\n${output.join('\n')}`);
    return JSON.parse(result.slice('RESULT '.length)) as Record<string, unknown>[];
}

/** The span a probe printed with that name; waits for it, as a span is printed when it ends. */
export async function probeSpan(output: readonly string[], name: string): Promise<ProbeSpan> {
    const deadline = Date.now() + 10_000;
    for (;;) {
        const line = output.find(printed => printed.startsWith(`SPAN ${name} `));
        if (line !== undefined) {
            const [, , traceId, spanId, parentSpanId] = line.split(' ');
            return { name, traceId, spanId, parentSpanId };
        }
        if (Date.now() > deadline) throw new Error(`The probe printed no ${name} span:\n${output.join('\n')}`);
        await sleep(50);
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
