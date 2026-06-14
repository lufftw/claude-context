// packages/mcp/scripts/snapshot-additive-roundtrip.test.mjs
//
// KEYSTONE GATE (Phase 1, M3). Phases 2-6 are blocked until this exits 0.
// The mcp package has NO jest; per the house convention (snapshot-ledger.test.mjs)
// this is a Node ESM runner that exercises the REAL COMPILED dist so we test
// exactly what ships. Exits 0 on success, non-zero on the first failed assertion.
// Assertions are on PARSED objects (JSON.stringify equality) — NEVER substring.
//
// rev1.2: this is the v2-ADDITIVE round-trip gate. The emitted formatVersion stays
// the literal 'v2' forever; filesByModel/coverageByModel ride ADDITIVELY inside the
// v2 doc (M1 supersedes the v2->v3 bump). Renamed from snapshot-v3-roundtrip per
// rev1.2 M-naming.
//
// Run (from repo root, after `pnpm build:mcp`):
//   node packages/mcp/scripts/snapshot-additive-roundtrip.test.mjs
//   (or: pnpm --filter @zilliz/claude-context-mcp test:snapshot-additive)
//
// Coverage:
//   T-load  (C2/D1, P7): a hand-written v2 fixture with top-level `files` populated
//       loads under the new dist; getFileLedgerForModel(P,'qwen3-embedding-8b')
//       returns the SAME entry; (P,'qwen3-embedding-0.6b') is EMPTY.
//   T-write-isolation: setFileCompleteForModel(P,'0.6b','a.ts',...) does NOT alter the
//       8B ledger; survives save+reload.
//   T-cross-session (M2 keystone, capture==verify, two runtimes): runtime#1 writes a
//       0.6B ledger for codebase P; runtime#2 (fresh SnapshotManager, same temp home)
//       writes a DIFFERENT codebase Q via the PUBLIC saveCodebaseSnapshot; re-read from
//       disk -> BOTH P's filesByModel AND Q survive (the Attack-3 multi-user class).
//   T-same-codebase-merge (M2 keystone CORE): two runtimes write the SAME codebase P
//       under DIFFERENT model ids (runtime#1 -> 0.6B 'a.ts'; runtime#2 -> 8B 'b.ts')
//       via the PUBLIC saveCodebaseSnapshot; re-read from disk -> BOTH model ledgers
//       for the SAME codebase coexist. This is the literal keystone premise that
//       T-cross-session (two DIFFERENT codebases) does NOT exercise.
//   T-coverage-merge (Phase 4 contract): two runtimes write coverageByModel for the
//       SAME codebase under DIFFERENT model ids; re-read from disk -> both model
//       entries coexist (the per-model union the merge must honor).
//   T-proto-guard: setFileCompleteForModel(P,'__proto__',...) THROWS and does NOT
//       pollute Object.prototype ({}).somekey stays undefined.
//   T1 emit-invariant: after load + saveCodebaseSnapshot(), the on-disk formatVersion
//       is still 'v2' (rev1.2 T1: MUST save before re-reading — load does NOT auto-save
//       the migrated doc in a way we can rely on for this assertion's intent).
//   T-fwdcompat (M1 forward-tolerance): an old-shape reader cannot crash on a future
//       'v3' additive peer file; its codebases/`files` are preserved (NOT wiped) and the
//       emitted file is re-written as 'v2'.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distSnapshot = path.resolve(__dirname, '..', 'dist', 'snapshot.js');

if (!fs.existsSync(distSnapshot)) {
    console.error(`[snapshot-additive-roundtrip.test] MISSING compiled artifact: ${distSnapshot}\n` +
        `Run 'pnpm build:mcp' first.`);
    process.exit(2);
}

const { SnapshotManager } = await import(pathToFileURL(distSnapshot).href);

const PRIMARY = 'qwen3-embedding-8b';
const SECONDARY = 'qwen3-embedding-0.6b';

// ── tiny assert harness (same shape as snapshot-ledger.test.mjs) ──────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); }
    else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Each scenario gets an isolated CLAUDE_CONTEXT_HOME temp dir so the snapshot file
