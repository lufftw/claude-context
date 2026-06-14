#!/usr/bin/env node
// ============================================================================
// Phase 5 — LIVE 0.6B backfill (source B: mirror-from-8B), dual-embedding MVP
// ----------------------------------------------------------------------------
// Reusable, IDEMPOTENT, RESUMABLE harness that mirrors the existing 8B
// `claude_context_own` collection into a NEW 1024-dim `claude_context_own_0p6b`
// collection by RE-EMBEDDING each distinct chunk's `content` through the 0.6B
// worker (queue=embedding.qwen3-0.6b) and native-upserting it under the SAME PK.
//
// capture == verify: every Milvus / RabbitMQ touch goes through the worktree's
// COMPILED dist (MilvusVectorDatabase, RabbitMQEmbedding, SnapshotManager) — the
// exact production code paths — so this harness's behaviour tracks production.
//
// ── SAFETY RAILS (hard) ─────────────────────────────────────────────────────
//   * Milvus: createCollection / upsert ONLY on `claude_context_own_0p6b`;
//     READ-ONLY (query/describe/stats) on `claude_context_own`. No other
//     collection is ever named. NEVER drop/delete/compact the 8B source.
//   * RabbitMQ: embeds at PRIORITY 1 (lowest — must not starve interactive
//     priority-10). The shared `embedding.qwen3-0.6b` queue is NEVER purged or
//     deleted. WAIT-class lag (timeout / no-consumer) is tolerated by the
//     provider's own retry-via-republish; we set a patient per-attempt timeout
//     and several retries so genuine lag is retried, not misclassified as a
//     hard failure. Concurrency is capped (<=4) to respect the shared worker.
//   * Small-subset validation FIRST (first ~10 distinct PKs): embed + upsert +
//     read-back round-trip, confirm dim===1024. Abort if it fails.
//
// ── RESUMABILITY ────────────────────────────────────────────────────────────
//   upsert is a native idempotent upsert keyed on PK, so re-running converges.
//   If the 0.6B worker dies mid-run we stop gracefully and report how many were
//   done; a later re-run upserts the same PKs again (no duplication).
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node packages/mcp/scripts/backfill-0p6b.mjs            # full run
//   node packages/mcp/scripts/backfill-0p6b.mjs --validate-only
//   node packages/mcp/scripts/backfill-0p6b.mjs --no-snapshot  # skip coverage persist
//   Env overrides: MILVUS_ADDRESS, MILVUS_TOKEN, RABBITMQ_INFERENCE_URL,
//     SOURCE_COLLECTION, TARGET_COLLECTION, EMBED_CONCURRENCY, CLAUDE_CONTEXT_HOME,
//     COVERAGE_CODEBASE_PATH
// ============================================================================

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // -> worktree root
const toFileUrl = (p) => (p.startsWith('file:') ? p : pathToFileURL(p).href);

// ── Configuration (overridable via env; defaults pinned for this box) ────────
const MILVUS_ADDRESS = process.env.MILVUS_ADDRESS || '127.0.0.1:19530';
const MILVUS_TOKEN   = process.env.MILVUS_TOKEN   || 'root:zzrNgGZ4xwLMHkQN368b';
const RABBITMQ_URL   = process.env.RABBITMQ_INFERENCE_URL
    || 'amqp://crawler:4MizIwuQ1wbSOL5vXh3WMBKU@127.0.0.1:5672/inference';

const SOURCE_COLLECTION = process.env.SOURCE_COLLECTION || 'claude_context_own';
const TARGET_COLLECTION = process.env.TARGET_COLLECTION || 'claude_context_own_0p6b';

const SECONDARY_QUEUE     = 'embedding.qwen3-0.6b';
const SECONDARY_MODEL     = process.env.RABBITMQ_SECONDARY_MODEL || 'qwen3-embedding-0.6b';
const SECONDARY_DIMENSION = 1024;
const BACKFILL_PRIORITY   = 1;          // LOWEST — never starve interactive priority-10
const EMBED_CONCURRENCY   = Math.min(Number(process.env.EMBED_CONCURRENCY || 4), 4); // respect shared worker
const PER_ATTEMPT_TIMEOUT_MS = 180_000; // patient: ride out WAIT-class lag
const MAX_RETRIES = 4;                   // 5 total attempts; 5*180s=900s << broker 2h consumer_timeout
const UPSERT_BATCH = 50;                 // Milvus upsert batch size

