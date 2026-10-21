# benchmarks

The benchmarks of nfxmap, the same as [jfxmap's](https://github.com/quyvu01/jfxmap/tree/main/benchmarks), run with
[tinybench](https://github.com/tinylibs/tinybench) against the build of nfxmap:

- `parse simple|medium|complex expression`: tokenizing and parsing an expression into its syntax tree, from `Name` to
  a projection over a filter ([expression-parser.ts](src/expression-parser.ts));
- `mapping 1|100|10000 DTOs`: the whole engine in one process, a mapper over a `LocalRequestClient` and
  `InMemoryQueryHandler`s for 1,000 users, 64 provinces and 50 products. Each order DTO gets a name, an exposed name, a
  navigation, an aggregation, a province id and then its province name (a chained rule), and its two nested line DTOs
  get their product names through their own profile ([mapping.ts](src/mapping.ts));
- `wire writeRequest|readRequest|writeSuccess|readResult`: the JSON that travels on every transport, for a request of
  10 or 1,000 ids and its reply ([wire-messages.ts](src/wire-messages.ts)).

```sh
npm run build -w packages/nfxmap -w benchmarks
npm run bench -w benchmarks                          # all, one second each after a warmup
npm run bench -w benchmarks -- wire parse            # those whose name contains "wire" or "parse"
npm run bench -w benchmarks -- mapping --time 3000   # three seconds each
```

It prints the average and median latency in nanoseconds and the throughput of each. `npm test` runs the code of each
benchmark once and checks its result ([benchmarks.test.ts](test/benchmarks.test.ts)); the build and the tests of the CI
do too, without running the benchmarks.
