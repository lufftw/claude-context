#!/usr/bin/env node
// End-to-end check of the built MCP server against a real Milvus. Cross-platform (Windows, Linux, macOS).
//
//   pnpm build:core && pnpm build:mcp
//   MILVUS_ADDRESS=127.0.0.1:19530 node packages/mcp/scripts/e2e-live.mjs
//   (PowerShell:  $env:MILVUS_ADDRESS="127.0.0.1:19530"; node packages/mcp/scripts/e2e-live.mjs)
//
// RabbitMQ mode: also set RABBITMQ_INFERENCE_URL (e.g. amqp://guest:guest@127.0.0.1:5672). The server then
// runs with EMBEDDING_PROVIDER=RabbitMQ against a throwaway queue served by an in-process stub worker that
// speaks the provider's task/reply protocol, and the test asserts the requests went through the broker.
//
// Needs only a reachable Milvus 2.5+ (MILVUS_ADDRESS, optional MILVUS_TOKEN). Embeddings come from an
// in-process OpenAI-compatible stub (deterministic bag-of-words vectors), so no API key or GPU is used.
// Everything runs in a temporary home/project and the test collection is dropped at the end.
//
// It drives the real server over stdio with the MCP SDK client and checks: index_codebase, status,
// search ranking, gitignore negation, hidden-file exclusion (.env), .contextinclude, project-scoped .env
// collection naming, subdirectory search, incremental sync via the trigger file, and clear_index.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MilvusVectorDatabase } from '@zilliz/claude-context-core';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || '127.0.0.1:19530';
const MILVUS_TOKEN = process.env.MILVUS_TOKEN; // optional; never printed
const RABBITMQ_URL = process.env.RABBITMQ_INFERENCE_URL; // optional; enables RabbitMQ mode; never printed
const serverEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
    if (!ok) failures++;
};