// is scoped to that scenario (SnapshotManager reads CLAUDE_CONTEXT_HOME in its ctor).
function withTempHome(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-snap-additive-'));
    const prev = process.env.CLAUDE_CONTEXT_HOME;
    process.env.CLAUDE_CONTEXT_HOME = dir;
    try { return fn(dir); }
    finally {
        if (prev === undefined) delete process.env.CLAUDE_CONTEXT_HOME;
        else process.env.CLAUDE_CONTEXT_HOME = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

const snapPath = (home) => path.join(home, 'mcp-codebase-snapshot.json');
const readDisk = (home) => JSON.parse(fs.readFileSync(snapPath(home), 'utf8'));

// P and Q MUST exist on disk or loadV2Format drops them as ghosts (snapshot.ts:~109).
// Use the repo root (guaranteed to exist) for P, and a child dir of it for Q.
const P = path.resolve(__dirname, '..', '..', '..'); // repo root, guaranteed to exist
const Q = path.resolve(P, 'packages');               // also guaranteed to exist on disk

console.log('snapshot-additive-roundtrip.test — compiled dist/snapshot.js (KEYSTONE, v2-additive)');

// ── T-load: v2 fixture with files populated; 8B preserved, 0.6B empty (C2/D1,P7) ──
console.log('\nT-load. v2 fixture: 8B ledger preserved, 0.6B empty');
withTempHome((home) => {
    // P7: hand-written v2 doc with top-level `files` POPULATED (NOT a v1-migrated empty).
    const fixture = {
        formatVersion: 'v2',
        codebases: {
            [P]: {
                status: 'indexed',
                indexedFiles: 1,
                totalChunks: 3,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString(),
                files: { 'a.ts': { complete: true, fileHash: 'h1', chunkCount: 3 } }
            }
        },
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(snapPath(home), JSON.stringify(fixture, null, 2));

    const mgr = new SnapshotManager();
    mgr.loadCodebaseSnapshot();

    const eight = mgr.getFileLedgerForModel(P, PRIMARY);
    eq('8B ledger a.ts == legacy files entry', eight.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    check('8B ledger size === 1', eight.size === 1, `size=${eight.size}`);

    const small = mgr.getFileLedgerForModel(P, SECONDARY);
    check('0.6B ledger empty on first load', small.size === 0, `size=${small.size}`);

    // getFileLedger (legacy, no model) still delegates to the primary id.
    const legacy = mgr.getFileLedger(P);
    eq('getFileLedger delegates to primary (8B)', legacy.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
});

// ── T-write-isolation: 0.6B write does NOT touch the 8B ledger; survives reload ──
console.log('\nT-write-isolation. 0.6B write leaves 8B intact, persists across reload');
withTempHome((home) => {
    const r1 = new SnapshotManager();
    r1.setCodebaseIndexing(P, 0);
    r1.setFileCompleteForModel(P, PRIMARY, 'a.ts', { complete: true, fileHash: 'h1', chunkCount: 3 });
    // Now write the SECONDARY ledger for a DIFFERENT file.
    r1.setFileCompleteForModel(P, SECONDARY, 'a.ts', { complete: true, fileHash: 'h1', chunkCount: 7 });

    // In-memory: the 8B ledger must be unchanged by the 0.6B write.
    const eightLive = r1.getFileLedgerForModel(P, PRIMARY);
    eq('8B a.ts untouched by 0.6B write (in-memory)', eightLive.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    check('8B ledger still size 1 (in-memory)', eightLive.size === 1, `size=${eightLive.size}`);

    r1.saveCodebaseSnapshot();

    // Reload in a fresh manager: both ledgers must come back, still isolated.
    const r2 = new SnapshotManager();
    r2.loadCodebaseSnapshot();
    const eight = r2.getFileLedgerForModel(P, PRIMARY);
    const small = r2.getFileLedgerForModel(P, SECONDARY);
    eq('8B a.ts survived reload, unchanged chunkCount', eight.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    eq('0.6B a.ts persisted with its own chunkCount', small.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 7 });
    check('8B ledger size 1 after reload', eight.size === 1, `size=${eight.size}`);
    check('0.6B ledger size 1 after reload', small.size === 1, `size=${small.size}`);
});

// ── T-cross-session: two runtimes, two codebases, both survive (M2 / Attack-3) ──
console.log('\nT-cross-session. two runtimes write P(0.6B) and Q; both survive on disk');
withTempHome((home) => {
    // Runtime #1 seeds P's 8B ledger AND a 0.6B ledger, saves through PUBLIC save.
    const r1 = new SnapshotManager();
    r1.setCodebaseIndexing(P, 0);
    r1.setFileCompleteForModel(P, PRIMARY, 'a.ts', { complete: true, fileHash: 'h1', chunkCount: 3 });
    r1.setFileCompleteForModel(P, SECONDARY, 'b.ts', { complete: true, fileHash: 'h2', chunkCount: 2 });
    r1.setCodebaseIndexed(P, { indexedFiles: 1, totalChunks: 3, status: 'completed' });
    r1.saveCodebaseSnapshot();

    // Runtime #2 starts COMPLETELY fresh, knows ONLY about codebase Q, saves through
    // the PUBLIC saveCodebaseSnapshot. The on-disk read-merge-write is the ONLY thing
    // that can preserve P; a whole-object replace would clobber P's filesByModel.
    const r2 = new SnapshotManager();
    r2.setCodebaseIndexing(Q, 0);
    r2.setFileCompleteForModel(Q, PRIMARY, 'q.ts', { complete: true, fileHash: 'hq', chunkCount: 1 });
    r2.saveCodebaseSnapshot();

    // Runtime #3 re-reads FROM DISK and verifies BOTH codebases survive (parsed objs).
    const r3 = new SnapshotManager();
    r3.loadCodebaseSnapshot();
    const pEight = r3.getFileLedgerForModel(P, PRIMARY);
    const pSmall = r3.getFileLedgerForModel(P, SECONDARY);
    const qEight = r3.getFileLedgerForModel(Q, PRIMARY);
    eq('P 8B a.ts survived runtime#2 save', pEight.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    eq('P 0.6B b.ts survived runtime#2 save', pSmall.get('b.ts'),
        { complete: true, fileHash: 'h2', chunkCount: 2 });
    eq('Q 8B q.ts present', qEight.get('q.ts'),
        { complete: true, fileHash: 'hq', chunkCount: 1 });

    // Disk-shape proof: P keeps both ledgers, Q is its own entry, emit stays v2.
    const disk = readDisk(home);
    eq('disk P.files (8B) intact', disk.codebases[P].files['a.ts'],
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    eq('disk P.filesByModel[0.6b] intact', disk.codebases[P].filesByModel[SECONDARY]['b.ts'],
        { complete: true, fileHash: 'h2', chunkCount: 2 });
    eq('disk Q.files (8B) intact', disk.codebases[Q].files['q.ts'],
        { complete: true, fileHash: 'hq', chunkCount: 1 });
    eq('emitted formatVersion stays v2', disk.formatVersion, 'v2');
});

// ── T-same-codebase-merge: SAME codebase P, two model ids, two runtimes coexist ──
// This is the LITERAL keystone premise: two sessions indexing the SAME codebase under
// DIFFERENT models must both survive. T-cross-session uses two DIFFERENT codebases and
// therefore does NOT cover this — the on-disk read-merge-write must field-merge the
// per-model sub-ledgers of the SAME codebase entry, not whole-object-replace it.
console.log('\nT-same-codebase-merge. same codebase P, 0.6B (rt#1) + 8B (rt#2) coexist on disk');
withTempHome((home) => {
    // Runtime #1: codebase P, write the SECONDARY (0.6B) ledger for 'a.ts', save PUBLIC.
    const r1 = new SnapshotManager();
    r1.setCodebaseIndexing(P, 0);
    r1.setFileCompleteForModel(P, SECONDARY, 'a.ts', { complete: true, fileHash: 'sa', chunkCount: 5 });
    r1.saveCodebaseSnapshot();

    // Runtime #2: fresh manager, SAME temp home, SAME codebase P, write the PRIMARY (8B)
    // ledger (legacy top-level `files`) for a DIFFERENT file 'b.ts'. Save through PUBLIC
    // saveCodebaseSnapshot — the read-merge-write is the ONLY thing that can keep rt#1's
    // 0.6B ledger alive on the SAME codebase entry.
    const r2 = new SnapshotManager();
    r2.setCodebaseIndexing(P, 0);
    r2.setFileComplete(P, 'b.ts', { complete: true, fileHash: 'pb', chunkCount: 9 });
    r2.saveCodebaseSnapshot();

    // Re-read FROM DISK: BOTH model ledgers for the SAME codebase P coexist (parsed objs).
    const disk = readDisk(home);
    eq('disk P.filesByModel[0.6b].a.ts survived rt#2 save (same codebase)',
        disk.codebases[P].filesByModel[SECONDARY]['a.ts'],
        { complete: true, fileHash: 'sa', chunkCount: 5 });
    eq('disk P.files[b.ts] (8B) written by rt#2 present (same codebase)',
        disk.codebases[P].files['b.ts'],
        { complete: true, fileHash: 'pb', chunkCount: 9 });
    eq('emitted formatVersion stays v2', disk.formatVersion, 'v2');

    // And via a fresh runtime's per-model accessors, both ledgers read back.
    const r3 = new SnapshotManager();
    r3.loadCodebaseSnapshot();
    eq('rt#3 reads P 0.6B a.ts', r3.getFileLedgerForModel(P, SECONDARY).get('a.ts'),
        { complete: true, fileHash: 'sa', chunkCount: 5 });
    eq('rt#3 reads P 8B b.ts', r3.getFileLedgerForModel(P, PRIMARY).get('b.ts'),
        { complete: true, fileHash: 'pb', chunkCount: 9 });
});

// ── T-coverage-merge: coverageByModel unions per model id across two runtimes ─────
// Phase 4 will WRITE coverageByModel; this pins the merge contract NOW so Phase 4 has a
// spec, not a guess. No public coverage setter exists yet, so we (a) persist model-A
// coverage to disk as a prior session's state, then (b) place model-B coverage on the
// live in-memory entry (getCodebaseInfo returns the live object) and save. The merge
// must union: disk{A} ∪ memory{B} = {A,B}.
console.log('\nT-coverage-merge. coverageByModel unions per model id (Phase 4 contract)');
withTempHome((home) => {
    // Runtime #1: create P, save, then stamp coverage for model A directly on disk
    // (simulating Phase 4's future persisted coverageByModel for a prior session).
    const r1 = new SnapshotManager();
    r1.setCodebaseIndexed(P, { indexedFiles: 1, totalChunks: 1, status: 'completed' });
    r1.saveCodebaseSnapshot();
    const onDisk = readDisk(home);
    onDisk.codebases[P].coverageByModel = { [PRIMARY]: 1.0 };
    fs.writeFileSync(snapPath(home), JSON.stringify(onDisk, null, 2));

    // Runtime #2: load (in-memory now carries coverage{A}); write coverage for a
    // DIFFERENT model B onto the LIVE in-memory entry, then save. The on-disk read
    // (coverage{A}) ∪ incoming (coverage{B}) must yield both keys.
    const r2 = new SnapshotManager();
    r2.loadCodebaseSnapshot();
    const live = r2.getCodebaseInfo(P);
    live.coverageByModel = { [SECONDARY]: 0.5 }; // different model id than on disk
    r2.saveCodebaseSnapshot();

    const disk = readDisk(home);
    eq('coverage[8B] (disk, rt#1) survived the merge', disk.codebases[P].coverageByModel[PRIMARY], 1.0);
    eq('coverage[0.6B] (rt#2) merged in', disk.codebases[P].coverageByModel[SECONDARY], 0.5);
    eq('coverageByModel has exactly the two model ids',
        Object.keys(disk.codebases[P].coverageByModel).sort(), [SECONDARY, PRIMARY].sort());
});

// ── T-proto-guard: '__proto__' model id throws and does NOT pollute Object.prototype ──
console.log('\nT-proto-guard. setFileCompleteForModel(__proto__) throws, no prototype pollution');
withTempHome((home) => {
    const mgr = new SnapshotManager();
    mgr.setCodebaseIndexing(P, 0);
    let threw = false;
    try {
        mgr.setFileCompleteForModel(P, '__proto__', 'x.ts', { complete: true, fileHash: 'x', chunkCount: 1 });
    } catch {
        threw = true;
    }
    check('setFileCompleteForModel(__proto__) throws', threw, 'expected an Error');
    // Prototype must NOT be polluted: a fresh object literal must not gain rogue keys.
    check('Object.prototype not polluted (somekey undefined)', ({}).somekey === undefined,
        `({}).somekey = ${JSON.stringify(({}).somekey)}`);
    check('Object.prototype not polluted (x.ts undefined)', ({})['x.ts'] === undefined,
        `({})['x.ts'] = ${JSON.stringify(({})['x.ts'])}`);
    // getFileLedgerForModel(__proto__) must also throw (guard applied symmetrically).
    let getThrew = false;
    try { mgr.getFileLedgerForModel(P, '__proto__'); } catch { getThrew = true; }
    check('getFileLedgerForModel(__proto__) throws', getThrew, 'expected an Error');
});

// ── T1: emit-invariant — after load + explicit save, on-disk version stays 'v2' ──
console.log('\nT1. emit-invariant: load + saveCodebaseSnapshot() keeps formatVersion v2');
withTempHome((home) => {
    const fixture = {
        formatVersion: 'v2',
        codebases: {
            [P]: {
                status: 'indexed',
                indexedFiles: 1, totalChunks: 1, indexStatus: 'completed',
                lastUpdated: new Date().toISOString(),
                files: { 'a.ts': { complete: true, fileHash: 'h1', chunkCount: 1 } }
            }
        },
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(snapPath(home), JSON.stringify(fixture, null, 2));

    const mgr = new SnapshotManager();
    mgr.loadCodebaseSnapshot();
    // rev1.2 T1 fix: SnapshotManager does not auto-save on load in a way this test
    // should rely on; explicitly save then re-read so the assertion is non-vacuous.
    mgr.saveCodebaseSnapshot();
    eq('on-disk formatVersion after explicit save', readDisk(home).formatVersion, 'v2');
    // The 8B ledger must survive the load+save round-trip.
    eq('8B a.ts survived load+save', readDisk(home).codebases[P].files['a.ts'],
        { complete: true, fileHash: 'h1', chunkCount: 1 });
});

// ── T-fwdcompat: a future 'v3' additive peer file is merged (not wiped), re-emit v2 ──
console.log('\nT-fwdcompat. a v3 on-disk peer file is merged (codebases preserved), re-emit v2');
withTempHome((home) => {
    // Simulate a NEWER peer that wrote formatVersion:'v3' with an existing codebase.
    const v3 = {
        formatVersion: 'v3',
        codebases: {
            [P]: {
                status: 'indexed',
                indexedFiles: 1, totalChunks: 1, indexStatus: 'completed',
                lastUpdated: new Date().toISOString(),
                files: { 'peer.ts': { complete: true, fileHash: 'pz', chunkCount: 1 } }
            }
        },
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(snapPath(home), JSON.stringify(v3, null, 2));

    // Our binary loads (must NOT treat as v1 / crash), adds its own entry, saves.
    const m = new SnapshotManager();
    m.loadCodebaseSnapshot();
    m.setCodebaseIndexing(P, 5);
    m.setFileCompleteForModel(P, PRIMARY, 'mine.ts', { complete: true, fileHash: 'mz', chunkCount: 1 });
    m.saveCodebaseSnapshot();

    const disk = readDisk(home);
    // The peer's codebase + file MUST survive (NOT wiped by an over-strict ==='v2').
    eq('peer.ts from the v3 file survived the merge', disk.codebases[P].files['peer.ts'],
        { complete: true, fileHash: 'pz', chunkCount: 1 });
    eq('our mine.ts merged in', disk.codebases[P].files['mine.ts'],
        { complete: true, fileHash: 'mz', chunkCount: 1 });
    eq('re-emitted as v2 (we never bump the version string)', disk.formatVersion, 'v2');
});

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
