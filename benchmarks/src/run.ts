// Runs the benchmarks of nfxmap with tinybench and prints a table of their latency and throughput.
//
//   npm run bench -w benchmarks                          all of them, one second each after a warmup
//   npm run bench -w benchmarks -- mapping               those whose name contains "mapping"
//   npm run bench -w benchmarks -- parse --time 3000     those of the parser, three seconds each
import { WireMessages } from 'nfxmap';
import { Bench } from 'tinybench';
import { type Complexity, EXPRESSIONS, parse } from './expression-parser.js';
import { createMapper, map } from './mapping.js';
import { wireData } from './wire-messages.js';

const args = process.argv.slice(2);
const timeAt = args.indexOf('--time');
const time = timeAt < 0 ? 1_000 : Number(args[timeAt + 1]);
if (!Number.isFinite(time) || time <= 0) {
    console.error('--time takes a number of milliseconds');
    process.exit(2);
}
const filters = args.filter((_, i) => i !== timeAt && i !== timeAt + 1).map(filter => filter.toLowerCase());

const bench = new Bench({ time, warmupTime: Math.min(time, 500), throws: true });
const add = (name: string, fn: () => unknown) => {
    if (filters.length === 0 || filters.some(filter => name.toLowerCase().includes(filter))) bench.add(name, fn);
};

for (const complexity of Object.keys(EXPRESSIONS) as Complexity[])
    add(`parse ${complexity} expression`, () => parse(complexity));

const mapper = createMapper();
for (const dtos of [1, 100, 10_000])
    add(`mapping ${dtos} DTOs`, () => map(mapper, dtos));

for (const ids of [10, 1_000]) {
    const data = wireData(ids);
    add(`wire writeRequest ${ids} ids`, () => WireMessages.writeRequest(data.request));
    add(`wire readRequest ${ids} ids`, () => WireMessages.readRequest(data.requestJson));
    add(`wire writeSuccess ${ids} items`, () => WireMessages.writeSuccess(data.response));
    add(`wire readResult ${ids} items`, () => WireMessages.readResult(data.responseJson));
}

if (bench.tasks.length === 0) {
    console.error(`No benchmark matches ${filters.join(', ')}`);
    process.exit(2);
}
console.log(`Node ${process.version}, ${bench.tasks.length} benchmarks, ${time} ms each...`);
await bench.run();
console.table(bench.table());
