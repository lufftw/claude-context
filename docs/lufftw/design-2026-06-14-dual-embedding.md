# Design — Dual-Embedding (Per-Model Collection, Option B)

**Date:** 2026-06-14
**Status:** Approved (rev1.2 — council → 3-round adversarial review → R4 confirmation → GO)
**Scope:** MVP — prove end-to-end on `claude_context_own` only; larger backfills + live dual-write are Phase 2.
**Author:** 7-agent design council + 3-round adversarial review (34 agents) + R4 confirmation, synthesized.
**Fork-only feature** — lives here per `CLAUDE.md` ("fork-only design notes go in `docs/lufftw/`").

Related: [`rabbitmq-embedding-provider.md`](./rabbitmq-embedding-provider.md),
[`design-2026-06-06-cpu-tolerant-embedding.md`](./design-2026-06-06-cpu-tolerant-embedding.md),
[`private-shared-collections.md`](./private-shared-collections.md).
Full implementation plan: `docs/plan/2026-06-14-dual-embedding.md` (the source-of-truth copy).

---

## 1. Goal

Let claude-context index and search a codebase with **two embedding models side by side** —
the existing **Qwen3-Embedding-8B** (4096-dim, the primary) and a new
**Qwen3-Embedding-0.6B** (1024-dim, the secondary) — so the lightweight 0.6B path stays
usable when the GPU-heavy 8B path is unavailable. The model is selected **explicitly per
request**; there is no automatic switching.

The operating premise (**LD-0**): the real GPU contention is **LLM-vs-8B**, not 8B-vs-0.6B.
Both embedding workers are live simultaneously. This process **cannot observe** whether the
LLM owns the GPU, so it does not try to — model selection is made by whoever owns the LLM
(operator / orchestrator), via env default + per-call parameter.

---

## 2. Why Option B (one collection per model)

Milvus **cannot add a vector field to an existing collection**. A single collection cannot
hold both a 4096-dim and a 1024-dim dense vector for the same row. Therefore each model gets
its **own collection**:

| Model | Dimension | Collection (MVP example) | Suffix |
|---|---|---|---|
| `qwen3-embedding-8b` (primary) | 4096 | `claude_context_own` | `''` (none) |
| `qwen3-embedding-0.6b` (secondary) | 1024 | `claude_context_own_0p6b` | `_0p6b` |

The secondary collection name is `<primary>` + `_0p6b`. `MILVUS_COLLECTION_PRIVATE_0P6B`
overrides the derived name verbatim if set. The suffix is keyed off the **canonical model
id** (stable), never the collection name (env-mutable).

> **Irreversibility (residual risk).** A wrong-dimension `_0p6b` collection cannot be fixed
> in place — it needs `drop_collection` + full re-backfill. Verify `dim=1024` **live**
> (`describeCollection`) before any backfill. This is the same dimension-lock-in rule that
> already governs the 8B collection.

Alternatives rejected: a single mixed-dimension collection (impossible in Milvus);
cross-model RRF / score-merge (incoherent across 4096 and 1024 spaces — scores are not
comparable). **One model per query, no cross-space merge.**

---

## 3. Locked decisions (LD-0 .. LD-12)

