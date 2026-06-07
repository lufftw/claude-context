// Committed integration test for the snapshot completeness ledger (Commit 3/4 +
// Commit 4/4 — the Attack-3 regression surface). The mcp package is pure ESM and
// has no jest harness; rather than stand one up, this runner exercises the REAL
// COMPILED artifact (`dist/snapshot.js`) so we test exactly what ships.
//
// Run (from repo root, after `pnpm build:mcp`):
//   node packages/mcp/scripts/snapshot-ledger.test.mjs
// Exits 0 on success, non-zero on the first failed assertion.
//
// Coverage:
//   A. setFileComplete survives a setCodebaseIndexing tick + reload (carry-forward).
//   B. setCodebaseIndexed carries the files ledger across the terminal transition.
//   C. mergeAndWriteSnapshot FIELD-MERGES `files` across two manager instances
//      (session A's files + session B's files both persist — neither clobbers).
//   D. getFileLedger returns a COPY (mutating the returned Map / its entries does
//      NOT affect the stored entry; resume must see the PRIOR state).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distSnapshot = path.resolve(__dirname, '..', 'dist', 'snapshot.js');

if (!fs.existsSync(distSnapshot)) {
    console.error(`[snapshot-ledger.test] MISSING compiled artifact: ${distSnapshot}\n` +
        `Run 'pnpm build:mcp' first.`);
    process.exit(2);
}

const { SnapshotManager } = await import(pathToFileURL(distSnapshot).href);

// ── tiny assert harness ──────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  ✓ ${name}`);
    } else {
        failures++;
        console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Each scenario gets an isolated CLAUDE_CONTEXT_HOME temp dir so the snapshot
// file is scoped to that scenario (SnapshotManager reads CLAUDE_CONTEXT_HOME in
// its constructor).
function withTempHome(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-snap-test-'));
    const prev = process.env.CLAUDE_CONTEXT_HOME;
    process.env.CLAUDE_CONTEXT_HOME = dir;
    try {
        return fn(dir);
    } finally {
        if (prev === undefined) delete process.env.CLAUDE_CONTEXT_HOME;
        else process.env.CLAUDE_CONTEXT_HOME = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

// The codebase path must EXIST on disk: loadCodebaseSnapshot drops entries whose
// path no longer exists (the ghost-cleanup behavior). Use the repo dir itself.
const CB = path.resolve(__dirname, '..', '..', '..'); // repo root, guaranteed to exist

console.log('snapshot-ledger.test — compiled dist/snapshot.js');

// ── A. carry-forward across a setCodebaseIndexing progress tick + reload ──────
console.log('\nA. setFileComplete survives setCodebaseIndexing tick + reload');
withTempHome(() => {
    const m = new SnapshotManager();
    m.setCodebaseIndexing(CB, 10);
    m.setFileComplete(CB, 'a.ts', { complete: true, fileHash: 'ha', chunkCount: 2 });
    // A later 2s progress tick must NOT clobber the ledger (carry-forward arm).
    m.setCodebaseIndexing(CB, 50);
    m.setFileComplete(CB, 'b.ts', { complete: false, fileHash: 'hb', chunkCount: 1 });
    m.saveCodebaseSnapshot();

    // Reload in a fresh manager (simulates MCP restart / resume read).
    const m2 = new SnapshotManager();
    m2.loadCodebaseSnapshot();
    const led = m2.getFileLedger(CB);
    eq('a.ts carried through the progress tick', led.get('a.ts'),
        { complete: true, fileHash: 'ha', chunkCount: 2 });
    eq('b.ts present after reload', led.get('b.ts'),
        { complete: false, fileHash: 'hb', chunkCount: 1 });
    check('ledger has exactly the two files', led.size === 2, `size=${led.size}`);
});

// ── B. setCodebaseIndexed carries the files ledger across terminal transition ─
console.log('\nB. setCodebaseIndexed carries files across indexing→indexed');
withTempHome(() => {
    const m = new SnapshotManager();
    m.setCodebaseIndexing(CB, 0);
    m.setFileComplete(CB, 'a.ts', { complete: true, fileHash: 'ha', chunkCount: 3 });
    m.setCodebaseIndexed(CB, { indexedFiles: 1, totalChunks: 3, status: 'completed' });
    m.saveCodebaseSnapshot();

    const m2 = new SnapshotManager();
    m2.loadCodebaseSnapshot();
    const info = m2.getCodebaseInfo(CB);
    check('codebase is indexed', info && info.status === 'indexed', `status=${info && info.status}`);
    const led = m2.getFileLedger(CB);
    eq('a.ts ledger survived the terminal transition', led.get('a.ts'),
        { complete: true, fileHash: 'ha', chunkCount: 3 });
});

// ── C. field-merge across two manager instances (Attack-3) ───────────────────
console.log('\nC. mergeAndWriteSnapshot field-merges files across two sessions');
withTempHome(() => {
    // Session A writes its files first.
    const a = new SnapshotManager();
    a.setCodebaseIndexing(CB, 20);
    a.setFileComplete(CB, 'sessionA.ts', { complete: true, fileHash: 'A1', chunkCount: 5 });
    a.saveCodebaseSnapshot();

    // Session B starts COMPLETELY fresh and does NOT call loadCodebaseSnapshot —
    // its in-memory map knows ONLY about sessionB.ts. This is the exact Attack-3
    // shape: a concurrent/independent writer whose in-memory `files` holds only
    // the files it touched. The on-disk read-merge-write in mergeAndWriteSnapshot
    // is the ONLY thing that can preserve sessionA.ts; a whole-object replace of
    // `files` would clobber it.
    const b = new SnapshotManager();
    b.setCodebaseIndexing(CB, 40);
    b.setFileComplete(CB, 'sessionB.ts', { complete: false, fileHash: 'B1', chunkCount: 2 });
    b.saveCodebaseSnapshot();

    const reader = new SnapshotManager();
    reader.loadCodebaseSnapshot();
    const led = reader.getFileLedger(CB);
    eq('sessionA.ts preserved after session B save', led.get('sessionA.ts'),
        { complete: true, fileHash: 'A1', chunkCount: 5 });
    eq('sessionB.ts present after session B save', led.get('sessionB.ts'),
        { complete: false, fileHash: 'B1', chunkCount: 2 });
    check('both sessions present (field-merge, not clobber)', led.size === 2, `size=${led.size}`);
});

// ── D. getFileLedger returns a COPY ──────────────────────────────────────────
console.log('\nD. getFileLedger returns a copy (mutation does not leak)');
withTempHome(() => {
    const m = new SnapshotManager();
    m.setCodebaseIndexing(CB, 0);
    m.setFileComplete(CB, 'a.ts', { complete: true, fileHash: 'ha', chunkCount: 2 });

    const led1 = m.getFileLedger(CB);
    // Mutate the returned Map AND a returned entry object.
    led1.delete('a.ts');
    led1.set('injected.ts', { complete: false, fileHash: 'x', chunkCount: 99 });
    const e1 = m.getFileLedger(CB).get('a.ts');
    if (e1) e1.complete = false; // try to corrupt the (should-be-copied) entry

    // A fresh read must be untouched by either mutation.
    const led2 = m.getFileLedger(CB);
    eq('stored a.ts unchanged after Map + entry mutation', led2.get('a.ts'),
        { complete: true, fileHash: 'ha', chunkCount: 2 });
    check('injected key did not leak into stored ledger', !led2.has('injected.ts'),
        'injected.ts leaked');
});

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