// ── embedding stub ─────────────────────────────────────────────────────────────
const DIM = RABBITMQ_URL ? 4096 : 1536; // RabbitMQ mode mirrors the production qwen3-embedding-8b dimension
function embed(text) {
    const v = new Array(DIM).fill(0);
    for (const w of String(text).toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []) {
        v[crypto.createHash('md5').update(w).digest().readUInt32LE(0) % DIM] += 1;
    }
    let sumSq = 0;
    for (const x of v) sumSq += x * x;
    const n = Math.sqrt(sumSq) || 1;
    return v.map(x => x / n || 1e-4);
}
const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            object: 'list', model: parsed.model,
            data: input.map((t, index) => ({ object: 'embedding', index, embedding: embed(t) })),
            usage: { prompt_tokens: 0, total_tokens: 0 },
        }));
    });
});
await new Promise(r => stub.listen(0, '127.0.0.1', r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/v1`;

// ── RabbitMQ stub worker (RabbitMQ mode only) ──────────────────────────────────
const rmqQueue = `e2e.embedding.${crypto.randomBytes(4).toString('hex')}`;
let rmqConn, rmqCh, rmqRequests = 0;
if (RABBITMQ_URL) {
    // amqplib is a dependency of the core package, not of this one.
    const amqp = createRequire(fileURLToPath(new URL('../../core/package.json', import.meta.url)))('amqplib');
    rmqConn = await amqp.connect(RABBITMQ_URL);
    rmqCh = await rmqConn.createChannel();
    await rmqCh.assertQueue(rmqQueue, { durable: false, autoDelete: true, arguments: { 'x-max-priority': 10 } });
    await rmqCh.prefetch(16);
    await rmqCh.consume(rmqQueue, (msg) => {
        if (!msg) return;
        rmqRequests++;
        const task = JSON.parse(msg.content.toString('utf8'));
        const input = task.payload?.texts?.[0] ?? task.prompt;
        const reply = { taskId: task.id, success: true, content: JSON.stringify([embed(input)]), durationMs: 1 };
        rmqCh.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(reply)), { correlationId: msg.properties.correlationId });
        rmqCh.ack(msg);
    });
}

// ── temporary home + project ───────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-e2e-'));
const home = path.join(tmp, 'home');
const project = path.join(tmp, 'project');
const collection = `e2e_${crypto.randomBytes(4).toString('hex')}`;
const write = (rel, text) => {
    const p = path.join(project, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
};
fs.mkdirSync(path.join(home, '.context'), { recursive: true });
write('src/math.ts', 'export function fibonacci(n: number): number {\n  // fibonacci sequence recursion\n  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);\n}\n');
write('src/auth.ts', 'export async function login(user: string, password: string) {\n  // verify password hash for login session\n  return verifyPasswordHash(user, password);\n}\n');
write('generated/skipped.ts', 'export const zebracornskipped = "zebracornskipped";\n');
write('generated/kept.ts', 'export const quokkakept = "quokkakept";\n');
write('.gitignore', 'generated/*\n!generated/kept.ts\n');
write('.github/scripts/deploy.ts', 'export function deployPipelineNarwhal() { return "narwhal deploy pipeline"; }\n');
write('.contextinclude', '.github\n');
// Project-scoped .env: names the collection (fork feature) and must itself never be indexed.
write('.env', `MILVUS_COLLECTION_PRIVATE=${collection}\nE2E_MARKER=platypussecretmarker\n`);

const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home, // os.homedir() on Windows
    CLAUDE_CONTEXT_HOME: path.join(home, '.context'),
    ...(RABBITMQ_URL ? {
        EMBEDDING_PROVIDER: 'RabbitMQ',
        EMBEDDING_MODEL: 'qwen3-embedding-8b',
        RABBITMQ_EMBEDDING_QUEUE: rmqQueue,
        RABBITMQ_EMBEDDING_DIMENSION: String(DIM),
        RABBITMQ_EMBEDDING_TIMEOUT_MS: '60000',
    } : {
        EMBEDDING_PROVIDER: 'OpenAI',
        EMBEDDING_MODEL: 'text-embedding-3-small',
        OPENAI_API_KEY: 'sk-dummy-e2e-local-stub',
        OPENAI_BASE_URL: stubUrl,
    }),
    MILVUS_ADDRESS,
    CLAUDE_CONTEXT_BACKGROUND_SYNC: 'false',
    CLAUDE_CONTEXT_TRIGGER_WATCHER: 'true',
};
for (const k of ['MILVUS_COLLECTION_PRIVATE', 'MILVUS_COLLECTION_SHARED', 'MILVUS_WRITABLE_SHARED',
    'MILVUS_COLLECTION_PRIVATE_0P6B', 'CODE_CHUNKS_COLLECTION_NAME_OVERRIDE', 'SEARCH_EMBEDDING_MODEL']) delete env[k];

const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stderr: 'pipe' });
let serverLog = '';
transport.stderr?.on('data', c => { serverLog += c.toString(); });
const client = new Client({ name: 'e2e-live', version: '1.0.0' });
const milvus = new MilvusVectorDatabase({ address: MILVUS_ADDRESS, ...(MILVUS_TOKEN ? { token: MILVUS_TOKEN } : {}) });

const text = (r) => (r.content || []).map(c => c.text || '').join('\n');
const call = async (name, args) => text(await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 }));
const firstLocation = (t) => (t.match(/Location: ([^:\n]+):/) || [])[1]?.replace(/\\/g, '/');
const waitFor = async (fn, timeoutMs, stepMs = 1000) => {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v || Date.now() > end) return v;
        await sleep(stepMs);
    }
};

try {
    console.log(`e2e-live: node ${process.version} on ${process.platform}; Milvus ${MILVUS_ADDRESS}; collection ${collection}; provider ${RABBITMQ_URL ? `RabbitMQ (queue ${rmqQueue})` : 'OpenAI-compatible stub'}`);
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map(t => t.name).sort();
    check('server lists the 4 tools', ['clear_index', 'get_indexing_status', 'index_codebase', 'search_code'].every(t => tools.includes(t)), tools.join(','));

    const started = await call('index_codebase', { path: project });
    check('index_codebase starts', /Started background indexing/.test(started), started);

    const status = await waitFor(async () => {
        const s = await call('get_indexing_status', { path: project });
        return /fully indexed/.test(s) || /failed/i.test(s) ? s : null;
    }, 180000, 2000);
    check('indexing completes', /fully indexed/.test(status || ''), status || 'timed out');

    const collections = await milvus.listCollections();
    check('project .env names the collection (MILVUS_COLLECTION_PRIVATE)', collections.includes(collection), collections.join(','));

    const s1 = await call('search_code', { path: project, query: 'fibonacci sequence recursion', limit: 3 });
    check('search ranks src/math.ts first', firstLocation(s1) === 'src/math.ts', s1.slice(0, 400));
    const s2 = await call('search_code', { path: project, query: 'login password hash', limit: 3 });
    check('search ranks src/auth.ts first', firstLocation(s2) === 'src/auth.ts', s2.slice(0, 400));
    const s3 = await call('search_code', { path: project, query: 'quokkakept', limit: 10 });
    check('gitignore negation re-includes generated/kept.ts', /generated[\\/]kept\.ts/.test(s3), s3.slice(0, 400));
    const s4 = await call('search_code', { path: project, query: 'zebracornskipped', limit: 10 });
    check('gitignored generated/skipped.ts is not indexed', !/skipped\.ts/.test(s4), s4.slice(0, 400));
    const s5 = await call('search_code', { path: project, query: 'deployPipelineNarwhal narwhal deploy pipeline', limit: 3 });
    check('.contextinclude indexes .github/scripts/deploy.ts', /\.github[\\/]scripts[\\/]deploy\.ts/.test(s5), s5.slice(0, 400));
    const s6 = await call('search_code', { path: project, query: 'platypussecretmarker E2E_MARKER', limit: 10 });
    // Inspect result locations/snippets only: the response header echoes the query text.
    check('.env file is never indexed', !/Location: \.env\b/.test(s6) && !/platypussecretmarker/.test(s6.replace(/^Found .*$/m, '')), s6.slice(0, 400));
    const s7 = await call('search_code', { path: path.join(project, 'src'), query: 'fibonacci', limit: 3 });
    check('search on a subdirectory resolves to the indexed root', /src[\\/]math\.ts/.test(s7), s7.slice(0, 400));

    // Incremental sync via the trigger file (debounced ~2s by the server).
    write('src/added.ts', 'export function walrusTelemetry() { return "walrus telemetry"; }\n');
    await sleep(300);
    fs.writeFileSync(path.join(home, '.context', '.sync-trigger'), String(Date.now()));
    const synced = await waitFor(async () => {
        const s = await call('search_code', { path: project, query: 'walrusTelemetry walrus telemetry', limit: 3 });
        return /src[\\/]added\.ts/.test(s) ? s : null;
    }, 90000, 3000);
    check('trigger file re-indexes a newly added file', !!synced, 'src/added.ts not found after sync');

    if (RABBITMQ_URL) check('embeddings were served through RabbitMQ', rmqRequests > 0, `worker saw ${rmqRequests} request(s)`);

    const cleared = await call('clear_index', { path: project });
    check('clear_index succeeds', /clear/i.test(cleared) && !/error/i.test(cleared), cleared);
    const after = await milvus.listCollections();
    check('clear_index drops the collection', !after.includes(collection), after.join(','));
} catch (error) {
    failures++;
    console.log(`  FAIL  unexpected error: ${error?.stack || error}`);
} finally {
    try { await client.close(); } catch { /* already closed */ }
    try {
        if (await milvus.hasCollection(collection)) await milvus.dropCollection(collection);
    } catch { /* best effort */ }
    stub.close();
    if (rmqCh) { try { await rmqCh.deleteQueue(rmqQueue); await rmqConn.close(); } catch { /* best effort */ } }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may still hold a handle */ }
    if (failures > 0) {
        console.log('\n--- server stderr (tail) ---\n' + serverLog.split('\n').slice(-40).join('\n'));
    }
    console.log(failures === 0 ? '\ne2e-live: PASS' : `\ne2e-live: FAIL (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
}