| ID | Decision |
|---|---|
| **LD-0** | Contention is **LLM-vs-8B**, not 8B-vs-0.6B (both embedding workers run simultaneously). claude-context **cannot observe** the LLM's GPU state → **no auto-detection**. Model selection is **explicit** (env default + per-call param), set by whoever owns the LLM. |
| **LD-1** | Model registry = TS module `packages/core/src/embedding/model-registry.ts`. `EmbeddingModelSpec = { id, queue, dimension, collectionSuffix, priorityDefault }`. Two entries. No `storageField` (the Milvus dense field is always `vector`). No `rerankByDefault` (v1 YAGNI). `getModelSpec(id)` throws on unknown. |
| **LD-2** | Each model = a **distinct configured `RabbitMQEmbedding` instance** (the per-instance dimension guard forbids reusing one instance across dimensions). The secondary instance is constructed **only when configured**; otherwise the single-model path is **byte-identical** to today. |
| **LD-3** | A real **model→collection resolver** threaded through the call sites — NOT free reuse of the multi-collection (private+shared) machinery. Suffix comes from the registry; `MILVUS_COLLECTION_PRIVATE_0P6B` overrides verbatim. **Secondary suffix = `_0p6b`**. |
| **LD-4** | **KEYSTONE.** Snapshot ledger becomes per-`(codebase × model)`: add optional `filesByModel?: Record<modelId, Record<relPath, FileCompleteness>>`; the top-level `files` stays the literal 8B ledger. Keyed by **model id** (stable), not collection name. The round-trip test gates the whole feature. **(See §4 — emit stays `formatVersion: 'v2'`, additive.)** |
| **LD-5** | Inner index loop → per-model via `IndexTarget { modelId, collectionName, embedding, isHybrid, priorLedger }`. The outer Merkle scan/split runs **once**; each target embeds with its own instance and upserts to its own collection. Resume-skip fires only when **every** active target agrees `complete:true` at the same hash. **(M8 refines: re-embed only the individually-disagreeing targets, not all.)** |
| **LD-6** | Delete-on-change scoped **per target**; a target delete failure marks that file `complete:false` in **that target's** ledger (pair every abort with recovery). The monolithic private+writable-shared delete is removed. |
| **LD-7** | PK generation **unchanged** (`generateId(path,start,end,content)`, model-blind). Same chunk → same PK in both collections; upsert idempotency holds per-collection. |
| **LD-8** | Search: optional `embeddingModel` param on `search_code` (`qwen3-embedding-8b` default \| `qwen3-embedding-0.6b`) + `SEARCH_EMBEDDING_MODEL` env default + hard fallback to 8B. **One model per query** (no cross-space RRF). Within-model private+shared merge preserved **for the 8B primary only** (M5). Requested-but-unconfigured collection → clear notice, never a wrong-dim search. |
| **LD-9** | Backfill source by collection type: **(A) filesystem re-chunk** for private collections with a local checkout (MVP); **(B) mirror-from-8B** only for scattered-source shared collections (Phase 2, gated on dedup). Backfill embeds at registry `priorityDefault` (=1). |
| **LD-10** | **MVP scope gate:** prove end-to-end on `claude_context_own` (~2,283 rows / 9MB) **only**. `event_shared` (9.3GB), mirror-backfill, live dual-write = Phase 2. Below the coverage threshold the 0.6B collection is **not readable** — explicit degraded notice, never silent partial. |
| **LD-11** | Duplicate-PK **dedup/compaction of the 8B source** is a **prerequisite** for the coverage gate and mirror-backfill (collections carry duplicate VarChar-PK rows from the historical insert-not-upsert path). MVP: assess + compact `claude_context_own` before snapshotting distinct-PK ground truth. |
| **LD-12** | A long backfill flushes the ledger **coarsely** (≥30s or per-N-files), not the interactive 2s tick, to avoid starving the **shared** multi-user snapshot lock. The MVP small run is unaffected; the knob is wired for Phase-2 large backfills. |

### Review overrides folded into the build (rev1.2)

- **M1 supersedes "v2→v3 bump".** The snapshot emit stays `formatVersion: 'v2'`; `filesByModel` / `coverageByModel` ride additively (see §4). LD-4's "v2→v3" wording is read as "v2-additive".
- **M5 overrides LD-8's "private+shared merge preserved".** The shared arm is appended **only for the 8B primary** — a 1024 query against the 4096-dim shared collection is a guaranteed dim-mismatch (and the MVP target `claude-context` is itself a hybrid+shared project). The 0.6B path queries its `_0p6b` collection **only**, with no shared arm.
- **M8 overrides LD-5's "re-process ALL targets".** Resume-skip is per-target: AST-split the file once iff **any** target needs it, then embed+upsert **only** the individually-disagreeing targets. (Otherwise a 0.6B-only backfill would re-embed the entire 8B corpus through the GPU-heavy worker on every run — defeating LD-0.)
- **C1 (R4).** `SEARCH_EMBEDDING_MODEL` is resolved at a **single, project-scoped** site inside `_semanticSearchImpl` (runs inside `runWithProject`, so the project `.env` wins). The handler passes the explicit arg or `undefined` and does **not** read `process.env`. This honors the fork's project-`.env`-priority rule and the user's manual-per-session trigger.
- **C2 (R4).** `MILVUS_WRITABLE_SHARED` dual-write is implemented as an actual same-instance `IndexTarget` (synthetic key `__writable_shared__`, same dimension as the primary), **not** an inline upsert. It is invisible to status/search enumeration (those enumerate canonical model ids by name).

