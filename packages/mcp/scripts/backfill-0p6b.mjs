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
// queryAll default batchSize=10000 fetches 10k rows/gRPC page; on large collections
// with big `content` that exceeds the 15s gRPC deadline (DEADLINE_EXCEEDED). Read source
// in smaller pages so each page returns well under the deadline. (Follow-up: lower the
// queryAll default in milvus-vectordb.ts — same hazard hits production loadExistingFileHashes.)
const SOURCE_READ_BATCH = Math.min(Number(process.env.SOURCE_READ_BATCH || 500), 2000);
// Two-phase read: a cheap id-ONLY queryAll (light payload survives deep-offset pages)
// computes the pending set, then full SOURCE_FIELDS rows are fetched ONLY for pending PKs
// via id-in lookups (no offset cost: ~245ms / 200 rows). This avoids re-scanning the
// entire source (event_shared = 579k physical rows) with the heavy content payload, which
// blows the 15s gRPC deadline on deep-offset pages. ID_READ_BATCH pages the id scan;
// FETCH_BATCH sizes each id-in lookup (kept small so one lookup stays well under 15s).
const ID_READ_BATCH = Math.min(Number(process.env.ID_READ_BATCH || 2000), 5000);
const FETCH_BATCH   = Math.min(Number(process.env.FETCH_BATCH || 200), 500);
const QUERY_LIMIT_MAX = 16384;          // Milvus hard max for a single query() limit

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

// Phase 1 of the source read: distinct PK ids ONLY (1 light field). queryAll pages by
// offset; the small id payload keeps each page well under the 15s gRPC deadline even on
// a 579k-row collection. Returns distinct ids in first-seen order.
async function readDistinctSourceIds(milvus) {
    log(`reading source IDs '${SOURCE_COLLECTION}' (id only, batch=${ID_READ_BATCH})…`);
    const rows = await milvus.queryAll(SOURCE_COLLECTION, ['id'], undefined, ID_READ_BATCH);
    const seen = new Set();
    const ids = [];
    for (const r of rows) { if (!seen.has(r.id)) { seen.add(r.id); ids.push(r.id); } }
    log(`source physical rows iterated=${rows.length}, distinct PKs=${ids.length}, dupes dropped=${rows.length - ids.length}`);
    return ids;
}

