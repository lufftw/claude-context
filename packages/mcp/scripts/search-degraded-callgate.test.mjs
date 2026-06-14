#!/usr/bin/env node
// packages/mcp/scripts/search-degraded-callgate.test.mjs
//
// C4 / M1 — hermetic CallTool DEGRADED-RESPONSE dist-gate.
//
// Closes the binary-acceptance gap: the structured degraded payload
//   { degraded: true, reason: 'secondary-not-configured', results: [] }
// was previously asserted only at the CORE layer + a tools/list schema gate.
// This gate parses it from a REAL JSON-RPC `tools/call` round-trip against the
// COMPILED dist binary — the exact bytes that ship — so the contract the LLM
// actually receives is pinned end-to-end. Assertions are on the PARSED object
// (JSON.parse of result.content[0].text), NEVER substring.
//
// Hermetic: NO broker, NO Milvus needed. The search handler short-circuits on
//   hasEmbeddingForModel('qwen3-embedding-0.6b') === false  (secondary OFF — no
//   MILVUS_COLLECTION_PRIVATE_0P6B) BEFORE any embedding/ANN network call. The
//   ONLY pre-short-circuit network touch is syncIndexedCodebasesFromCloud(); we
//   point MILVUS_ADDRESS at a DEAD loopback port so that call fails fast
//   (ECONNREFUSED) and is swallowed by the handler's try/catch WITHOUT mutating
//   the seeded snapshot. (Pointing it at a LIVE Milvus would let the cloud-sync
//   PRUNE our throwaway temp codebase from the snapshot — defeating the gate.)
//
// gRPC quirk + the preload shim: the Milvus gRPC client emits a SEPARATE,
// unhandled rejection for the in-flight showCollections() request even though
// the handler's awaited promise already caught it. Node's default crashes the
// process on an unhandled rejection — which would kill the child before the
// (already-correct) handler continuation writes the degraded response. We inject
// a tiny CJS preload via NODE_OPTIONS that swallows ONLY connection-class
// rejections (ECONNREFUSED / "No connection established" / UNAVAILABLE /
// deadline) and RETHROWS everything else, so a REAL fault still crashes loud.
// This shim touches NOTHING in the handler logic under test.
//
// Red→green proof: change the asserted reason string below to e.g. 'wrong' and
// the `reason === 'secondary-not-configured'` assertion fails → exit 1; restore
// it → exit 0. (The handler emits the literal 'secondary-not-configured'.)
//
// Run (from repo root, after pnpm build:mcp):
//   node packages/mcp/scripts/search-degraded-callgate.test.mjs
//   (or: pnpm --filter @zilliz/claude-context-mcp test:degraded-callgate)
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

if (!fs.existsSync(binaryPath)) {
    console.error(`[degraded-callgate] MISSING compiled artifact: ${binaryPath}\nRun 'pnpm build:mcp' first.`);
    process.exit(2);
}

