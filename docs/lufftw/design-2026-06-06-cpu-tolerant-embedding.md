# Design — CPU-Fault-Tolerant RabbitMQ Embedding (PP-SCL)

**Date:** 2026-06-06
**Status:** Approved (direction); spec under owner review
**Scope:** All 3 phases, shipped incrementally
**Author:** design panel (9-agent deliberation) + synthesis
**Fork-only feature** — lives here per `CLAUDE.md` ("fork-only design notes go in `docs/lufftw/`").

Related: [`rabbitmq-embedding-provider.md`](./rabbitmq-embedding-provider.md),
[`bugfix-2026-05-05-deepinfra-rogue-worker.md`](./bugfix-2026-05-05-deepinfra-rogue-worker.md).

---

## 1. Problem

The fork's embedding provider (`RabbitMQEmbedding`) is an RPC-over-RabbitMQ publisher
tuned for a **fast GPU worker**. The operating reality is the opposite: the **normal**
mode is **slow CPU embedding** (qwen3-embedding-8b, 4096-dim, llamacpp), with occasional
GPU bursts. The broker is explicitly configured for this — `consumer_timeout = 7,200,000 ms
(2 hours)`. The provider is not.

### The exact failure chain (CPU mode)

1. `sendOne` arms a **30 s in-memory timeout** per request.
2. A slow CPU worker takes longer than 30 s → the timer fires → the pending promise is
   deleted. **The worker's eventually-completed embedding is now orphaned** (its late reply
   hits the stale-drop and is discarded).
3. `embedBatch` uses `Promise.all`, so that **one** timeout rejects the **entire** 100-chunk
   batch.
4. `context.ts processFileList` counts the batch as a failure; after
   `INDEX_MAX_CONSECUTIVE_ERRORS` (default 3) consecutive batch failures it **aborts the
   whole index run**.

Net: *slow worker → orphaned completed work → batch reject → 3 strikes → run aborts.*
The 3-strike guard (added for the 2026-05-05 rogue-worker incident) cannot currently tell
**"worker is slow"** from **"worker is broken."**

### Two latent correctness holes (independent of the timeout bug)

- **Partial-file hole.** `fileHash` is stamped on **every** chunk of a file, and resume
  treats "fileHash present" as "file done." If only *some* chunks of a file land (crash, or
  the abort above), the file looks complete forever and its missing chunks are never
  re-embedded.
- **Pagination hole.** `loadExistingFileHashes` reads at most **16,384 rows** with no
  pagination, so resume on any collection larger than that already skips/!re-embeds the
  wrong files **today**, before any of this work.

---

## 2. Hard constraints (non-negotiable)

1. **Shared queue.** `embedding.qwen3-8b` on vhost `inference` is shared across ~30
   projects. **Never** purge / delete / redeclare it. Validation may only **publish** test
   embeddings, at **priority 8–9**, to jump the backlog politely.
2. **No model mixing.** Every consumer must be qwen3-8b / 4096-dim (the rogue-worker
   incident mixed a different model and poisoned collections). The design must **not** assume
   it controls the workers.
3. **Single-process ⇒ exclusive reply queue is correct.** A shared/durable reply queue with
   multiple consumers would round-robin and lose ~50 % of replies (poi-data-layer gap 3). Any
   durability idea must still guarantee **exactly one** reply consumer.
4. **Never insert a zero/empty vector** into Milvus (poisons ANN search).
5. **stdout is sacred** (JSON-RPC). Diagnostics → stderr only.

### Durable stores actually available to this MCP

- **Milvus collections** (vectors + metadata).
- **A proper-lockfiled JSON snapshot** (`<CLAUDE_CONTEXT_HOME>/mcp-codebase-snapshot.json`).
- **No Postgres, no Redis.** (This is why event-crawler's exact pattern can't be copied.)

---

## 3. Reference patterns studied (this session)

- **event-crawler** (mature, gold standard): fire-and-forget publish, **named durable reply
  queue**, `correlationId = DB primary key`, dedicated reply consumer, 3-layer state
  (durable queue / Redis NX dedup / Postgres status machine), retry-via-republish with
  `x-retry-count`, DLX/DLQ, stuck-reaper.
- **event-search-service venue-link** (async): fast-write + ack, background refinement,
  crash recovery via startup reset + drain + sweeps. **Key insight: a sync in-memory timeout
  orphans already-completed work; async survives because the task id persists durably.**
