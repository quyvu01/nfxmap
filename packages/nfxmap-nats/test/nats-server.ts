import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

/**
 * The NATS server of the integration tests: `NATS_URL` when it is set (CI runs a `nats` container), otherwise a
 * `nats-server` started from `NATS_SERVER` or the PATH; `null` when there is neither, and the tests are skipped.
 */
export async function startNatsServer(): Promise<{ url: string; stop(): void } | null> {
    if (process.env.NATS_URL) return { url: process.env.NATS_URL, stop: () => undefined };
    const port = await freePort();
    let child: ChildProcess;
    try {
        child = spawn(process.env.NATS_SERVER ?? 'nats-server', ['-a', '127.0.0.1', '-p', String(port)],
            { stdio: ['ignore', 'ignore', 'pipe'] });
        await new Promise<void>((resolve, reject) => {
            let log = '';
            child.once('error', reject);
            child.once('exit', code => reject(new Error(`nats-server exited with ${code}: ${log}`)));
            child.stderr!.on('data', chunk => {
                log += chunk;
                if (log.includes('Server is ready')) resolve();
            });
        });
    } catch {
        return null;
    }
    return { url: `nats://127.0.0.1:${port}`, stop: () => child.kill() };
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}
