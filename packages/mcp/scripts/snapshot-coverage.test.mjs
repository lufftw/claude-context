#!/usr/bin/env node
// packages/mcp/scripts/snapshot-coverage.test.mjs
// P4: per-(codebase × model) coverage ratio survives the carry-forward + reload.
// Imports the COMPILED dist/snapshot.js (same convention as snapshot-ledger /
// snapshot-additive-roundtrip — we test exactly what ships). Parsed-object
// assertions; exit non-zero on first failure. Two SnapshotManager runtimes
// (capture + verify share code — the SAME runtime serializer on both sides).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distSnapshot = path.resolve(__dirname, '..', 'dist', 'snapshot.js');
if (!fs.existsSync(distSnapshot)) { console.error(`MISSING ${distSnapshot} — run pnpm build:mcp`); process.exit(2); }
const { SnapshotManager } = await import(pathToFileURL(distSnapshot).href);

let failures = 0;
const check = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

function withTempHome(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cov-test-'));
    const prev = process.env.CLAUDE_CONTEXT_HOME; process.env.CLAUDE_CONTEXT_HOME = dir;
    try { return fn(dir); } finally { if (prev === undefined) delete process.env.CLAUDE_CONTEXT_HOME; else process.env.CLAUDE_CONTEXT_HOME = prev; try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
}
const CB = path.resolve(__dirname, '..', '..', '..'); // repo root (must exist)

console.log('snapshot-coverage.test — compiled dist/snapshot.js');
withTempHome(() => {
    const m = new SnapshotManager();
    m.setCodebaseIndexing(CB, 10);
    m.setCoverageRatioForModel(CB, 'qwen3-embedding-0.6b', 0.42);
    // A later 2s progress tick must NOT clobber the coverage (M2 carry-forward).
    m.setCodebaseIndexing(CB, 80);
    m.setCodebaseIndexed(CB, { indexedFiles: 1, totalChunks: 3, status: 'completed' });
    m.saveCodebaseSnapshot();

    // Re-read from disk in a SECOND runtime (capture-and-verify share code).
    const m2 = new SnapshotManager();
    m2.loadCodebaseSnapshot();
    check('coverage ratio survived indexing tick + terminal transition + reload',
        m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b') === 0.42,
        `got ${m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b')}`);
    check('absent model coverage reads as undefined',
        m2.getCoverageRatioForModel(CB, 'qwen3-embedding-8b') === undefined,
        `got ${m2.getCoverageRatioForModel(CB, 'qwen3-embedding-8b')}`);
});

// Seed-when-absent: setCoverageRatioForModel before any setCodebaseIndexing must
// still persist (mirrors setFileCompleteForModel's seed-an-indexing-entry behavior).
withTempHome(() => {
    const m = new SnapshotManager();
    m.setCoverageRatioForModel(CB, 'qwen3-embedding-0.6b', 0.91); // no prior entry
    m.saveCodebaseSnapshot();
    const m2 = new SnapshotManager();
    m2.loadCodebaseSnapshot();
    check('coverage persists even when set before the first indexing tick (seed path)',
        m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b') === 0.91,
        `got ${m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b')}`);
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