const VALIDATE_SUBSET = 10;              // first N distinct PKs for the small validation

// Coverage-snapshot target (the REAL shared snapshot home).
const SHARED_CONTEXT_HOME = process.env.CLAUDE_CONTEXT_HOME
    || 'E:\\Developer\\lufftw\\repo\\claude-control-center\\mcp\\61server\\share\\claude-context\\.context';
// The codebasePath KEY whose getCollectionName resolves to claude_context_own.
// MILVUS_COLLECTION_PRIVATE=claude_context_own makes getCollectionName return the
// collection verbatim regardless of path, so the snapshot KEY is purely a lookup
// key that must MATCH the existing shared-snapshot entry the deployed MCP reads.
const COVERAGE_CODEBASE_PATH = process.env.COVERAGE_CODEBASE_PATH
    || 'E:\\Developer\\lufftw\\repo\\claude-context';

const ARGS = new Set(process.argv.slice(2));
const VALIDATE_ONLY = ARGS.has('--validate-only');
const SKIP_SNAPSHOT = ARGS.has('--no-snapshot');

const SOURCE_FIELDS = ['id', 'content', 'relativePath', 'startLine', 'endLine', 'fileExtension', 'metadata'];

const log = (...a) => console.error('[backfill-0p6b]', ...a); // stderr — stdout reserved for final JSON

// ── Hard rail: refuse placeholder / noop creds ───────────────────────────────
if (RABBITMQ_URL.includes('noop') || RABBITMQ_URL.includes('127.0.0.1:1)')) {
    log('REFUSING noop/placeholder RabbitMQ URL'); process.exit(3);
}

// ── Load compiled production modules from dist ───────────────────────────────
const core = await import(toFileUrl(path.resolve(repoRoot, 'packages/core/dist/index.js')));
const { MilvusVectorDatabase, RabbitMQEmbedding } = core;
if (typeof MilvusVectorDatabase !== 'function' || typeof RabbitMQEmbedding !== 'function') {
    log('core dist did not export MilvusVectorDatabase / RabbitMQEmbedding'); process.exit(4);
}
const snapMod = await import(toFileUrl(path.resolve(repoRoot, 'packages/mcp/dist/snapshot.js')));
const { SnapshotManager } = snapMod;

