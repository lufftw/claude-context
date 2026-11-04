#!/usr/bin/env node
// Runs src/**/*.test.ts with node:test + tsx.
// `node --test "src/**/*.test.ts"` relies on glob support that only exists in Node >= 21,
// while this package supports Node >= 20, and glob quoting differs between shells
// (cmd.exe, PowerShell, sh). Discovering the files here works the same everywhere.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(pkgRoot, 'src');

const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.test.ts'))
    .map(e => relative(pkgRoot, join(e.parentPath ?? e.path, e.name)))
    .sort();

if (files.length === 0) {
    console.error('No test files found under src/');
    process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
    cwd: pkgRoot,
    stdio: 'inherit',
});
process.exit(result.status ?? 1);
