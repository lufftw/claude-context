#!/usr/bin/env node
// Snapshot smoke: validates the production-baseline numbers (computed via baseline-capture.mjs)
// AND round-trips V1/V2 fixtures through SnapshotManager.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const home = process.env.CLAUDE_CONTEXT_HOME;
if (!home || home.includes('claude-control-center')) {
  console.error(`[snap-smoke] REFUSING: CLAUDE_CONTEXT_HOME=${home}`);
  process.exit(2);
}

// Baseline values — populated by Task 0.7.8 via whole-pattern swap on the leading-comment markers.
const BASELINE = {
  bytesStripped: 2568,
  codebaseCount: 19,
  indexedCount:  19,
  formatVersion: 'v2',
  codebasesSorted: ["E:\\Developer\\lufftw\\repo\\claude-context","E:\\Developer\\lufftw\\repo\\dev-machine-setup","E:\\Developer\\lufftw\\repo\\event-chat-repo","E:\\Developer\\lufftw\\repo\\event-chat-service","E:\\Developer\\lufftw\\repo\\event-crawler","E:\\Developer\\lufftw\\repo\\event-crawler-worker","E:\\Developer\\lufftw\\repo\\event-model-worker","E:\\Developer\\lufftw\\repo\\event-platform-infra","E:\\Developer\\lufftw\\repo\\event-search-service","E:\\Developer\\lufftw\\repo\\finetune-datasets","E:\\Developer\\lufftw\\repo\\gpu-coordinator","E:\\Developer\\lufftw\\repo\\harness-research","E:\\Developer\\lufftw\\repo\\mcp-doc-search","E:\\Developer\\lufftw\\repo\\mcp-services","E:\\Developer\\lufftw\\repo\\milvus-services","E:\\Developer\\lufftw\\repo\\organization-data-layer","E:\\Developer\\lufftw\\repo\\poi-data-layer","E:\\Developer\\lufftw\\repo\\poi-data-layer-crawler-worker","E:\\Developer\\lufftw\\repo\\taiwan-address-normalizer"]
};

const stripVolatile = (obj) => {
  const out = JSON.parse(JSON.stringify(obj));
  delete out.lastUpdated;
  delete out.lastSync;
  if (out.codebases) {
    for (const k of Object.keys(out.codebases)) {
      delete out.codebases[k].lastUpdated;
      delete out.codebases[k].lastSync;
    }
  }
  return out;
};

const snapPath = path.join(home, 'mcp-codebase-snapshot.json');
const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const stripped = stripVolatile(snap);
const bytes = Buffer.byteLength(JSON.stringify(stripped));
if (bytes !== BASELINE.bytesStripped) {
  console.error(`[snap-smoke] FAIL stripped bytes: ${bytes} != ${BASELINE.bytesStripped}`);
  process.exit(10);
}
const fv = snap.formatVersion ?? 'v1';
if (fv !== BASELINE.formatVersion) {
  console.error(`[snap-smoke] FAIL formatVersion: ${fv} != ${BASELINE.formatVersion}`);
  process.exit(11);
}
const cbList = (fv === 'v2' ? Object.keys(snap.codebases) : (snap.indexedCodebases ?? [])).sort();
if (cbList.length !== BASELINE.codebaseCount) {
  console.error(`[snap-smoke] FAIL codebase count: ${cbList.length} != ${BASELINE.codebaseCount}`);
  process.exit(12);
}
if (JSON.stringify(cbList) !== JSON.stringify(BASELINE.codebasesSorted)) {
  console.error(`[snap-smoke] FAIL codebase list mismatch`);
  console.error(`got:  ${JSON.stringify(cbList)}`);
  console.error(`want: ${JSON.stringify(BASELINE.codebasesSorted)}`);
  process.exit(13);
}
const idx = fv === 'v2'
  ? Object.values(snap.codebases).filter(c => c.status === 'indexed').length
  : cbList.length;
if (idx !== BASELINE.indexedCount) {
  console.error(`[snap-smoke] FAIL indexed count: ${idx} != ${BASELINE.indexedCount}`);
  process.exit(14);
}

// V1/V2 fixture round-trip.
const importPath = process.env.SNAPSHOT_MGR_IMPORT
  ?? path.resolve(here, '..', 'dist', 'snapshot.js');
const mod = await import(importPath);
const SnapshotManager = mod.SnapshotManager ?? mod.default?.SnapshotManager;
if (!SnapshotManager) {
  console.error('[snap-smoke] FAIL: SnapshotManager not found in', importPath);
  process.exit(15);
}

for (const fixture of ['snapshot-v1.json', 'snapshot-v2.json']) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-fixture-'));
  fs.copyFileSync(path.join(repoRoot, 'packages/mcp/__fixtures__', fixture), path.join(tmpHome, 'mcp-codebase-snapshot.json'));
  const prevHome = process.env.CLAUDE_CONTEXT_HOME;
  process.env.CLAUDE_CONTEXT_HOME = tmpHome;
  try {
    const sm = new SnapshotManager();
    const loaded = sm.loadCodebaseSnapshot ? sm.loadCodebaseSnapshot() : sm.load?.();
    if (!loaded) { console.error(`[snap-smoke] FAIL ${fixture}: load returned falsy`); process.exit(16); }
    console.error(`[snap-smoke] ${fixture}: loaded`);
  } finally {
    process.env.CLAUDE_CONTEXT_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

console.error('[snap-smoke] OK production-baseline + V1 + V2 fixtures pass');
process.exit(0);