// Blast-radius protection: REFUSE the shared multi-user snapshot home; always
// run against a throwaway temp home (recovery: unset CLAUDE_CONTEXT_HOME).
if (process.env.CLAUDE_CONTEXT_HOME && process.env.CLAUDE_CONTEXT_HOME.includes('claude-control-center')) {
    console.error(`[degraded-callgate] REFUSING TO RUN: CLAUDE_CONTEXT_HOME=${process.env.CLAUDE_CONTEXT_HOME}`);
    console.error('[degraded-callgate] Recovery: unset CLAUDE_CONTEXT_HOME or point it at a throwaway temp dir.');
    process.exit(2);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-degraded-home-'));
const tempCodebase = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-degraded-cb-'));
// A real file so the dir is unambiguously a populated codebase on disk
// (loadV2Format drops codebase entries whose path no longer exists as ghosts).
fs.writeFileSync(path.join(tempCodebase, 'sample.ts'), 'export const x = 1;\n');

// Seed the snapshot so the handler sees tempCodebase as INDEXED. The degraded
// short-circuit lives AFTER the isIndexed/isIndexing gate, and getIndexedCodebases()
// reads this file directly from disk — so this is what carries us to the branch.
const snapshot = {
    formatVersion: 'v2',
    codebases: {
        [tempCodebase]: {
            status: 'indexed',
            indexedFiles: 1,
            totalChunks: 1,
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString(),
            files: { 'sample.ts': { complete: true, fileHash: 'h', chunkCount: 1 } }
        }
    },
    lastUpdated: new Date().toISOString()
};
fs.writeFileSync(path.join(tempHome, 'mcp-codebase-snapshot.json'), JSON.stringify(snapshot, null, 2));

// CJS preload (Windows-native absolute path) that keeps the child alive against
// the Milvus gRPC client's stray connection-class unhandled rejection. Only
// connection noise is swallowed; anything else is rethrown so real faults crash.
const preloadPath = path.join(tempHome, 'swallow-grpc-conn.cjs');
fs.writeFileSync(preloadPath, [
    "process.on('unhandledRejection', (reason) => {",
    "  const s = (reason && (reason.details || reason.message)) ? String(reason.details || reason.message) : String(reason);",
    "  if (/ECONNREFUSED|No connection established|UNAVAILABLE|deadline/i.test(s)) {",
    "    console.error('[swallow-grpc-conn] swallowed connection-class unhandledRejection: ' + s.slice(0, 140));",
    "    return;",
    "  }",
    "  throw reason;",
    "});",
    '',
].join('\n'));

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ✓ ${name}`);
    else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Secondary OFF: NO MILVUS_COLLECTION_PRIVATE_0P6B, NO RABBITMQ_SECONDARY_QUEUE,
// NO SEARCH_EMBEDDING_MODEL (so the model arg is honored, not env-overridden).
// Dummy OpenAI key so the default provider constructs (embed() is never called —
// the handler short-circuits first). Dead Milvus port so cloud-sync fails fast.
const childEnv = {
    ...process.env,
    CLAUDE_CONTEXT_HOME: tempHome,
    OPENAI_API_KEY: 'sk-dummy-degraded-gate',
    MILVUS_ADDRESS: '127.0.0.1:1', // dead loopback port → fast ECONNREFUSED
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require ${JSON.stringify(preloadPath)}`,
};
delete childEnv.MILVUS_COLLECTION_PRIVATE_0P6B; // ensure secondary is OFF
delete childEnv.RABBITMQ_SECONDARY_QUEUE;
delete childEnv.SEARCH_EMBEDDING_MODEL;

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
        catch { console.error(`[degraded-callgate] non-JSON on stdout: ${line.slice(0, 200)}`); nonJsonStdout = true; }
    }
});
child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
const expect = async (id, timeoutMs = 60000) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
        while (stdoutMessages.length) { const m = stdoutMessages.shift(); if (m.id === id) return m; }
        await sleep(50);
    }
    throw new Error(`timeout waiting for id=${id}`);
};

let exitCode = 0;
try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'degraded-callgate', version: '1.0' } } });
    const initResp = await expect(1);
    if (initResp.error) throw new Error(`initialize error: ${JSON.stringify(initResp.error)}`);

    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // The real round-trip: search_code requesting the (unconfigured) secondary model.
    send({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'search_code', arguments: { path: tempCodebase, query: 'x', embeddingModel: 'qwen3-embedding-0.6b' } }
    });
    const callResp = await expect(2);

    check('CallTool returned a result (no JSON-RPC error)', !callResp.error, `error=${JSON.stringify(callResp.error)}`);
    check('result is NOT an isError tool response', callResp.result && callResp.result.isError !== true,
        `isError=${callResp.result?.isError}`);

    const text = callResp.result?.content?.[0]?.text;
    check('result.content[0].text is present', typeof text === 'string', `content=${JSON.stringify(callResp.result?.content)}`);

    let parsed;
    let parsedOk = false;
    try { parsed = JSON.parse(text); parsedOk = true; } catch {
        check('result text is valid JSON (structured degraded payload, not a prose error)', false,
            `text=${JSON.stringify(text)?.slice(0, 300)}`);
    }
    if (parsedOk) {
        check('parsed.degraded === true', parsed.degraded === true, `degraded=${JSON.stringify(parsed.degraded)}`);
        check("parsed.reason === 'secondary-not-configured'", parsed.reason === 'secondary-not-configured',
            `reason=${JSON.stringify(parsed.reason)}`);
        check('parsed.results is an empty array', Array.isArray(parsed.results) && parsed.results.length === 0,
            `results=${JSON.stringify(parsed.results)}`);
    }

    check('stdout stayed JSON-only (JSON-RPC sanctity)', !nonJsonStdout);
} catch (e) {
    console.error(`[degraded-callgate] ${e.message}\nstderr tail:\n${stderrBuf.slice(-2000)}`);
    failures++;
} finally {
    child.kill('SIGTERM');
    await sleep(100);
    try { fs.rmSync(tempHome, { recursive: true, force: true }); } catch { }
    try { fs.rmSync(tempCodebase, { recursive: true, force: true }); } catch { }
    exitCode = failures === 0 ? 0 : 1;
    console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
    process.exit(exitCode);
}
