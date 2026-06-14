#!/usr/bin/env node
// ============================================================================
// Gate E3 — LIVE distinct-PK assessment of `claude_context_own` (Phase 6)
// ----------------------------------------------------------------------------
// DIAGNOSTIC ONLY. READ-ONLY against Milvus. This script:
//   - connects @zilliz/milvus2-sdk-node to 127.0.0.1:19530
//   - reads getCollectionStatistics -> row_count           (totalRows)
//   - scrolls ALL `id` (VarChar PK) values via queryIterator (paginated)
//   - computes distinctPKs = new Set(ids).size
//   - prints { collection, totalRows, distinctPKs, duplicateRows, ratio }
//
// Milvus 2.5.x has no COUNT(DISTINCT), so we enumerate PKs and dedup in-process.
//
// SAFETY (hard): the ONLY SDK calls used are describeCollection, getLoadState,
// getCollectionStatistics, query (via queryIterator). There is NO
// createCollection / dropCollection / compact / delete / insert / upsert /
// loadCollection. queryIterator requires the collection to be loaded; if it is
// NOT loaded we DO NOT load it (load mutates server memory state) — we report
// the load state and exit cleanly so the operator can decide.
// ============================================================================

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..'); // -> worktree root
const toFileUrl = (p) => (p.startsWith('file:') ? p : pathToFileURL(p).href);

// --- Credentials (this Windows box) -----------------------------------------
const ADDRESS = process.env.MILVUS_ADDRESS || '127.0.0.1:19530';
const TOKEN = process.env.MILVUS_TOKEN || 'root:zzrNgGZ4xwLMHkQN368b';
const COLLECTION = process.env.E3_COLLECTION || 'claude_context_own';
const PK_FIELD = process.env.E3_PK_FIELD || 'id';
const BATCH_SIZE = 16_384; // iterator page size

// --- Import the SDK from the worktree core node_modules ----------------------
const sdkEntry = path.resolve(
  repoRoot,
  'packages/core/node_modules/@zilliz/milvus2-sdk-node/dist/milvus/index.js'
);
const sdk = await import(toFileUrl(sdkEntry));
const MilvusClient = sdk.MilvusClient ?? sdk.default?.MilvusClient;
if (!MilvusClient) {
  console.error('[E3] MilvusClient not exported from', sdkEntry);
  process.exit(4);
}

function statVal(stats, key) {
  if (!Array.isArray(stats)) return undefined;
  const kv = stats.find((s) => s.key === key);
  return kv ? kv.value : undefined;
}

const client = new MilvusClient({ address: ADDRESS, token: TOKEN });

let exitCode = 0;
try {
  // 1) Confirm the collection exists / inspect schema (read-only).
  const desc = await client.describeCollection({ collection_name: COLLECTION });
  if (desc.status && desc.status.error_code && desc.status.error_code !== 'Success') {
    console.error('[E3] describeCollection failed:', JSON.stringify(desc.status));
    process.exit(5);
  }
  const pkFromSchema = (desc.schema?.fields ?? []).find((f) => f.is_primary_key);
  const pkName = pkFromSchema ? pkFromSchema.name : PK_FIELD;

  // 2) Row count from statistics (read-only).
  const statsRes = await client.getCollectionStatistics({ collection_name: COLLECTION });
  const totalRows = Number(statVal(statsRes.stats, 'row_count') ?? NaN);

  // 3) Load-state check (read-only). queryIterator needs the collection loaded;
  //    we will NOT load it ourselves (that mutates server memory state).
  const loadState = await client.getLoadState({ collection_name: COLLECTION });
  const stateStr = loadState.state ?? loadState.status?.reason ?? 'unknown';
  const isLoaded = String(stateStr).includes('Loaded');

  if (!isLoaded) {
    const partial = {
      collection: COLLECTION,
      totalRows: Number.isFinite(totalRows) ? totalRows : null,
      distinctPKs: null,
      duplicateRows: null,
      ratio: null,
      loadState: stateStr,
      note: 'collection NOT loaded; refusing to loadCollection (would mutate memory state). distinct-PK scan skipped.',
    };
    console.log(JSON.stringify(partial, null, 2));
    console.error('[E3] collection not loaded — read-only safe abort (no load performed).');
    process.exit(0);
  }

  // 4) Scroll ALL PK values via queryIterator (paginated query under the hood).
  const ids = new Set();
  let scanned = 0;
  const iterator = await client.queryIterator({
    collection_name: COLLECTION,
    output_fields: [pkName],
    batchSize: BATCH_SIZE,
    expr: `${pkName} != ""`, // VarChar PK; selects every row
  });

  for await (const batch of iterator) {
    for (const row of batch) {
      const v = row[pkName];
      if (v !== undefined && v !== null) ids.add(String(v));
    }
    scanned += batch.length;
  }

  const distinctPKs = ids.size;
  const duplicateRows = (Number.isFinite(totalRows) ? totalRows : scanned) - distinctPKs;
  const denom = Number.isFinite(totalRows) && totalRows > 0 ? totalRows : scanned;

  const report = {
    collection: COLLECTION,
    totalRows: Number.isFinite(totalRows) ? totalRows : scanned,
    distinctPKs,
    duplicateRows,
    ratio: denom > 0 ? Number((distinctPKs / denom).toFixed(6)) : null,
    scannedViaIterator: scanned,
    pkField: pkName,
    contaminated: duplicateRows > 0,
    // queryIterator paginates by PK cursor (lastPKId), so duplicate-PK physical
    // rows collapse during the scan — that is why scannedViaIterator can be < the
    // authoritative getCollectionStatistics row_count. duplicateRows is therefore
    // computed against totalRows (the physical truth), NOT against scannedViaIterator.
    note: 'duplicateRows = getCollectionStatistics.row_count - distinctPKs; iterator scan undercounts physical rows by design (PK-cursor pagination collapses duplicate PKs).',
  };

  console.log(JSON.stringify(report, null, 2));
  console.error(
    `[E3] done — totalRows=${report.totalRows} distinctPKs=${distinctPKs} duplicateRows=${duplicateRows} (NO compaction performed)`
  );
} catch (e) {
  console.error('[E3] ERROR', e && e.stack ? e.stack : e);
  exitCode = 1;
} finally {
  try { if (client && typeof client.closeConnection === 'function') client.closeConnection(); } catch {}
}

process.exit(exitCode);
