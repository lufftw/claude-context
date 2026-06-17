// Gate: list-based secondary (0.6B) activation that does NOT grow one env var per model.
//
// Design (decision B): SECONDARY_EMBEDDING_MODELS lists the CANONICAL model ids to
// activate. The collection name auto-derives from the registry suffix
// (getCollectionNameForModel), so MILVUS_COLLECTION_PRIVATE_0P6B is now a pure NAME
// OVERRIDE — but it STILL activates the secondary on its own for backward compatibility.
// Adding a future model = add its id to the ONE list var, never a new per-model var.
//
// Runs against the REAL COMPILED artifacts (dist/config.js, dist/embedding.js) — exactly
// what ships. Config parsing is checked via a child process with a scrubbed env (same
// pattern as dual-config-smoke.mjs); activation is checked in-process by calling the
// factory with constructed config OBJECTS (it reads only from config, never env).
//
// Run (from repo root, after `pnpm build:mcp`):
//   node packages/mcp/scripts/secondary-activation.test.mjs
// Exits 0 on success, non-zero on the first failed assertion.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distConfig = path.resolve(__dirname, '..', 'dist', 'config.js');
const distEmbedding = path.resolve(__dirname, '..', 'dist', 'embedding.js');

for (const [label, p] of [['config', distConfig], ['embedding', distEmbedding]]) {
    if (!fs.existsSync(p)) {
        console.error(`[secondary-activation] MISSING compiled ${label} artifact: ${p}\nRun 'pnpm build:mcp' first.`);
        process.exit(2);
    }
}

// ── tiny assert harness (same shape as dual-config-smoke.mjs) ────────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  PASS ${name}`);
    else { failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── config parsing in a scrubbed child env ───────────────────────────────────
const SCRUB_KEYS = [
    'EMBEDDING_PROVIDER', 'RABBITMQ_INFERENCE_URL', 'RABBITMQ_SECONDARY_QUEUE',
    'RABBITMQ_SECONDARY_DIMENSION', 'RABBITMQ_SECONDARY_MODEL',
    'MILVUS_COLLECTION_PRIVATE_0P6B', 'SECONDARY_EMBEDDING_MODELS', 'SEARCH_EMBEDDING_MODEL',
    'MILVUS_ADDRESS', 'MILVUS_TOKEN',
];
const BEGIN = 'BEGIN_CFG_JSON', END = 'END_CFG_JSON';
function resolveConfig(scenarioEnv) {
    const env = { ...process.env };
    for (const k of SCRUB_KEYS) delete env[k];
    Object.assign(env, scenarioEnv);
    const childSrc =
        `import { createMcpConfig } from ${JSON.stringify(pathToFileURL(distConfig).href)};\n` +
        `process.stdout.write(${JSON.stringify(BEGIN)} + JSON.stringify(createMcpConfig()) + ${JSON.stringify(END)});\n`;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], { env, encoding: 'utf-8' });
    if (res.status !== 0) throw new Error(`child exited ${res.status}\nstderr:\n${res.stderr}`);
    const a = res.stdout.indexOf(BEGIN), b = res.stdout.lastIndexOf(END);
    if (a === -1 || b === -1 || b <= a) throw new Error(`no config markers in child stdout:\n${res.stdout}`);
    return JSON.parse(res.stdout.slice(a + BEGIN.length, b));
}

console.log('secondary-activation — compiled dist/config.js + dist/embedding.js');

// ── A. SECONDARY_EMBEDDING_MODELS parses into a string[] config field ─────────
console.log('\nA. SECONDARY_EMBEDDING_MODELS → secondaryEmbeddingModels: string[]');
const cfgList = resolveConfig({ SECONDARY_EMBEDDING_MODELS: 'qwen3-embedding-0.6b' });
eq('single id parses to a one-element array', cfgList.secondaryEmbeddingModels, ['qwen3-embedding-0.6b']);
const cfgList2 = resolveConfig({ SECONDARY_EMBEDDING_MODELS: 'qwen3-embedding-0.6b, qwen3-embedding-0.6b' });
check('comma-separated parses to >=1 trimmed ids',
    Array.isArray(cfgList2.secondaryEmbeddingModels) && cfgList2.secondaryEmbeddingModels[0] === 'qwen3-embedding-0.6b',
    `got ${JSON.stringify(cfgList2.secondaryEmbeddingModels)}`);
const cfgNoList = resolveConfig({});
check('absent var → secondaryEmbeddingModels undefined (single-model surface unchanged)',
    cfgNoList.secondaryEmbeddingModels === undefined, `got ${JSON.stringify(cfgNoList.secondaryEmbeddingModels)}`);

// ── B. activation via the list, WITHOUT MILVUS_COLLECTION_PRIVATE_0P6B ────────
console.log('\nB. createSecondaryEmbeddingInstance activation');
const { createSecondaryEmbeddingInstance } = await import(pathToFileURL(distEmbedding).href);
const baseCfg = {
    embeddingProvider: 'RabbitMQ',
    rabbitmqUrl: 'amqp://guest:guest@127.0.0.1:5672/test', // valid form; constructor is lazy (no connect)
};

const instList = createSecondaryEmbeddingInstance({ ...baseCfg, secondaryEmbeddingModels: ['qwen3-embedding-0.6b'] });
check('list activates secondary WITHOUT MILVUS_COLLECTION_PRIVATE_0P6B', instList != null,
    `got ${instList}`);

const off = createSecondaryEmbeddingInstance({ ...baseCfg });
check('OFF when neither list nor legacy name var is set', off == null, `got ${off}`);

const offEmpty = createSecondaryEmbeddingInstance({ ...baseCfg, secondaryEmbeddingModels: [] });
check('empty list does NOT activate', offEmpty == null, `got ${offEmpty}`);

const offOther = createSecondaryEmbeddingInstance({ ...baseCfg, secondaryEmbeddingModels: ['qwen3-embedding-8b'] });
check('listing only the primary does NOT activate a secondary', offOther == null, `got ${offOther}`);

// ── C. legacy MILVUS_COLLECTION_PRIVATE_0P6B still activates (backward compat) ─
console.log('\nC. legacy name var still activates (backward compatibility)');
const legacy = createSecondaryEmbeddingInstance({ ...baseCfg, milvusCollectionPrivate0p6b: 'myproj_own_0p6b' });
check('legacy MILVUS_COLLECTION_PRIVATE_0P6B activates on its own', legacy != null, `got ${legacy}`);

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
