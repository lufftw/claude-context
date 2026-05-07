#!/usr/bin/env node
// Multi-mode locking + ALS isolation tester. NO live Milvus or RabbitMQ.
//
// Modes:
//   --write-once             : Single SnapshotManager.saveCodebaseSnapshot call with deterministic mutation; exit 0.
//                              Used by B3.3 forward-compat as a save-trigger.
//   --role=writer-A|writer-B : Acquire visible proper-lockfile lock, hold 1500ms while loading/modifying,
//                              save via SnapshotManager, release. Print is a SAVE-COMPLETION signal,
//                              not a lock-acquisition signal. The B3.4.4 assertion checks both writers'
//                              markers survive in the final snapshot (no last-writer-wins clobber)
//                              AND timestamp ranges show serialization.
//   --role=als-isolation     : Run N=200 (overridable via $env:ALS_ITERATIONS) concurrent runWithProject
//                              calls with random-jitter + double yield interleaving; assert no env leakage.
//
// Exit codes: 0=ok, 1=usage, 2=missing-home, 30=ALS leak, 31=envManager not resolvable.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const arg = (k) => process.argv.find(a => a === `--${k}` || a.startsWith(`--${k}=`));
const argVal = (k) => { const a = arg(k); if (!a) return undefined; const i = a.indexOf('='); return i < 0 ? true : a.slice(i + 1); };

const role = argVal('role');
const writeOnce = !!arg('write-once');
const home = argVal('home') ?? process.env.CLAUDE_CONTEXT_HOME;

const snapImportPath = process.env.SNAPSHOT_MGR_IMPORT
  ?? path.resolve(here, '..', 'dist', 'snapshot.js');

if (writeOnce) {
  if (!home) { console.error('--write-once requires --home or $CLAUDE_CONTEXT_HOME'); process.exit(2); }
  process.env.CLAUDE_CONTEXT_HOME = home;
  const mod = await import(snapImportPath);
  const SnapshotManager = mod.SnapshotManager ?? mod.default?.SnapshotManager;
  if (!SnapshotManager) { console.error('SnapshotManager not exported'); process.exit(2); }
  const sm = new SnapshotManager();
  const loaded = sm.loadCodebaseSnapshot ? sm.loadCodebaseSnapshot() : sm.load?.();
  const snap = loaded ?? { formatVersion: 'v2', codebases: {}, lastUpdated: new Date().toISOString() };
  const marker = '/_e2e_fixture_/' + Date.now();
  if ((snap?.formatVersion ?? 'v1') === 'v2') {
    snap.codebases = snap.codebases ?? {};
    snap.codebases[marker] = { status: 'indexed', indexedFiles: 1, totalChunks: 1, lastUpdated: new Date().toISOString() };
  } else {
    snap.indexedCodebases = (snap.indexedCodebases ?? []).concat([marker]);
  }
  if (typeof sm.saveCodebaseSnapshot === 'function') sm.saveCodebaseSnapshot(snap);
  else if (typeof sm.save === 'function') sm.save(snap);
  else { console.error('SnapshotManager has no save method'); process.exit(2); }
  console.error(`[locking] write-once OK marker=${marker}`);
  process.exit(0);
}