- **poi-data-layer** (NOT production-stable — claude-context was likened to this). 12 gaps
  catalogued as a do-not-repeat checklist; the most relevant: shared reply queue 50 % loss
  (gap 3), connection-reconnect that doesn't re-establish the consumer (gap 4), empty-vector
  poison (gap 8), unbounded pending map (gap 1), publish-failure orphan (gap 11), no
  publisher confirms (gap 12).

---

## 4. The design — PP-SCL (Patient Publisher + Snapshot Completeness Ledger + Native Upsert)

**Verdict vs baselines: a corrected, hybrid form of C** (phased hardening of A) with B's
"durable state is the ledger" insight redirected to the **right** datastore.

> All four panel architects independently proposed "A + a Milvus *receipt row* to seal a
> file as done." All four were rejected for the same verified reason: a Milvus row needs a
> mandatory `FloatVector`, so a completeness-marker row means **either a banned zero-vector
> or ANN-search poisoning**. PP-SCL puts the completeness ledger in the **proper-lockfiled
> JSON snapshot** instead — no zero-vectors, no second datastore, no search-time filter.

**Why it beats the alternatives**
- **vs A:** A leaves the partial-file hole open and hand-waves idempotency; PP-SCL closes
  both, correctly.
- **vs B:** B's durable reply queue must still pin exactly one consumer (re-creating gap 3
  risk) for **zero benefit** — Milvus + snapshot already give durable resume. B also imports
  a producer/consumer split + new `embedding_pending` state + sweeps. PP-SCL gets B-grade
  crash safety on the **synchronous exclusive-reply topology the constraints call correct**.

The synchronous `Embedding` interface (`embed`/`embedBatch` return real vectors) and the
exclusive+autoDelete reply queue are **kept** — they are correct for a single-process MCP.

---

## 5. Phasing (sequenced; each independently shippable)

### Hotfix PR (first) — `loadExistingFileHashes` pagination
Standalone correctness fix for the 16,384-row truncation. Ships before Phase 1 because it
already corrupts resume for large collections today, independent of this work. Implement the
keyset / `queryIterator` pagination the docstring already promises; assert via a synthetic
>20k-chunk readback that **all** files return (not a truncated subset).

### Phase 1 — Patient Embed Core (~1 PR, low risk — *the bug fix*)
Fixes the failure chain in §1. Shippable and valuable alone. See mechanisms 1–6, 11.

### Phase 2 — Snapshot Completeness Ledger (medium risk — touches indexer core loop)
Closes the partial-file hole. Depends on Phase 1's per-chunk success accounting. See
mechanisms 7–9. **Highest-risk edit** (the file-aware buffer rework) — its own PR, well
tested. Depends on the Hotfix pagination being in place.

### Phase 3 — Native Upsert (small-medium)
Idempotent crash-resume without the delete-then-insert kill window. See mechanism 10.
Hybrid (BM25) path is **probe-first** (§8). Falls back to delete-before-insert if absent.

---

## 6. Mechanisms

1. **Patient timeout = liveness backstop, not a slowness failure.** Replace the 30 s
   `timeoutMs` default with `RABBITMQ_EMBEDDING_TIMEOUT_MS`, **default determined empirically**
   (§7), bounded well under the 2 h broker `consumer_timeout`. A worker holding a message 40
   min is *correct*; the timer fires only for genuinely-lost messages.
2. **Per-chunk bounded retry-via-republish**, wiring the dormant `retryCount` /
   `x-retry-count` envelope fields. `sendOne` → `sendOneWithRetry`: on a wait-class outcome,
   republish with `retryCount+1` and a **fresh `taskId`**, up to
   `RABBITMQ_EMBEDDING_MAX_RETRIES` (default 5), priority held at the configured indexing
   value (**≤ 7, never escalated**). On republish, **eagerly delete the superseded `taskId`
   from `pending` and clear its timer** (closes poi gaps 1 & 11). The superseded worker's
   late reply hits the existing stale-drop (`rabbitmq-embedding.ts:170`) — harmless.
3. **`Promise.allSettled` partial-batch tolerance + hard zero-vector ban.** Rewrite
   `embedBatch` from `Promise.all` to settled accounting, returning a parallel **success
   mask**: each slot is a real `dimension`-length finite-numeric vector or a typed `FAILED`
   sentinel — **never `[]`, never zeros**. Add a `vector.length === getDimension()` assertion
   at the seam (defends the rogue-worker dimension hazard).