// Phase 2 of the source read: fetch full SOURCE_FIELDS rows for an explicit id list via
// batched `id in [...]` lookups. No offset cost — only the requested rows are materialized,
// so even with the heavy content payload each batch stays far under the deadline. Returns a
// Map(id -> row), deduped (keep first per PK).
//
// The source carries MANY duplicate physical rows per PK (insert-not-upsert: 579k physical
// for 164k distinct in event_shared). So `id in [N ids]` can match far more than N physical
// rows; we cap each query at Milvus' max (16384). If a batch's physical rows still hit the
// cap before covering all its distinct ids, those ids are silently missing — so we recompute
// the missing set and retry at a progressively SMALLER batch size until every id is covered
// (batch 10 tolerates >1600x dup). Without this, the full run leaves a slice of PKs pending.
async function fetchRowsByIds(milvus, ids) {
    const byId = new Map();
    let toFetch = ids;
    let batchSize = FETCH_BATCH;
    for (let round = 1; toFetch.length > 0 && round <= 4; round++) {
        for (let i = 0; i < toFetch.length; i += batchSize) {
            const batch = toFetch.slice(i, i + batchSize);
            const filt = `id in [${batch.map((x) => `"${String(x).replace(/"/g, '\\"')}"`).join(', ')}]`;
            const rows = await milvus.query(SOURCE_COLLECTION, filt, SOURCE_FIELDS, QUERY_LIMIT_MAX);
            for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
            if (round === 1 && (i % (batchSize * 20) === 0 || i + batchSize >= toFetch.length)) {
                log(`fetch pending rows: ${byId.size}/${ids.length}`);
            }
        }
        toFetch = ids.filter((id) => !byId.has(id));
        if (toFetch.length > 0) {
            batchSize = Math.max(10, Math.floor(batchSize / 4));
            log(`fetch retry round ${round}: ${toFetch.length} ids still missing (dup-truncation); retrying at batch=${batchSize}`);
        }
    }
    return byId;
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

        // ── Step 2: read distinct source PK ids (cheap, id-only) ───────────────
        const sourceIds = await readDistinctSourceIds(milvus);
        const sourceIdSet = new Set(sourceIds);
        report.eightB_distinct = sourceIds.length;

        // ── Step 2b: RESUME-SKIP — only embed PKs not already in target ─────────
        // upsert is idempotent by PK, so PKs already present in the target are done.
        // Skipping them (a) avoids re-loading the SHARED 0.6B worker with completed
        // work, and (b) makes a long run (e.g. event_shared ~580k) resilient across
        // interruptions/reboots: the next run embeds only what is still missing
        // instead of restarting from zero. Disable with FORCE_FULL=1 / --force-full
        // (e.g. to re-embed everything after a model change). A prior run that
        // tolerated transient WAIT failures left a gap; this run fills exactly it.
        const FORCE_FULL = ARGS.has('--force-full') || process.env.FORCE_FULL === '1';
        let pendingIds = sourceIds;
        if (FORCE_FULL) {
            log(`FORCE_FULL — embedding all ${sourceIds.length} distinct PKs (resume-skip disabled)`);
        } else {
            let targetIds = new Set();
            try {
                const existing = await milvus.queryAll(TARGET_COLLECTION, ['id'], undefined, ID_READ_BATCH);
                targetIds = new Set(existing.map((r) => r.id));
            } catch (e) {
                log(`resume-skip: could not read target PKs (${e?.message || e}); falling back to FULL set`);
            }
            pendingIds = sourceIds.filter((id) => !targetIds.has(id));
            report.resumeSkip = { targetExisting: targetIds.size, alreadyDone: sourceIds.length - pendingIds.length, pending: pendingIds.length };
            log(`resume-skip: source distinct=${sourceIds.length}, target has=${targetIds.size}, pending=${pendingIds.length} (skipped ${sourceIds.length - pendingIds.length})`);
        }

        // ── Step 2c: fetch full SOURCE_FIELDS rows for the pending PKs only ─────
        // (targeted id-in lookups; avoids re-scanning the whole heavy source).
        let pending = [];
        if (pendingIds.length > 0) {
            log(`fetching ${pendingIds.length} pending source rows by id (batch=${FETCH_BATCH})…`);
            const byId = await fetchRowsByIds(milvus, pendingIds);
            pending = pendingIds.map((id) => byId.get(id)).filter(Boolean);
            const dropped = pendingIds.length - pending.length;
            if (dropped > 0) log(`warning: ${dropped} pending PK(s) not returned by id-in fetch (source race?); proceeding with ${pending.length}`);
        }

        // Totals accumulate across validation + full run (and stay 0 if nothing pending).
        let v = { embedded: 0, upserted: 0, waitLag: 0, failures: [] };
        let totalEmbedded = 0, totalUpserted = 0, totalWaitLag = 0;
        let degraded = false; // set when every pending chunk is a permanent per-chunk rejection
        const allFailures = [];

        if (pending.length === 0) {
            // Target already covers every source PK — skip embedding, report coverage only.
            report.validationResult = 'SKIP (already complete)';
            log('resume-skip: nothing pending — target already covers all source PKs; measuring coverage only');
        } else {
            // ── Step 3: SMALL-SUBSET VALIDATION (smallest-content pending PKs) ──
            // Sample by ASCENDING content length, not iteration order: the smallest
            // chunks are the ones most likely to fit the 0.6B 2048-token context, so a
            // success proves (a) the broker/worker pipeline is alive and (b) the target
            // accepts dim=1024. Iteration-order sampling false-negatives on a residue-
            // heavy pending set (earlier passes already filled the small chunks, leaving
            // the head full of permanently over-context rows) — exactly event_shared.
            const bySize = [...pending].sort(
                (a, b) => String(a.content ?? '').length - String(b.content ?? '').length
            );
            const subset = bySize.slice(0, Math.min(VALIDATE_SUBSET, bySize.length));
            log(`── small-subset validation: ${subset.length} smallest-content pending PKs ──`);
            v = await embedAndUpsert(milvus, embedder, subset, 'validate');
            report.validation = {
                attempted: subset.length,
                embedded: v.embedded,
                upserted: v.upserted,
                waitLag: v.waitLag,
                failures: v.failures.length,
                failureSample: v.failures.slice(0, 3),
            };

            // Classify failures: a transport/WAIT failure (timeout, no-consumer, socket/
            // channel closed) means the pipeline is unhealthy → ABORT so a later run
            // resumes via resume-skip. A permanent per-chunk rejection (content exceeds
            // the 0.6B 2048-token context) is NOT a pipeline fault and is never fillable.
            const isTransportFail = (f) => {
                if (f.reason === 'timeout' || f.reason === 'no-consumer' || f.reason === 'connection-lost') return true;
                return /socket|connection|channel.*clos|econnrefused|handshake|timed? ?out/i.test(String(f.detail || ''));
            };
            const isOverContextFail = (f) => /exceed_context_size|exceeds the available context/i.test(String(f.detail || ''));

            if (v.embedded === 0 || v.upserted === 0) {
                const transportFails = v.failures.filter(isTransportFail);
                const overContextFails = v.failures.filter(isOverContextFail);
                if (transportFails.length > 0) {
                    report.validationResult = 'FAIL';
                    report.abort = `validation embedded 0 with ${transportFails.length} transport/WAIT failure(s) — pipeline unhealthy`;
                    report.validation.failureSample = v.failures.slice(0, 3);
                    console.log(JSON.stringify(report, null, 2));
                    log('ABORT — small validation failed (transport/WAIT)'); process.exit(1);
                }
                // Even the SMALLEST pending chunks are permanently rejected (over-context):
                // there is no fillable work left and the pipeline is healthy. Mark DEGRADED,
                // record the residue, and fall through to coverage reporting (no abort).
                degraded = true;
                report.validationResult = 'DEGRADED';
                report.validationDegraded = `smallest ${subset.length} pending all permanently rejected (${overContextFails.length} over-context); no fillable pending work`;
                report.fullRunSkipped = 'all pending are permanent per-chunk rejections (over-context residue)';
                allFailures.push(...v.failures);
                log(`DEGRADED — smallest ${subset.length} pending all permanently rejected (${overContextFails.length} over-context). No fillable work; reporting coverage only.`);
            } else {
                // Read-back round-trip: query the subset PKs from the TARGET and confirm dim.
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
            }

            if (VALIDATE_ONLY) {
                log('--validate-only set; stopping after validation.');
                console.log(JSON.stringify(report, null, 2));
                process.exit(0);
            }

            if (!degraded) {
                // ── Step 4: FULL RUN (remaining pending rows) ──────────────────
                // remaining = pending minus the validated subset, BY ID (subset is the
                // smallest-by-size set, not a prefix, so slice() would be wrong).
                const subsetIdSet = new Set(subset.map((r) => r.id));
                const remaining = pending.filter((r) => !subsetIdSet.has(r.id));
                log(`── full run: ${remaining.length} remaining pending PKs ──`);
                totalEmbedded = v.embedded; totalUpserted = v.upserted; totalWaitLag = v.waitLag;
                allFailures.push(...v.failures);
                // Chunk the remaining set so progress + WAIT lag are visible and the run is
                // resumable at coarse granularity if the worker dies mid-way.
                const RUN_CHUNK = 100;
                for (let i = 0; i < remaining.length; i += RUN_CHUNK) {
                    const chunk = remaining.slice(i, i + RUN_CHUNK);
                    const c = await embedAndUpsert(milvus, embedder, chunk, `run[${i}-${i + chunk.length}]`);
                    totalEmbedded += c.embedded; totalUpserted += c.upserted; totalWaitLag += c.waitLag;
                    allFailures.push(...c.failures);
                    log(`progress: embedded=${totalEmbedded}/${pending.length} pending (source ${sourceIds.length}), upserted=${totalUpserted}, waitLag=${totalWaitLag}, failures=${allFailures.length}`);
                }
            }
        }
        report.fullRun = {
            totalDistinct: sourceIds.length,
            pending: pending.length,
            embedded: totalEmbedded,
            upserted: totalUpserted,
            waitLag: totalWaitLag,
            failures: allFailures.length,
            failureSample: allFailures.slice(0, 5),
        };

        // ── Step 5: coverage measurement (G3) ──────────────────────────────────
        // Distinct PKs actually present in target vs distinct PKs in source.
        const targetRows = await milvus.queryAll(TARGET_COLLECTION, ['id'], undefined, ID_READ_BATCH);
        const targetIds = new Set(targetRows.map((r) => r.id));
        let overlap = 0;
        for (const id of targetIds) if (sourceIdSet.has(id)) overlap++;
        const ratio = sourceIdSet.size > 0 ? overlap / sourceIdSet.size : 0;
        const coverage = {
            eightB_distinct: sourceIdSet.size,
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
