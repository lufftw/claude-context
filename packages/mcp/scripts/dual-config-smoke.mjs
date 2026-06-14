// Gate for Task 0.2 — dual-embedding MCP config keys (secondary OFF by default).
//
// The mcp package has no jest harness; this runner exercises the REAL COMPILED
// artifact (`dist/config.js`) so we test exactly what ships. It asserts on the
// PARSED return value of createMcpConfig() (never substrings of log output).
//
// Run (from repo root, after `pnpm build:mcp`):
//   node packages/mcp/scripts/dual-config-smoke.mjs
// Exits 0 on success, non-zero on the first failed assertion.
//
// Isolation: createMcpConfig() reads env live via envManager (process.env is read
// fresh per get()), but to be defensive against any import-time caching we run
// EACH scenario in a CHILD process with a purpose-built env. The child prints the
// resolved config as JSON between plain-ASCII markers on stdout; the debug noise
// that createMcpConfig writes goes to stderr and is ignored.
//
// Coverage:
//   A. No secondary keys set → no secondary embedding configured and
//      searchEmbeddingModel defaults to 'qwen3-embedding-8b'. The resolved config
//      carries no defined secondary field (single-model path unchanged).
//   B. MILVUS_COLLECTION_PRIVATE_0P6B set (activation signal) + secondary
//      overrides → the secondary fields are populated from the env overrides, and
//      the registry SSOT for the 0.6B model agrees with those overrides (the
//      defaults the Phase 4 factory will fall back to).
//   B2. Activation signal alone (no overrides) → thin passthrough: only the
//      activation collection name is set; registry defaults are deferred to the
//      Phase 4 factory.

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distConfig = path.resolve(__dirname, '..', 'dist', 'config.js');
const coreDist = path.resolve(__dirname, '..', '..', 'core', 'dist', 'index.js');

if (!fs.existsSync(distConfig)) {
    console.error(`[dual-config-smoke] MISSING compiled artifact: ${distConfig}\n` +
        `Run 'pnpm build:mcp' first.`);
    process.exit(2);
}
if (!fs.existsSync(coreDist)) {
    console.error(`[dual-config-smoke] MISSING compiled core artifact: ${coreDist}\n` +
        `Run 'pnpm build:core' first.`);
    process.exit(2);
}