4. **Insert only succeeded chunks.** `processChunkBatch` consumes the success mask, builds
   `documents` from succeeded indices only, and reports failed indices upward. A chunk
   without a real vector is never written. The existing empty/malformed reject
   (`rabbitmq-embedding.ts:192-195`) is preserved and routed to fault classification.
5. **Wait-vs-real fault classification feeding the abort counter.**
   - *Wait-class* (retry, **do not** increment `consecutiveBatchErrors`): timeout /
     no-consumer / connection-or-channel-close.
   - *Real* (counts toward `MAX_CONSECUTIVE_BATCH_ERRORS`): worker `success:false` /
     dimension mismatch / malformed reply / Milvus insert error.

   This severs the "slow worker → strike" chain while **preserving the rogue-worker guard**.
6. **Reconnect re-establishes the consumer + stale-`replyTo` safety.** `resetState` already
   tears down on close and the next `embed*` re-runs `_doInitialize`. Add: in-flight
   republishes read `this.replyQueue` **at publish time** (never a stale closure capture); a
   reconnect republishes wait-class in-flight tasks rather than counting them as real faults.
   The reply queue stays exclusive+autoDelete (constraint 3). (Closes poi gap 4.)
7. **File-aware buffering (Phase 2).** Track each file's chunks across batch flushes with a
   per-file success/insert tally. `processedFiles++` fires only after a file's chunks are
   **confirmed inserted**, not when the file is merely read. **Keep cross-file batching** for
   throughput — do not shrink the durability unit to one file (that would 7–100× the RPCs and
   regress slow-CPU wall-clock).
8. **Snapshot Completeness Ledger (Phase 2 keystone).** Keep stamping `fileHash` into chunk
   metadata as a cheap resume *hint*, but make the **authoritative** completeness signal a new
   snapshot field:
   ```jsonc
   "files": {
     "<relativePath>": { "fileHash": "<sha256>", "chunkCount": <n>, "complete": <bool> }
   }
   ```
   written under the existing `proper-lockfile` **only after** a file's chunks all confirm
   inserted. Resume skips a file only if a `complete:true` entry exists with a matching
   `fileHash`. Killed-mid-file → `complete:false`/absent → re-embedded next run. (No
   after-the-fact hash re-stamp — that would reintroduce poi gap 9.)
9. **Paginated readback (Phase 2 prerequisite — shipped as the Hotfix).** The fileHash map is
   a fast pre-filter; the snapshot ledger is the completeness authority.
10. **Native upsert (Phase 3).** Add `upsert(collectionName, documents)` and
    `upsertHybrid(...)` to `VectorDatabase` and both drivers, wrapping the SDK's
    `client.upsert` (**verified present in `@zilliz/milvus2-sdk-node@2.5.10`** — re-verify at
    implementation). `processChunkBatch` upserts so re-indexing a new/partial file overwrites
    deterministic PKs idempotently — no delete-then-insert kill window. Fallback when absent:
    unconditional `deleteByFilter(relativePath)` before insert for every (re)processed file.
11. **Optional priority-9 preflight liveness probe.** One tiny embed at priority 9 before a
    run; "no qwen3-8b consumer" → fast friendly error instead of burning
    timeout × maxRetries. Cached with explicit TTL, **fail-CLOSED** (wait), publish-only,
    never a redeclare/purge. The *only* priority 8/9 traffic in normal operation.

---

## 7. The timeout default — determined empirically (owner decision)

The owner's CPU workers can legitimately run for **hours**, so the default is **not**
hard-coded to a guess. Phase 1 includes a **measurement step**:

1. Publish a small set of representative chunks at **priority 9** through the normal publish
   path and **time the real round-trip on the live CPU worker** (no purge; consume our own
   replies only).
2. Set `RABBITMQ_EMBEDDING_TIMEOUT_MS` default to a comfortable multiple of the observed p99
   per-chunk latency (headroom for queue wait), bounded under the 2 h broker ceiling.
3. The value is env-configurable regardless; the measured number is just the **shipped
   default**.

The panel's provisional placeholder was 10 min; the real default will be set from the
measurement and discussed before Phase 1 merges.

---

