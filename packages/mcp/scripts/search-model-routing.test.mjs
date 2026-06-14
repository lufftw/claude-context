#!/usr/bin/env node
// packages/mcp/scripts/search-model-routing.test.mjs
// D6 (schema arm) + D7: real MCP ListTools + CallTool round-trip against the
// COMPILED dist binary. Asserts on PARSED JSON-RPC objects — never substring.
//
// Layer A (always): tools/list served schema for search_code carries an
//   `embeddingModel` enum [qwen3-embedding-8b, qwen3-embedding-0.6b] with
//   default qwen3-embedding-8b.
// Layer B (MCP_LIVE_ROUTING=1 only): CallTool search_code with
//   embeddingModel=qwen3-embedding-0.6b on a configured codebase; assert the
//   server's stderr structured logs show the 0.6B queue + dim 1024 (the route
//   actually fired). Tolerates WAIT-class worker lag (no REAL misclassification).
//
// Run (from repo root, after pnpm build:mcp):
//   CLAUDE_CONTEXT_HOME=/tmp/cc-route-$$ node packages/mcp/scripts/search-model-routing.test.mjs
// Exits 0 on success, non-zero on the first failed assertion.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const binaryPath = path.join(repoRoot, 'packages/mcp/dist/index.js');

// Blast-radius protection: REFUSE to run against the shared multi-user snapshot
// home (recovery: unset CLAUDE_CONTEXT_HOME or point it at a throwaway temp dir).
// When CLAUDE_CONTEXT_HOME is UNSET, auto-provision a throwaway temp home so the
// gate is runnable via `pnpm run test:search-routing` without manual setup and
// without ever touching the real snapshot.
let ownTempHome;
if (process.env.CLAUDE_CONTEXT_HOME && process.env.CLAUDE_CONTEXT_HOME.includes('claude-control-center')) {
    console.error(`[route-test] REFUSING TO RUN: CLAUDE_CONTEXT_HOME=${process.env.CLAUDE_CONTEXT_HOME}`);
    console.error('[route-test] Recovery: unset CLAUDE_CONTEXT_HOME or point it at a throwaway temp dir.');
    process.exit(2);
}
if (!process.env.CLAUDE_CONTEXT_HOME) {
    ownTempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-route-'));
    process.env.CLAUDE_CONTEXT_HOME = ownTempHome;
    console.error(`[route-test] CLAUDE_CONTEXT_HOME was unset → using throwaway temp home ${ownTempHome}`);
}

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ✓ ${name}`);
    else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Layer A is hermetic: the binary must boot far enough to serve tools/list without
// any network. The OpenAI default provider throws at construction without a key, so
// inject a DUMMY key (no embed() is ever called in Layer A → no network). When the
// caller supplies a real env (Layer B / live), their values win via the spread.
const childEnv = {
    OPENAI_API_KEY: 'sk-dummy-schema-gate',
    MILVUS_ADDRESS: '127.0.0.1:19530',
    ...process.env,
};
const child = spawn(process.execPath, [binaryPath], { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
let stdoutBuf = '';
let stderrBuf = '';
const stdoutMessages = [];
let nonJsonStdout = false;
child.stdout.on('data', (c) => {
    stdoutBuf += c.toString('utf8');
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl); stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line.trim()) continue;
        try { stdoutMessages.push(JSON.parse(line)); }
        catch { console.error(`[route-test] non-JSON on stdout: ${line.slice(0, 200)}`); nonJsonStdout = true; }
    }
});
child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const expect = async (id, timeoutMs = 120000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
        while (stdoutMessages.length) { const m = stdoutMessages.shift(); if (m.id === id) return m; }
        await sleep(50);
    }
    throw new Error(`timeout waiting for id=${id}`);
};

let exitCode = 0;
try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'route-test', version: '1.0' } } });
    const initResp = await expect(1);
    if (initResp.error) throw new Error(`initialize error: ${JSON.stringify(initResp.error)}`);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tl = await expect(2);
    if (tl.error) throw new Error(`tools/list error: ${JSON.stringify(tl.error)}`);

    // ── Layer A: parsed-object schema assertions ──────────────────────────────
    const tools = tl.result?.tools ?? [];
    const search = tools.find(t => t.name === 'search_code');
    check('search_code tool is served', !!search);
    const prop = search?.inputSchema?.properties?.embeddingModel;
    check('search_code.inputSchema has embeddingModel property', !!prop, `properties=${Object.keys(search?.inputSchema?.properties ?? {}).join(',')}`);
    check('embeddingModel type is string', prop?.type === 'string', `type=${prop?.type}`);
    const enumVals = Array.isArray(prop?.enum) ? [...prop.enum].sort() : [];
    check('embeddingModel enum is exactly the two canonical ids',
        JSON.stringify(enumVals) === JSON.stringify(['qwen3-embedding-0.6b', 'qwen3-embedding-8b']),
        `enum=${JSON.stringify(prop?.enum)}`);
    check('embeddingModel default is the primary 8B id', prop?.default === 'qwen3-embedding-8b', `default=${prop?.default}`);
    check('stdout stayed JSON-only (JSON-RPC sanctity)', !nonJsonStdout);

    // ── Layer B: live routing (env-gated) ─────────────────────────────────────
    if (process.env.MCP_LIVE_ROUTING === '1') {
        const cb = process.env.ROUTE_TEST_CODEBASE;
        check('ROUTE_TEST_CODEBASE is set for live routing', !!cb, 'set ROUTE_TEST_CODEBASE to a configured-codebase abs path');
        if (cb) {
            stderrBuf = ''; // window the stderr capture to the call
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_code', arguments: { path: cb, query: 'function', limit: 3, embeddingModel: 'qwen3-embedding-0.6b' } } });
            // 0.6B priority-1 backfill worker may lag (WAIT-class) — generous budget; lag != REAL.
            const callResp = await expect(3, 300000);
            check('CallTool returned a result object (no JSON-RPC error)', !callResp.error, `error=${JSON.stringify(callResp.error)}`);
            // The route fired iff the server logged the 0.6B routing line AND the 0.6B
            // dimension/queue surfaced in the structured stderr. Parse the stderr lines.
            const routedLine = stderrBuf.split('\n').some(l => l.includes('Routing search via embedding model: qwen3-embedding-0.6b'));
            check('server logged routing to qwen3-embedding-0.6b', routedLine);
            const dim1024 = stderrBuf.split('\n').some(l => /dimension:\s*1024\b/.test(l));
            check('query vector dimension was 1024 (0.6B space)', dim1024, 'no "dimension: 1024" trace found');
            // WAIT-class tolerance: a no-consumer/timeout reply must NOT fail the gate as REAL.
            const realFault = stderrBuf.split('\n').some(l => /bad-dimension|worker-error|insert-error/.test(l));
            check('no REAL-class fault on the 0.6B route', !realFault, 'REAL-class fault surfaced');
        }
    } else {
        console.log('  · Layer B (live routing) skipped (set MCP_LIVE_ROUTING=1 + ROUTE_TEST_CODEBASE to enable)');
    }
} catch (e) {
    console.error(`[route-test] ${e.message}\nstderr tail:\n${stderrBuf.slice(-2000)}`);
    failures++;
} finally {
    child.kill('SIGTERM');
    await sleep(100);
    if (ownTempHome) { try { fs.rmSync(ownTempHome, { recursive: true, force: true }); } catch { } }
    exitCode = failures === 0 ? 0 : 1;
    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
    process.exit(exitCode);
}