// ── tiny assert harness (same shape as snapshot-ledger.test.mjs) ─────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  PASS ${name}`);
    } else {
        failures++;
        console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Run createMcpConfig() in a child process with an explicit env, returning the
// parsed config object. We DELETE every key this gate cares about from the
// inherited env first, then layer the scenario's keys on top, so a stray value in
// the developer's shell cannot perturb the result.
const SCRUB_KEYS = [
    'EMBEDDING_PROVIDER', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSION',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'VOYAGEAI_API_KEY',
    'GEMINI_API_KEY', 'GEMINI_BASE_URL', 'OPENROUTER_API_KEY',
    'OLLAMA_MODEL', 'OLLAMA_HOST',
    'RABBITMQ_INFERENCE_URL', 'RABBITMQ_EMBEDDING_QUEUE', 'RABBITMQ_EMBEDDING_DIMENSION',
    'RABBITMQ_EMBEDDING_TIMEOUT_MS', 'RABBITMQ_EMBEDDING_MAX_RETRIES',
    'RABBITMQ_EMBEDDING_PRIORITY', 'RABBITMQ_EMBEDDING_CONCURRENCY', 'RABBITMQ_EMBEDDING_SOURCE',
    'RABBITMQ_SECONDARY_QUEUE', 'RABBITMQ_SECONDARY_DIMENSION', 'RABBITMQ_SECONDARY_MODEL',
    'MILVUS_COLLECTION_PRIVATE_0P6B', 'SEARCH_EMBEDDING_MODEL',
    'MILVUS_ADDRESS', 'MILVUS_TOKEN', 'MCP_SERVER_NAME', 'MCP_SERVER_VERSION',
];

const BEGIN = 'BEGIN_CFG_JSON';
const END = 'END_CFG_JSON';

function resolveConfig(scenarioEnv) {
    const env = { ...process.env };
    for (const k of SCRUB_KEYS) delete env[k];
    Object.assign(env, scenarioEnv);

    const childSrc =
        `import { createMcpConfig } from ${JSON.stringify(pathToFileURL(distConfig).href)};\n` +
        `const cfg = createMcpConfig();\n` +
        `process.stdout.write(${JSON.stringify(BEGIN)} + JSON.stringify(cfg) + ${JSON.stringify(END)});\n`;

    const res = spawnSync(process.execPath, ['--input-type=module', '-e', childSrc], {
        env,
        encoding: 'utf-8',
    });
    if (res.status !== 0) {
        throw new Error(`child exited ${res.status}\nstderr:\n${res.stderr}`);
    }
    // The config JSON is delimited by plain-ASCII markers so any stray stdout
    // noise is excluded (createMcpConfig's debug logging goes to stderr after the
    // Task 0.2 console.error fix, but the markers keep this robust regardless).
    const out = res.stdout;
    const a = out.indexOf(BEGIN);
    const b = out.lastIndexOf(END);
    if (a === -1 || b === -1 || b <= a) {
        throw new Error(`could not find config markers in child stdout:\n${out}`);
    }
    return JSON.parse(out.slice(a + BEGIN.length, b));
}

console.log('dual-config-smoke — compiled dist/config.js');

// ── A. No secondary keys → secondary OFF, search model defaults ──────────────
console.log('\nA. No secondary keys set → secondary OFF, single-model path unchanged');
const cfgOff = resolveConfig({}); // provider irrelevant to this assertion
check('milvusCollectionPrivate0p6b is undefined (activation signal absent)',
    cfgOff.milvusCollectionPrivate0p6b === undefined, `got ${cfgOff.milvusCollectionPrivate0p6b}`);
check('rabbitmqSecondaryQueue is undefined',
    cfgOff.rabbitmqSecondaryQueue === undefined, `got ${cfgOff.rabbitmqSecondaryQueue}`);
check('rabbitmqSecondaryDimension is undefined',
    cfgOff.rabbitmqSecondaryDimension === undefined, `got ${cfgOff.rabbitmqSecondaryDimension}`);
check('rabbitmqSecondaryModel is undefined',
    cfgOff.rabbitmqSecondaryModel === undefined, `got ${cfgOff.rabbitmqSecondaryModel}`);
eq('searchEmbeddingModel defaults to qwen3-embedding-8b',
    cfgOff.searchEmbeddingModel, 'qwen3-embedding-8b');

// No defined secondary field may leak into the OFF config (undefined → absent in
// JSON, so the pre-existing single-model surface is preserved).
const offDefined = Object.keys(cfgOff).filter(k => cfgOff[k] !== undefined);
check('no defined secondary field leaks into the OFF config',
    !offDefined.some(k => k === 'milvusCollectionPrivate0p6b'
        || k === 'rabbitmqSecondaryQueue'
        || k === 'rabbitmqSecondaryDimension'
        || k === 'rabbitmqSecondaryModel'),
    `defined keys: ${offDefined.join(', ')}`);

// ── B. Activation via MILVUS_COLLECTION_PRIVATE_0P6B + overrides ──────────────
console.log('\nB. MILVUS_COLLECTION_PRIVATE_0P6B set → secondary populated from env overrides');
const cfgOn = resolveConfig({
    EMBEDDING_PROVIDER: 'RabbitMQ',
    MILVUS_COLLECTION_PRIVATE_0P6B: 'myproj_code_chunks_0p6b',
    RABBITMQ_SECONDARY_QUEUE: 'embedding.qwen3-0.6b',
    RABBITMQ_SECONDARY_DIMENSION: '1024',
    RABBITMQ_SECONDARY_MODEL: 'qwen3-embedding-0.6b',
    SEARCH_EMBEDDING_MODEL: 'qwen3-embedding-0.6b',
});
eq('milvusCollectionPrivate0p6b is the activation collection name',
    cfgOn.milvusCollectionPrivate0p6b, 'myproj_code_chunks_0p6b');
eq('rabbitmqSecondaryQueue override flows through',
    cfgOn.rabbitmqSecondaryQueue, 'embedding.qwen3-0.6b');
eq('rabbitmqSecondaryDimension parsed to a number',
    cfgOn.rabbitmqSecondaryDimension, 1024);
check('rabbitmqSecondaryDimension is a number type (not string)',
    typeof cfgOn.rabbitmqSecondaryDimension === 'number', `typeof=${typeof cfgOn.rabbitmqSecondaryDimension}`);
eq('rabbitmqSecondaryModel override flows through',
    cfgOn.rabbitmqSecondaryModel, 'qwen3-embedding-0.6b');
eq('searchEmbeddingModel override flows through',
    cfgOn.searchEmbeddingModel, 'qwen3-embedding-0.6b');

// Registry cross-check: the values the Phase 4 factory will use as DEFAULTS when
// the override env vars are absent must match the registry SSOT for the 0.6B
// model. Guards that the config keys and the registry agree on the 0.6B identity.
const { getModelSpec, DEFAULT_PRIMARY_MODEL_ID } = await import(pathToFileURL(coreDist).href);
const spec06 = getModelSpec('qwen3-embedding-0.6b');
eq('registry 0.6B queue matches the override used above', spec06.queue, cfgOn.rabbitmqSecondaryQueue);
eq('registry 0.6B dimension matches the override used above', spec06.dimension, cfgOn.rabbitmqSecondaryDimension);
eq('registry 0.6B id matches the override used above', spec06.id, cfgOn.rabbitmqSecondaryModel);
eq('registry primary id is the search default', DEFAULT_PRIMARY_MODEL_ID, cfgOff.searchEmbeddingModel);

// ── B2. Activation signal alone — thin passthrough ───────────────────────────
console.log('\nB2. Activation signal alone (no secondary overrides) → thin passthrough');
const cfgOnBare = resolveConfig({
    EMBEDDING_PROVIDER: 'RabbitMQ',
    MILVUS_COLLECTION_PRIVATE_0P6B: 'myproj_code_chunks_0p6b',
});
eq('activation signal present', cfgOnBare.milvusCollectionPrivate0p6b, 'myproj_code_chunks_0p6b');
check('secondary queue stays undefined (registry default deferred to factory)',
    cfgOnBare.rabbitmqSecondaryQueue === undefined, `got ${cfgOnBare.rabbitmqSecondaryQueue}`);
check('secondary dimension stays undefined (registry default deferred to factory)',
    cfgOnBare.rabbitmqSecondaryDimension === undefined, `got ${cfgOnBare.rabbitmqSecondaryDimension}`);
check('secondary model stays undefined (registry default deferred to factory)',
    cfgOnBare.rabbitmqSecondaryModel === undefined, `got ${cfgOnBare.rabbitmqSecondaryModel}`);
eq('searchEmbeddingModel still defaults to primary when unset',
    cfgOnBare.searchEmbeddingModel, 'qwen3-embedding-8b');

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