## 8. Hybrid (BM25) upsert — probe-first (owner decision)

`sparse_vector` on the hybrid collection is a **function-output field**; `client.upsert` may
reject function-field schemas. Phase 3:

1. Run a **priority-9 probe** that upserts a known PK into a hybrid collection and asserts
   `sparse_vector` **regenerates** correctly.
2. Use native upsert for the hybrid path **only if proven**; otherwise the hybrid path keeps
   `deleteByFilter`-before-insert. The non-hybrid path uses native upsert either way.

---

## 9. Must-have checklist (with HOW)

| Requirement | HOW |
|---|---|
| **cpu-latency tolerance** | Mech 1 (liveness-backstop timeout under the 2 h ceiling) + Mech 5 (wait-class faults never increment the abort counter). |
| **never-zero-vector** | Mech 3/4 (`allSettled` → typed `FAILED`, never `[]`/zeros; dimension assertion; only succeeded chunks written). Ledger lives in the **snapshot**, not a Milvus row → no placeholder vector ever needed. |
| **shared-queue etiquette** | No path declares/purges/deletes the queue; publish-only (default exchange, route-by-name). Indexing priority ≤ 7, no escalation. Priority 8/9 only for the opt-in preflight probe + validation tests. |
| **single-consumer reply** | Unchanged exclusive+autoDelete server-named reply queue, one `consume` per process. Durable/shared reply queue (gap 3) structurally avoided. |
| **crash recovery** | Mech 8 (`complete:true` in lockfiled snapshot is the resume anchor; mid-file → re-embed) + Mech 9 (paginated readback sees all files). |
| **idempotency** | Mech 10 (`client.upsert` on deterministic `chunk_<sha256>` PK) + fallback delete-before-insert. |
| **per-file completeness** | Mech 7/8 (completeness tracked per file across batches; ledger write + `processedFiles++` only after all chunks confirm inserted). |
| **reconnect re-establishes consumer** | Mech 6 (`resetState` + next `_doInitialize`; republish reads current `replyQueue`). Closes gap 4. |
| **bounded in-flight** | `concurrency` cap retained; eager supersede-eviction + `maxRetries` cap bound the `pending` map and republish volume. Closes gaps 1/11. |
| **fault-vs-slow classification** | Mech 5 taxonomy severs "slow → strike" while preserving the rogue-worker guard. |

---

## 10. Files touched

- `packages/core/src/embedding/rabbitmq-embedding.ts` — `sendOne`→`sendOneWithRetry`
  (timeout backstop, republish wiring, eager supersede-eviction, fault tagging); `embedBatch`
  (`Promise.all`→settled + success mask, dimension assertion); reply consumer (keep stale-drop
  line 170, add dimension check); `resetState`/`_doInitialize` (reconnect republish, current
  `replyQueue` read). New config: `timeoutMs` default, `maxRetries`.
- `packages/core/src/context.ts` — `processChunkBatch` (consume success mask, build
  `documents` from succeeded indices, insert→upsert); `processFileList` (file-aware
  completeness across batches, fault classification into `consecutiveBatchErrors`, move
  `processedFiles++`/ledger write to post-file-confirm); `loadExistingFileHashes` (real
  pagination — **Hotfix**); `generateId` reused unchanged.
- `packages/core/src/vectordb/types.ts` — add `upsert` + `upsertHybrid` to `VectorDatabase`
  (Phase 3).
- `packages/core/src/vectordb/milvus-vectordb.ts` + `milvus-restful-vectordb.ts` — implement
  `upsert`/`upsertHybrid` via `client.upsert` (Phase 3).
- `packages/mcp/src/snapshot.ts` — extend schema with the per-file completeness map (Phase 2).
- `packages/mcp/src/config.ts` / `packages/mcp/src/embedding.ts` — new env knobs.
- `docs/lufftw/rabbitmq-embedding-provider.md` — document patient-publisher semantics, the
  ledger, and env knobs.

---

## 11. Snapshot / state changes

- **New snapshot field (Phase 2):** `files: { <relativePath>: { fileHash, chunkCount,
  complete } }`, written only under the existing lockfile. The single new durable structure.
  Existing `indexing/indexed/indexfailed` run states retained.
- **No new Milvus schema, no receipt rows, no second datastore.** Collections unchanged
  except the additive `upsert`/`upsertHybrid` write path.