---

## 4. The snapshot ledger — v2-additive (the keystone)

The completeness ledger is the gate for the whole feature, because it decides resume-skip
and (via the coverage ratio) search readability. Two additive optional fields are added to
each codebase entry:

```ts
// per-model completeness; top-level `files` stays the literal 8B ledger
filesByModel?: Record<string, Record<string, FileCompleteness>>;
// per-model distinct-PK coverage ratio (P4 search-degrade gate)
coverageByModel?: Record<string, number>;
```

Design rules:

- **Emit stays `formatVersion: 'v2'`.** The new keys ride *inside* a v2 document. This
  uniquely preserves two invariants at once: (1) a single-model write is **byte-identical**
  to today (the new keys are simply absent), and (2) the **old `dist` can still read** the
  file — `loadV2Format` stores info verbatim and ignores unknown keys.
- **Read predicate is forward-tolerant** (`isV2OrLater`) at the load dispatch *and* the
  merge-read gate. This matters because the snapshot is a **shared multi-user file**: if any
  binary emitted a literal `v3` and another binary's read predicate rejected it, the next
  save would **wipe the shared snapshot** for everyone.
- **Carry-forward is exhaustive.** All three carry-forward sites (the 2s tick, the terminal
  status transition, the cross-process merge) use a spread (`...rest`) and recompute only
  status/percentage/stats — never field-by-field enumeration. This is what lets
  `filesByModel` and `coverageByModel` (and any future additive field) survive a round-trip
  through another user's process. Verified by a round-trip test driving **two**
  `SnapshotManager` runtimes (capture-and-verify share the same code).

The ledger is keyed by **model id** because the collection name is env-mutable
(`MILVUS_COLLECTION_PRIVATE_0P6B` can change) but the model id is stable.

---

## 5. Search — explicit model selection + coverage gate

```
search_code({ query, path, embeddingModel?: 'qwen3-embedding-8b' | 'qwen3-embedding-0.6b' })
```

Resolution precedence (single authoritative site, project-scoped):

```
explicit `embeddingModel` arg  >  SEARCH_EMBEDDING_MODEL (project .env)  >  qwen3-embedding-8b
```

- **8B (primary):** queries `<project>_own` and (in hybrid mode) the shared collection,
  merged by score within the model — unchanged from today.
- **0.6B (secondary):** queries `<project>_own_0p6b` **only**. No shared arm (M5).
- **Coverage gate (P4 / LD-10).** Before any 0.6B ANN call, `isCoverageSufficientForModel`
  checks the persisted distinct-PK overlap ratio against `COVERAGE_READABLE_THRESHOLD`
  (default **0.85**). The primary is always sufficient. For the secondary, ratio **below**
  threshold *or* unknown (no reader / undefined) ⇒ **DEGRADED** — return an explicit notice,
  **never** a silent partial result and **never** an ANN call.
- **Requested-but-unconfigured** model ⇒ structured `{ degraded: true, reason: 'secondary-not-configured' }`,
  never a wrong-dim search.

`isModelReadable(codebase, modelId)` is the **single shared predicate** consumed by both
`get_indexing_status` and `_semanticSearchImpl`, so status and search can never disagree.

---

## 6. Activation & backfill

**Activation signal:** the secondary embedding instance is constructed **if and only if**
`MILVUS_COLLECTION_PRIVATE_0P6B` is set (truthy). Absent ⇒ no secondary instance, no `_0p6b`
collection touched, single-model path byte-identical.

**New config keys** (all optional; scope = project `.env` per layered-config rules):

