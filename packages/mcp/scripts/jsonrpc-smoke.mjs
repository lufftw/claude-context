#!/usr/bin/env node
// Real JSON-RPC handshake smoke for the MCP binary.
// Asserts: exit 0; stdout is JSON-only (no protocol-corrupting noise);
//          tools/list is a SUPERSET of EXPECTED; no tool starts with FORBIDDEN_PREFIX;
//          no "Error" lines on stderr (excluding the redirected [LOG] / [WARN] shim).
// Inventory of actual tool names is written to $env:SMOKE_INVENTORY_OUT for manifest forensics.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const home = process.env.CLAUDE_CONTEXT_HOME;
if (!home || home.includes('claude-control-center')) {
  console.error(`[smoke] REFUSING TO RUN: CLAUDE_CONTEXT_HOME=${home}`);
  process.exit(2);
}

// EXPECTED tool list. Default [] makes the superset check vacuous;
// Task 0.7.8 patches this to the actual tool inventory captured at Task 0.7.0d.
const EXPECTED = ['clear_index','get_indexing_status','index_codebase','search_code'];
const FORBIDDEN_PREFIX = '_internal';

const binaryPath = path.join(repoRoot, 'packages/mcp/dist/index.js');
const child = spawn(process.execPath, [binaryPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env }
});

let stdoutBuf = '';
let stderrBuf = '';
const stdoutMessages = [];
let nonJsonStdout = false;

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line.trim().length === 0) continue;
    try { stdoutMessages.push(JSON.parse(line)); }
    catch { console.error(`[smoke] non-JSON on stdout: ${line.slice(0, 200)}`); nonJsonStdout = true; }
  }
});
child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const expect = async (id, timeoutMs = 120000) => {
  // Cold-start of @zilliz/milvus2-sdk-node + tree-sitter natives can take 20+s on Windows.
  // After Phase B1 cherry-picks, eager background-sync at boot delays initialize response
  // to ~60s on cold cache (19 codebases × ~20s each merkle scan). 120s budget covers warmup.
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    while (stdoutMessages.length) {
      const msg = stdoutMessages.shift();
      if (msg.id === id) return msg;
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for id=${id}`);
};

let exitCode = 0;
try {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } });
  const initResp = await expect(1);
  if (initResp.error) { console.error(`[smoke] initialize error:`, initResp.error); exitCode = 4; throw new Error('initialize failed'); }

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tlResp = await expect(2);
  if (tlResp.error) { console.error(`[smoke] tools/list error:`, tlResp.error); exitCode = 4; throw new Error('tools/list failed'); }

  const names = (tlResp.result?.tools ?? []).map(t => t.name).sort();

  // Superset check.
  const missing = EXPECTED.filter(n => !names.includes(n));
  if (missing.length) { console.error(`[smoke] missing expected tools: ${missing.join(', ')}`); exitCode = 6; throw new Error('missing tools'); }

  // Forbidden-prefix denylist.
  const forbidden = names.filter(n => n.startsWith(FORBIDDEN_PREFIX));
  if (forbidden.length) { console.error(`[smoke] forbidden tools present: ${forbidden.join(', ')}`); exitCode = 7; throw new Error('forbidden tools'); }

  // Record inventory for manifest log.
  if (process.env.SMOKE_INVENTORY_OUT) {
    fs.writeFileSync(process.env.SMOKE_INVENTORY_OUT, JSON.stringify({ tools: names }, null, 2));
  }
  console.error(`[smoke] inventory: ${JSON.stringify(names)}`);

  if (nonJsonStdout) { console.error(`[smoke] FAIL non-JSON on stdout`); exitCode = 3; throw new Error('non-JSON stdout'); }

  // Stderr: filter the redirect shim ([LOG]/[WARN] prefixes are expected). Real "Error" lines are not.
  const errLines = stderrBuf.split('\n').filter(l => /\bError\b/.test(l) && !/^\[(LOG|WARN)\]/.test(l));
  if (errLines.length) {
    console.error(`[smoke] unexpected Error on stderr: ${errLines[0]}`);
    exitCode = 7;
    throw new Error('unexpected error on stderr');
  }

  console.error('[smoke] OK initialize+tools/list');
} catch (e) {
  console.error(`[smoke] ${e.message}\nstderr tail:\n${stderrBuf.slice(-2000)}`);
  if (exitCode === 0) exitCode = 5;
} finally {
  child.kill('SIGTERM');
  // Give the child a moment to exit cleanly.
  await sleep(100);
  process.exit(exitCode);
}
