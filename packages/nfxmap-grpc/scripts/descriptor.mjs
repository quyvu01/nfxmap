// Writes src/descriptor.ts, the protobufjs JSON descriptor of proto/fxMap.proto: the package loads it without
// reading a file, from ESM and CommonJS alike. Run it after a change to the proto (the tests check they agree).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

export function descriptor() {
    const root = new protobuf.Root();
    root.loadSync(fileURLToPath(new URL('../proto/fxMap.proto', import.meta.url)), { keepCase: true });
    const json = root.toJSON();
    // Only the wrapper the contract uses
    json.nested.google.nested.protobuf.nested = { StringValue: json.nested.google.nested.protobuf.nested.StringValue };
    return json;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    writeFileSync(fileURLToPath(new URL('../src/descriptor.ts', import.meta.url)),
        '// Generated from proto/fxMap.proto by scripts/descriptor.mjs: do not edit.\n'
        + `export const FXMAP_DESCRIPTOR = ${JSON.stringify(descriptor(), null, 4)} as const;\n`);
}