// Raw SDK only for describeCollection / getCollectionStatistics verification
// (read-only inspection that MilvusVectorDatabase does not surface directly).
const { createRequire } = await import('node:module');
const requireFromCore = createRequire(path.resolve(repoRoot, 'packages/core/dist/index.js'));
const { MilvusClient } = requireFromCore('@zilliz/milvus2-sdk-node');

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseMetadata(raw) {
    // Source stores metadata as a JSON STRING. upsert() re-stringifies an object,
    // so we parse back to an object to avoid double-encoding. Tolerate non-JSON.
    if (raw == null) return {};
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

function toInt(v) {
    // Int64 may arrive as string or number depending on SDK path.
    const n = typeof v === 'string' ? parseInt(v, 10) : Number(v);
    return Number.isFinite(n) ? n : 0;
}

async function getRowCount(client, collection) {
    const stats = await client.getCollectionStatistics({ collection_name: collection });
    const rc = stats?.data?.row_count
        ?? stats?.stats?.find?.((s) => s.key === 'row_count')?.value;
    return rc != null ? Number(rc) : null;
}

async function describeVector(client, collection) {
    const d = await client.describeCollection({ collection_name: collection });
    const vec = d.schema.fields.find((f) => f.name === 'vector');
    const dim = (vec?.type_params || []).find((p) => p.key === 'dim')?.value;
    let metric = null;
    try {
        const idx = await client.describeIndex({ collection_name: collection });
        const di = idx.index_descriptions?.find((i) => i.field_name === 'vector');
        metric = (di?.params || []).find((p) => p.key === 'metric_type')?.value ?? null;
    } catch { /* index may be building */ }
    return {
        fields: d.schema.fields.map((f) => f.name),
        vectorDim: dim != null ? Number(dim) : null,
        metric,
    };
}

// Read ALL distinct source rows, deduped client-side by PK (keep first seen).
async function readDistinctSourceRows(milvus) {
    log(`reading source '${SOURCE_COLLECTION}' (output_fields=${SOURCE_FIELDS.join(',')})…`);
    const rows = await milvus.queryAll(SOURCE_COLLECTION, SOURCE_FIELDS);
    const byId = new Map();
    for (const r of rows) {
        if (!byId.has(r.id)) byId.set(r.id, r);
    }
    log(`source physical rows iterated=${rows.length}, distinct PKs=${byId.size}, dupes dropped=${rows.length - byId.size}`);
    return Array.from(byId.values());
}

// Embed + upsert a list of distinct source rows. Returns { embedded, upserted, waitLag, failures }.
async function embedAndUpsert(milvus, embedder, rows, label) {
    let embedded = 0, upserted = 0, waitLag = 0;
    const failures = [];

    // Embed with bounded concurrency via the provider's partial-tolerant batch.
    // embedBatchPartial returns index-aligned results; a failed slot carries a
    // tagged reason and NEVER a zero/empty vector (provider Layer-0 guard).
    const texts = rows.map((r) => String(r.content ?? ''));
    log(`${label}: embedding ${texts.length} chunks (queue=${SECONDARY_QUEUE}, priority=${BACKFILL_PRIORITY}, dim=${SECONDARY_DIMENSION}, concurrency=${EMBED_CONCURRENCY})…`);
    const results = await embedder.embedBatchPartial(texts);

    const docs = [];
    for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const r = rows[i];
        if (!res || res.ok !== true) {
            const reason = res?.reason || 'unknown';
            // timeout / no-consumer / connection-lost are WAIT-class lag, not hard failures.
            if (reason === 'timeout' || reason === 'no-consumer' || reason === 'connection-lost') {
                waitLag++;
            }
            failures.push({ id: r.id, reason, detail: res?.detail });
            continue;
        }
        if (!Array.isArray(res.vector) || res.vector.length !== SECONDARY_DIMENSION) {
            failures.push({ id: r.id, reason: 'bad-dimension', detail: `len=${res.vector?.length}` });
            continue;
        }
        embedded++;
        docs.push({
            id: r.id,
            vector: res.vector,
            content: String(r.content ?? ''),
            relativePath: String(r.relativePath ?? ''),
            startLine: toInt(r.startLine),
            endLine: toInt(r.endLine),
            fileExtension: String(r.fileExtension ?? ''),
            metadata: parseMetadata(r.metadata),
        });
    }

    // Native idempotent upsert in batches.
    for (let i = 0; i < docs.length; i += UPSERT_BATCH) {
        const batch = docs.slice(i, i + UPSERT_BATCH);
        await milvus.upsert(TARGET_COLLECTION, batch);
        upserted += batch.length;
        log(`${label}: upserted ${upserted}/${docs.length}`);
    }

    return { embedded, upserted, waitLag, failures };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const report = {
        phase: 'P5-source-B-0.6b-backfill',
        source: SOURCE_COLLECTION,
        target: TARGET_COLLECTION,
        queue: SECONDARY_QUEUE,
        priority: BACKFILL_PRIORITY,
        concurrency: EMBED_CONCURRENCY,
    };

    const milvus = new MilvusVectorDatabase({ address: MILVUS_ADDRESS, token: MILVUS_TOKEN, ssl: false });
    const rawClient = new MilvusClient({ address: MILVUS_ADDRESS, token: MILVUS_TOKEN, ssl: false });
    const embedder = new RabbitMQEmbedding({
        url: RABBITMQ_URL,
        queue: SECONDARY_QUEUE,
        modelName: SECONDARY_MODEL,
        dimension: SECONDARY_DIMENSION,
        priority: BACKFILL_PRIORITY,
        concurrency: EMBED_CONCURRENCY,
        timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
        source: 'claude-context-backfill-0p6b',
    });

    try {
        // ── Step 1: ensure target collection exists at 1024-dim standard schema ─
        const exists = await milvus.hasCollection(TARGET_COLLECTION);
        if (!exists) {
            log(`creating '${TARGET_COLLECTION}' at dim=${SECONDARY_DIMENSION} (standard schema, COSINE, AUTOINDEX)…`);
            await milvus.createCollection(
                TARGET_COLLECTION,
                SECONDARY_DIMENSION,
                `source-B 0.6B mirror of ${SOURCE_COLLECTION}`
            );
            report.collectionCreated = true;
        } else {
            log(`'${TARGET_COLLECTION}' already exists — reusing (idempotent backfill)`);
            report.collectionCreated = false;
        }

        // Verify the target schema/dim/metric.
        const targetDesc = await describeVector(rawClient, TARGET_COLLECTION);
        report.targetDescribe = targetDesc;
        if (targetDesc.vectorDim !== SECONDARY_DIMENSION) {
            throw new Error(`target vector dim ${targetDesc.vectorDim} !== expected ${SECONDARY_DIMENSION}`);
        }
        log(`target verified: dim=${targetDesc.vectorDim}, metric=${targetDesc.metric}, fields=[${targetDesc.fields.join(', ')}]`);

        // ── Step 2: read + dedupe source ───────────────────────────────────────
        const distinctRows = await readDistinctSourceRows(milvus);
        report.eightB_distinct = distinctRows.length;

        // ── Step 3: SMALL-SUBSET VALIDATION (first N) ──────────────────────────
        const subset = distinctRows.slice(0, Math.min(VALIDATE_SUBSET, distinctRows.length));
        log(`── small-subset validation: ${subset.length} distinct PKs ──`);
        const v = await embedAndUpsert(milvus, embedder, subset, 'validate');
        report.validation = {
            attempted: subset.length,
            embedded: v.embedded,
            upserted: v.upserted,
            waitLag: v.waitLag,
            failures: v.failures.length,
            failureSample: v.failures.slice(0, 3),
        };
        if (v.embedded === 0 || v.upserted === 0) {
            report.validationResult = 'FAIL';
            report.abort = 'small-subset validation produced 0 embedded/upserted rows';
            console.log(JSON.stringify(report, null, 2));
            log('ABORT — small validation failed'); process.exit(1);
        }
        // Read-back round-trip: query the subset PKs from the TARGET and confirm presence + dim.
        const subsetIds = subset.map((r) => r.id);
        const idFilter = `id in [${subsetIds.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(', ')}]`;
        const readBack = await milvus.query(TARGET_COLLECTION, idFilter, ['id', 'vector'], subsetIds.length);
        const readBackDims = readBack.map((r) => (Array.isArray(r.vector) ? r.vector.length : null));
        const allDim1024 = readBack.length > 0 && readBackDims.every((d) => d === SECONDARY_DIMENSION);
        report.validation.readBackCount = readBack.length;
        report.validation.readBackDimOk = allDim1024;
        report.validation.readBackDimSample = readBackDims.slice(0, 5);
        if (!allDim1024) {
            report.validationResult = 'FAIL';
            report.abort = `read-back dim check failed (dims=${JSON.stringify(readBackDims.slice(0, 5))})`;
            console.log(JSON.stringify(report, null, 2));
            log('ABORT — read-back dim != 1024'); process.exit(1);
        }
        report.validationResult = 'PASS';
        log(`small validation PASS: embedded=${v.embedded}, upserted=${v.upserted}, read-back=${readBack.length} all dim=1024`);

        if (VALIDATE_ONLY) {
            log('--validate-only set; stopping after validation.');
            console.log(JSON.stringify(report, null, 2));
            process.exit(0);
        }

        // ── Step 4: FULL RUN (remaining rows) ──────────────────────────────────
        const remaining = distinctRows.slice(subset.length);
        log(`── full run: ${remaining.length} remaining distinct PKs ──`);
        let totalEmbedded = v.embedded, totalUpserted = v.upserted, totalWaitLag = v.waitLag;
        const allFailures = [...v.failures];
        // Chunk the remaining set so progress + WAIT lag are visible and the run is
        // resumable at coarse granularity if the worker dies mid-way.
        const RUN_CHUNK = 100;
        for (let i = 0; i < remaining.length; i += RUN_CHUNK) {
            const chunk = remaining.slice(i, i + RUN_CHUNK);
            const c = await embedAndUpsert(milvus, embedder, chunk, `run[${i}-${i + chunk.length}]`);
            totalEmbedded += c.embedded; totalUpserted += c.upserted; totalWaitLag += c.waitLag;
            allFailures.push(...c.failures);
            log(`progress: embedded=${totalEmbedded}/${distinctRows.length}, upserted=${totalUpserted}, waitLag=${totalWaitLag}, failures=${allFailures.length}`);
        }
        report.fullRun = {
            totalDistinct: distinctRows.length,
            embedded: totalEmbedded,
            upserted: totalUpserted,
            waitLag: totalWaitLag,
            failures: allFailures.length,
            failureSample: allFailures.slice(0, 5),
        };

        // ── Step 5: coverage measurement (G3) ──────────────────────────────────
        // Distinct PKs actually present in target vs distinct PKs in source.
        const targetRows = await milvus.queryAll(TARGET_COLLECTION, ['id']);
        const targetIds = new Set(targetRows.map((r) => r.id));
        const sourceIds = new Set(distinctRows.map((r) => r.id));
        let overlap = 0;
        for (const id of targetIds) if (sourceIds.has(id)) overlap++;
        const ratio = sourceIds.size > 0 ? overlap / sourceIds.size : 0;
        const coverage = {
            eightB_distinct: sourceIds.size,
            sixB_distinct: targetIds.size,
            overlap,
            ratio: Number(ratio.toFixed(6)),
        };
        report.coverage = coverage;
        log(`coverage: ${JSON.stringify(coverage)}`);

        // ── Step 6: persist coverage ratio (additive; old dist ignores it) ─────
        if (!SKIP_SNAPSHOT) {
            // Set CLAUDE_CONTEXT_HOME before constructing SnapshotManager — its
            // constructor reads the env to choose the snapshot file path.
            process.env.CLAUDE_CONTEXT_HOME = SHARED_CONTEXT_HOME;
            const sm = new SnapshotManager();
            // Do NOT call loadCodebaseSnapshot() — that validates/prunes paths that
            // may belong to other users on a different box. We only seed our single
            // (codebasePath × model) entry; saveCodebaseSnapshot() does a locked
            // read-merge-write that preserves every existing on-disk entry and
            // shallow-merges coverageByModel.
            sm.setCoverageRatioForModel(COVERAGE_CODEBASE_PATH, SECONDARY_MODEL, coverage.ratio);
            sm.saveCodebaseSnapshot();
            report.snapshot = {
                persisted: true,
                contextHome: SHARED_CONTEXT_HOME,
                codebasePath: COVERAGE_CODEBASE_PATH,
                modelId: SECONDARY_MODEL,
                ratio: coverage.ratio,
            };
            log(`coverage ratio persisted to shared snapshot under key '${COVERAGE_CODEBASE_PATH}' [${SECONDARY_MODEL}=${coverage.ratio}]`);
        } else {
            report.snapshot = { persisted: false, reason: '--no-snapshot' };
            log('snapshot persistence SKIPPED (--no-snapshot)');
        }

        // ── Step 7: final verification (stats + describe) ──────────────────────
        report.targetRowCount = await getRowCount(rawClient, TARGET_COLLECTION);
        log(`final getCollectionStatistics(${TARGET_COLLECTION}) row_count=${report.targetRowCount}`);

        report.result = 'PASS';
        console.log(JSON.stringify(report, null, 2));
        process.exit(0);
    } catch (err) {
        report.result = 'ERROR';
        report.error = err?.message || String(err);
        report.errorReason = err?.embedReason || null;
        // Worker death mid-run is graceful: upsert is idempotent/resumable.
        console.log(JSON.stringify(report, null, 2));
        log(`ERROR: ${report.error}`);
        process.exit(2);
    } finally {
        try { await embedder.close(); } catch { /* ignore */ }
    }
}

main().catch((e) => { log('fatal', e); process.exit(2); });
