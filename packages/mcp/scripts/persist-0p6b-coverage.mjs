#!/usr/bin/env node
// Phase 5 — persist the 0.6B distinct-PK coverage ratio into the snapshot so the
// (deployed) new dist's search degrade-gate marks the *_0p6b collection readable.
//
//   node persist-0p6b-coverage.mjs <codebasePath> <modelId> <ratio>
//   env: CLAUDE_CONTEXT_HOME (snapshot home), default = the shared 61server home.
//
// SAFE-WRITE (important): we do a lock-guarded read-modify-write of the snapshot
// JSON, ADDING `coverageByModel[modelId]` to the existing codebase entry while
// preserving its status/indexedFiles/totalChunks/files and every OTHER entry.
//
// Do NOT use `new SnapshotManager().setCoverageRatioForModel(...) + saveCodebaseSnapshot()`
// on an already-`indexed` entry: a fresh (unloaded) manager seeds a minimal
// `{status:'indexing'}` entry and mergeAndWriteSnapshot's `{...info}` lets it
// CLOBBER the on-disk `indexed` status (the exhaustive carry-forward lives in the
// status-transition methods, not the disk merge). FOLLOW-UP: harden
// setCoverageRatioForModel to a partial-merge (or require a prior load) so the
// shipped path is safe; until then this surgical writer is the sanctioned path.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json')); // resolve worktree node_modules
const lockfile = require('proper-lockfile');

const codebasePath = process.argv[2] || 'E:\\Developer\\lufftw\\repo\\claude-context';
const modelId = process.argv[3] || 'qwen3-embedding-0.6b';
const ratio = Number(process.argv[4] ?? 0.999187);

const home = process.env.CLAUDE_CONTEXT_HOME
  || 'E:\\Developer\\lufftw\\repo\\claude-control-center\\mcp\\61server\\share\\claude-context\\.context';
const SNAP = path.join(home, 'mcp-codebase-snapshot.json');

if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
  console.error(`refusing: ratio ${ratio} out of [0,1]`); process.exit(2);
}
const release = await lockfile.lock(SNAP, { retries: 8, stale: 60000 });
try {
  const d = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const e = d.codebases?.[codebasePath];
  if (!e) { console.error(`refusing: no codebase entry for '${codebasePath}' — index it first`); process.exit(3); }
  e.coverageByModel = { ...(e.coverageByModel || {}), [modelId]: ratio };
  fs.writeFileSync(SNAP, JSON.stringify(d, null, 2) + '\n');
  console.error(`OK: ${codebasePath} coverageByModel[${modelId}]=${ratio} (status=${e.status} preserved); total codebases=${Object.keys(d.codebases).length}`);
} finally {
  await release();
}