| Key | Default | Purpose |
|---|---|---|
| `MILVUS_COLLECTION_PRIVATE_0P6B` | — | **Activation signal** + verbatim secondary collection name. |
| `RABBITMQ_SECONDARY_QUEUE` | `embedding.qwen3-0.6b` | Secondary worker queue. |
| `RABBITMQ_SECONDARY_DIMENSION` | `1024` | Secondary vector dimension. |
| `RABBITMQ_SECONDARY_MODEL` | `qwen3-embedding-0.6b` | Logical model id (must be a canonical registry id). |
| `SEARCH_EMBEDDING_MODEL` | `qwen3-embedding-8b` | Per-session default search model (project `.env` authoritative). |
| `COVERAGE_READABLE_THRESHOLD` | `0.85` | Distinct-PK overlap below which the 0.6B collection is not readable. |

> **`EMBEDDING_DUAL_WRITE` is NOT a key.** It appears in no source file, so "wired-but-OFF"
> is unverifiable by any gate. It is deliberately **absent** from the implementation. Live
> dual-write (concurrent 8B+0.6B on every interactive index) remains governed exclusively by
> the existing `MILVUS_WRITABLE_SHARED` mechanism. The 0.6B collection is populated by an
> **offline priority-1 backfill**, not by interactive dual-write.

**Backfill (Phase 5, source A — filesystem re-chunk):** index the project with **only** the
0.6B `IndexTarget` active. An empty per-model ledger makes every file appear missing ⇒ full
backfill, reusing all the Merkle/skip/ledger/upsert logic. Embeds at `priorityDefault` (=1)
so it never starves interactive 8B work (priority 10). Resumable + idempotent (per-target
ledger + native upsert). Before measuring coverage, dedup/compact the 8B source (LD-11) so
the distinct-PK ratio is meaningful.

---

## 7. MVP scope & out-of-scope

**In scope (MVP):** the two-model registry; per-model `RabbitMQEmbedding` instances; the
v2-additive ledger; the per-model `IndexTarget` index/delete/clear loop; explicit-model
search with the coverage degrade gate; the filesystem backfill of `claude_context_own_0p6b`;
the 8B dedup prerequisite; cross-repo doc sync.

**Out of scope (Phase 2 / deferred YAGNI cuts):**

- `event_shared` (9.3GB) 0.6B backfill — gated on measured MVP throughput.
- Mirror-from-8B backfill (source B) — gated on dedup/compaction + client-side PK dedup.
- Live `EMBEDDING_DUAL_WRITE` — deferred (doubles interactive GPU; offline backfill instead).
- GPU auto-detection / timeout-fallback — cut (contention is unobservable here; LD-0).
- Cross-model RRF / score-merge — cut (incoherent across 4096/1024 spaces).
- Registry `storageField` / `rerankByDefault` — cut from v1.
- Shared-collection secondary override keys, per-call connection pooling — deferred.

---

## 8. Residual risks (carried into execution)

1. **Fix-fragmentation** — the coupled invariants are concentrated behind **three shared
   owners**: one exhaustive carry-forward spread, one `buildIndexTargets()` array (consumed
   by index + delete + clear + prepare), one `isModelReadable()` predicate (consumed by
   status + search).
2. **Shared-snapshot blast radius** — a carry-forward miss corrupts *other users'* resume
   state; gating tests use two runtimes.
3. **Milvus Option-B irreversibility** — a wrong-dim `_0p6b` needs drop + re-index; verify
   `dim=1024` **live** before any backfill.
4. **Syncer footgun** — the background syncer is a second live index entry point; if it is
   not brought under the `IndexTarget` abstraction it must be hard-disabled while the
   secondary is configured (else `_0p6b` desyncs on the first user edit).
5. **Gate-fixture realism** — search-path gates must use a hybrid+shared fixture matching the
   MVP target, else the M5 shared-arm dim-mismatch ships undetected.
6. **Live-infra coupling** — test embeds at priority 8–9, never purge shared queues, tolerate
   WAIT-class lag (shared `inference` vhost, `consumer_timeout=2h`).
