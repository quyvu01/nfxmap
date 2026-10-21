#!/usr/bin/env node
// Runs the two sample services, on any system with Node 20 or later: user-service (HTTP 8081, gRPC 9091), then
// order-service (HTTP 8082).
//
//   node samples/run.mjs           build, start both, show /orders, keep them running until Ctrl+C
//   node samples/run.mjs --check   build, start both, check /orders shows the users, stop both (exit code 1 on failure)
//
// USER_SERVICE_COMMAND and ORDER_SERVICE_COMMAND run another service in place of one of them, such as the samples of
// jfxmap (java -jar .../user-service.jar), which answer and ask the same key UserOf on the same ports.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n'));
    process.exit(0);
}
const unknown = args.filter(arg => arg !== '--check');
if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]} (use --check or --help)`);
    process.exit(2);
}
const check = args.includes('--check');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logs = join(root, 'samples', 'build', 'logs');
mkdirSync(logs, { recursive: true });

console.log('Building the services...');
// The packages the services use, then the services
const workspaces = ['packages/nfxmap', 'packages/nfxmap-grpc', 'packages/nfxmap-typeorm', 'samples/user-service',
    'samples/order-service'];
const built = spawnSync('npm', ['run', 'build', ...workspaces.flatMap(workspace => ['-w', workspace])],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], shell: true });
if (built.status !== 0) {
    console.error('The build failed.');
    process.exit(1);
}

const services = [];

function start(name, command) {
    const log = join(logs, `${name}.log`);
    const output = createWriteStream(log);
    const child = command
        ? spawn(command, { cwd: root, shell: true })
        : spawn(process.execPath, [join(root, 'samples', name, 'dist', 'main.js')], { cwd: root });
    child.stdout.pipe(output);
    child.stderr.pipe(output);
    const service = { name, child, log, exited: false };
    child.once('exit', () => {
        service.exited = true;
    });
    services.push(service);
    console.log(`Started ${name} (pid ${child.pid}), log: ${log}`);
    return service;
}

function tail(service) {
    return readFileSync(service.log, 'utf8').split('\n').slice(-40).join('\n');
}

// Up once it answers with its data
async function waitFor(service, url) {
    for (let i = 0; i < 120; i++) {
        try {
            const response = await fetch(url);
            if (response.ok && (await response.text()).startsWith('[{')) {
                console.log(`${service.name} is up: ${url}`);
                return;
            }
        } catch {
            // Not listening yet
        }
        if (service.exited) throw new Error(`${service.name} stopped while starting; the end of its log:\n${tail(service)}`);
        await sleep(1_000);
    }
    throw new Error(`${service.name} did not answer ${url} in 120 seconds; the end of its log:\n${tail(service)}`);
}

async function stop() {
    for (const service of services.reverse()) {
        if (service.exited) continue;
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(service.child.pid), '/t', '/f']);
        else service.child.kill('SIGTERM');
        await new Promise(resolve => {
            if (service.exited) resolve();
            else service.child.once('exit', resolve);
        });
    }
}

function checkOrders(orders) {
    const byId = new Map(orders.map(order => [Number(order.id), order]));
    const expected = [
        [1, { userName: 'Alice Nguyen', userEmail: 'alice@example.com', userCountry: 'Vietnam', userNameUpper: 'ALICE NGUYEN', userAddressCount: 2 }],
        [2, { userName: 'Bob Martin', userEmail: 'bob@example.com', userCountry: 'France', userNameUpper: 'BOB MARTIN', userAddressCount: 1 }],
        [4, { userName: 'Carol Tran', userCountry: null, userAddressCount: 0 }],
        [5, { userName: null, userEmail: null }],
    ];
    const wrong = [];
    for (const [id, fields] of expected) {
        for (const [field, value] of Object.entries(fields)) {
            const actual = byId.get(id)?.[field] ?? null;
            if (actual !== value) wrong.push(`order ${id}: ${field} is ${JSON.stringify(actual)}, not ${JSON.stringify(value)}`);
        }
    }
    return wrong;
}

let failed = false;
process.once('SIGINT', () => void stop().then(() => process.exit(130)));
try {
    await waitFor(start('user-service', process.env.USER_SERVICE_COMMAND), 'http://localhost:8081/users');
    await waitFor(start('order-service', process.env.ORDER_SERVICE_COMMAND), 'http://localhost:8082/orders');
    const orders = await (await fetch('http://localhost:8082/orders')).json();
    console.log('\nGET http://localhost:8082/orders');
    console.log(JSON.stringify(orders, null, 2));
    if (check) {
        const wrong = checkOrders(orders);
        if (wrong.length > 0) {
            failed = true;
            console.error(`\nThe orders do not show their users:\n - ${wrong.join('\n - ')}`);
        } else {
            console.log('\nThe orders show the fields of their users.');
        }
    } else {
        console.log('\nBoth services are running; Ctrl+C stops them.');
        console.log('  curl localhost:8082/orders\n  curl localhost:8082/orders/2\n  curl localhost:8081/users');
        await new Promise(() => undefined);
    }
} catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
} finally {
    await stop();
}
process.exit(failed ? 1 : 0);