- **In-memory only (per-run):** `pending` map (bounded by eager eviction + maxRetries),
  per-file success tallies, cached preflight-probe result with TTL.
- **Env knobs (project `.env` scope per `layered-configuration.md`):**
  `RABBITMQ_EMBEDDING_TIMEOUT_MS`, `RABBITMQ_EMBEDDING_MAX_RETRIES`,
  `RABBITMQ_EMBEDDING_PREFLIGHT`.

---

## 12. Risks & mitigations

- **Snapshot ledger ↔ Milvus divergence.** Write the ledger entry *after* insert
  confirmation; on disagreement the failure mode is *re-work* (re-embed), never data loss or
  zero-vectors — and upsert (Phase 3) makes re-work idempotent.
- **File-aware buffer rework (Phase 2) is the highest-risk edit** — its own phase, unit test
  asserting a file with one failed chunk stays `complete:false`. Keep cross-file batching.
- **Hybrid upsert unverified** — probe-first (§8); hybrid keeps delete-before-insert until
  proven.
- **Republish volume on the shared queue** — with an empirically-set timeout, slow-but-alive
  workers rarely hit the backstop; `maxRetries` cap + priority ≤ 7 bound it. `checkQueue`
  backpressure deferred (§13).
- **Snapshot write contention** — flush the ledger **per-batch**, not per-file (owner
  decision): resume granularity stays per-file at a little extra re-work on crash, with far
  less lockfile churn.

---

## 13. Deferred / out of scope (with cause)

- **Shared-queue `checkQueue` backpressure throttle** — deferred until monitoring shows
  claude-context is a noisy neighbor on the 30-project queue.
- **Discarded by the panel (do not revisit):** in-collection Milvus receipt row (banned
  vector / search poisoning); after-the-fact `fileHash` re-stamp (poi gap 9); a
  `recentlyAbandoned` LRU to "de-orphan" settled promises (cannot un-reject → double
  production); per-batch pre-existence `query()` on the hot path (read-after-write
  inconsistency + latency — superseded by native upsert); fully-async producer/consumer split
  (option B — unnecessary given snapshot+Milvus durable resume, and re-introduces gap-3 risk).

---

## 14. Test strategy

- **Provider unit tests** (injected `connectFn`, no broker): timeout→republish increments
  `x-retry-count` and evicts the superseded `pending` entry; superseded late reply is dropped
  and does not leak; `embedBatch` partial — one slow chunk does not reject the other 99;
  zero/empty/wrong-dimension reply → `FAILED` sentinel, never inserted; reconnect mid-batch
  republishes wait-class in-flight with the current `replyQueue`.
- **Indexer unit tests:** a file whose last chunk permanently fails stays `complete:false`
  and is re-processed next run; a timeout does **not** increment `consecutiveBatchErrors`, a
  `success:false` **does**; re-run of a half-done file via upsert produces no duplicate PKs.
- **`loadExistingFileHashes` scaling gate (binary acceptance):** synthetic >20k-chunk corpus;
  assert the readback returns **all** files (row count), not a 16,384-truncated subset.
- **Crash-recovery (binary acceptance):** index a synthetic corpus, kill the process mid-run
  (capture exit code), re-run, assert via (a) Milvus row count, (b) snapshot ledger `complete`
  flags, (c) a diff showing zero already-`complete` files are re-embedded and zero chunks are
  missing. **No substring matching** — exit code + row count + ledger diff shape, captured and
  asserted by the **same runtime**.
- **Live priority-9 round-trip WITHOUT purging the shared queue:** publish one tiny embed at
  priority 9 via the normal `publish` path (never declare/purge/redeclare), fresh exclusive
  reply queue; assert a 4096-dim finite normalized vector returns. Second probe at priority 8
  confirms the priority field is honored end-to-end. **Confirm the shared queue's message
  count is unchanged afterward** (publish-then-consume-own-reply only).

---

## 15. Decision log (owner, 2026-06-06)

1. **Scope:** all 3 phases, ship incrementally.
2. **Timeout default:** determined empirically (§7), not hard-coded; env-configurable.
3. **Pagination fix:** standalone Hotfix PR first, then Phase 1 → 2 → 3.
4. **Hybrid upsert:** probe-first, fallback to delete-before-insert (§8).
5. **Ledger flush granularity:** per-batch (§12).
6. **Backpressure:** deferred (§13).
