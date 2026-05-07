#!/usr/bin/env node
// Compute snapshot baseline using the SAME stripVolatile + JSON.stringify code as snapshot-smoke.mjs.
// Output (stdout): JSON object with baseline constants. Caller pipes into manifest and patcher.

import fs from 'node:fs';
import path from 'node:path';

const home = process.env.CLAUDE_CONTEXT_HOME;
if (!home) { console.error('[baseline] CLAUDE_CONTEXT_HOME required'); process.exit(2); }
if (home.includes('claude-control-center')) { console.error('[baseline] REFUSING production path'); process.exit(2); }

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
const fv = snap.formatVersion ?? 'v1';
const cbList = (fv === 'v2' ? Object.keys(snap.codebases) : (snap.indexedCodebases ?? [])).sort();
const idx = fv === 'v2'
  ? Object.values(snap.codebases).filter(c => c.status === 'indexed').length
  : cbList.length;

const baseline = {
  bytesStripped: Buffer.byteLength(JSON.stringify(stripped)),
  codebaseCount: cbList.length,
  indexedCount: idx,
  formatVersion: fv,
  codebasesSorted: cbList
};

process.stdout.write(JSON.stringify(baseline, null, 2));