if (role === 'writer-A' || role === 'writer-B') {
  if (!home) { console.error('--role=writer-* requires --home or $CLAUDE_CONTEXT_HOME'); process.exit(2); }
  process.env.CLAUDE_CONTEXT_HOME = home;

  const lockfile = (await import('proper-lockfile')).default ?? (await import('proper-lockfile'));
  const mod = await import(snapImportPath);
  const SnapshotManager = mod.SnapshotManager ?? mod.default?.SnapshotManager;
  if (!SnapshotManager) { console.error('SnapshotManager not exported'); process.exit(2); }
  const sm = new SnapshotManager();
  const snapshotPath = path.join(home, 'mcp-codebase-snapshot.json');

  const acquireAt = new Date().toISOString();
  const release = await lockfile.lock(snapshotPath, { retries: { retries: 30, minTimeout: 100, maxTimeout: 500 } });
  console.error(`[locking] ${role} ACQUIRED at ${acquireAt}`);

  const loaded = sm.loadCodebaseSnapshot ? sm.loadCodebaseSnapshot() : sm.load?.();
  const snap = loaded ?? { formatVersion: 'v2', codebases: {}, lastUpdated: new Date().toISOString() };
  const marker = `/_locking_test_/${role}/${Date.now()}`;
  if ((snap?.formatVersion ?? 'v1') === 'v2') {
    snap.codebases = snap.codebases ?? {};
    snap.codebases[marker] = { status: 'indexed', lastUpdated: new Date().toISOString() };
  } else {
    snap.indexedCodebases = (snap.indexedCodebases ?? []).concat([marker]);
  }
  // Observable hold so contention is visible.
  await new Promise((r) => setTimeout(r, 1500));
  if (typeof sm.saveCodebaseSnapshot === 'function') sm.saveCodebaseSnapshot(snap);
  else if (typeof sm.save === 'function') sm.save(snap);

  const releaseAt = new Date().toISOString();
  await release();
  console.error(`[locking] ${role} RELEASED at ${releaseAt} marker=${marker}`);
  console.log(JSON.stringify({ role, acquireAt, releaseAt, marker }));
  process.exit(0);
}

if (role === 'als-isolation') {
  const envModPath = path.resolve(repoRoot, 'packages/core/dist/utils/env-manager.js');
  const envMod = await import(envModPath);
  const envManager = envMod.envManager
    ?? (envMod.EnvManager ? new envMod.EnvManager() : null)
    ?? envMod.default?.envManager
    ?? null;
  if (!envManager) {
    console.error('[locking] FAIL: cannot resolve envManager (neither singleton nor EnvManager class found)');
    process.exit(31);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const N = parseInt(process.env.ALS_ITERATIONS ?? '200', 10);
  const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const valA = `colA-${i}`;
    const valB = `colB-${i}`;
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'als-A-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'als-B-'));
    fs.writeFileSync(path.join(tmpA, '.env'), `MILVUS_COLLECTION_PRIVATE=${valA}\n`);
    fs.writeFileSync(path.join(tmpB, '.env'), `MILVUS_COLLECTION_PRIVATE=${valB}\n`);

    let leakedA = false, leakedB = false;
    const taskA = envManager.runWithProject(tmpA, async () => {
      await sleep(Math.floor(Math.random() * 5));
      const got1 = envManager.get('MILVUS_COLLECTION_PRIVATE');
      if (got1 !== valA) leakedA = true;
      await new Promise((r) => setImmediate(r));
      const got2 = envManager.get('MILVUS_COLLECTION_PRIVATE');
      if (got2 !== valA) leakedA = true;
      return got2;
    });
    const taskB = envManager.runWithProject(tmpB, async () => {
      await sleep(Math.floor(Math.random() * 5));
      const got1 = envManager.get('MILVUS_COLLECTION_PRIVATE');
      if (got1 !== valB) leakedB = true;
      await new Promise((r) => setImmediate(r));
      const got2 = envManager.get('MILVUS_COLLECTION_PRIVATE');
      if (got2 !== valB) leakedB = true;
      return got2;
    });
    const [a, b] = await Promise.all([taskA, taskB]);
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
    return { i, a, b, leakedA, leakedB };
  }));

  const leaks = results.filter(r => r.leakedA || r.leakedB);
  if (leaks.length) {
    console.error(`[locking] ALS isolation FAIL: ${leaks.length}/${N} iterations leaked`);
    console.error(JSON.stringify(leaks.slice(0, 5), null, 2));
    process.exit(30);
  }
  console.error(`[locking] ALS isolation OK: ${N}/${N} iterations preserved isolation`);
  process.exit(0);
}

console.error('Specify --write-once or --role={writer-A|writer-B|als-isolation}');
process.exit(1);
