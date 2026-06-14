# Dual-Embedding (Per-Model Collection) — Implementation Plan

> **For Claude / agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let claude-context index and search a codebase with **two embedding models side by side** — the existing Qwen3-Embedding-8B (4096-dim) and a new Qwen3-Embedding-0.6B (1024-dim) — by storing each model in its **own Milvus collection** and selecting the model **explicitly per request**, so the lightweight 0.6B path stays usable when the GPU-heavy 8B path is unavailable (LLM owns the GPU).

**Architecture:** **Option B — one collection per model.** A small TypeScript model registry (SSOT) maps each canonical model id → `{queue, dimension, collectionSuffix, priorityDefault}`. The completeness ledger becomes per-`(codebase × model)` (snapshot **v2→v3**, the keystone). The inner index loop becomes per-model via an `IndexTarget` abstraction (outer Merkle scan/split runs once; each target embeds with its own `RabbitMQEmbedding` instance and upserts to its own collection). Search resolves one model per query (no cross-space merge) and routes the query embedding + collection by that model. **No GPU auto-detection** — contention is LLM-vs-8B, which this process cannot observe, so the model is set explicitly by the operator/orchestrator.

**Tech Stack:** TypeScript (Node 20–23), `amqplib`, `@zilliz/milvus2-sdk-node` (gRPC `MilvusVectorDatabase` is the active driver), Jest + ts-jest, `proper-lockfile`. Milvus v2.6.9 @ `127.0.0.1:19530`. Shared RabbitMQ `inference` vhost (queues `embedding.qwen3-8b`, `embedding.qwen3-0.6b` — **both live**).

**Design authority:** this document + the design-council verdict it encodes (rev1.0). A condensed design note will also live at `docs/lufftw/design-2026-06-14-dual-embedding.md`.

**Plan revision:** **rev1.2** (council → rev1.0 → 3-round review *ITERATE* → rev1.1 full-source body → **R4 confirmation *NEEDS-FIX*** → 4 corrections folded as rev1.2 below → **GO**). **Build target = rev1.2** — where the "rev1.2 — R4 corrections" block below conflicts with a rev1.1 phase body, the rev1.2 block wins.

---

## Elite Review Status (rev1.2 — COUNCIL → 3-ROUND ADVERSARIAL REVIEW → R4 CONFIRMATION)

**Pipeline:** 7-agent design council (5 architects + Devil's Advocate → Opus Chair: *Approve-with-revisions*, 13 locked decisions) → **3-round adversarial review** (34 agents, ~1.7M tokens): R1 = 5 lenses → dedupe → top findings each pass a **3-skeptic majority-vote refutation** (default-refute, survive on ≥2/3 "real"); R2 = ARB²-style recursive/meta (Self-Application, Runtime Simulator, `code-reviewer`, Devil's Advocate, Audit-Trail Verifier); R3 = Completeness + **Regression auditor** (do R1/R2 fixes conflict?) + Final Adversary → Opus go/no-go.

**Final verdict: ITERATE.** Findings *characterization* converged (R1 found one root cause; R2/R3 found it recurring at un-named sites) but count rose **3 → ~13 → ~20** because the plan threaded dual-embedding as additive accessors while the codebase threads a **single model identity through ~8 entangled sites**. Convergence note: *"no new root-cause classes likely in R4."* Every claim was source-verified; **zero found false**. One R2 claim **refuted** by R3 (see below). The R1→R2 fix set contained **one true regression** caught by R3 (RG-1), now resolved.

### Gate map
- **Code start (Phase 0):** ⛔ blocked until **M1–M8** are corrected with **full source** in the phase bodies (this is the `feedback_full_source_in_plans` debt the review repeatedly cited).
- **Phase-1 keystone gate:** the snapshot carry-forward round-trip — now reframed per **M1/M2/M3** (emit **v2** additively; exhaustive carry-forward at all 3 sites; **`.mjs` runner against compiled `dist`**, not `.test.ts`).
- **Confirmation pass (optional R4):** a single confirmation that M1–M8 land as an atomic, non-conflicting set (the review flagged fix-fragmentation, residual risk R1) — mirrors the `cpu-tolerant` Round-5 confirmation, not a re-derivation.

### M1–M8 — MUST-FIX BEFORE CODE (full source required in the named phase)
| ID | Site(s) | Correction |
|---|---|---|
| **M1** | `snapshot.ts:34` `isV2Format` (7 read/dispatch/merge sites), `:599` write version | **Decision: keep emitting `formatVersion:'v2'` with `filesByModel` riding additively** (uniquely preserves LD-2 byte-identical single-model AND lets the OLD dist read the file — `loadV2Format` stores info verbatim, ignores unknown keys). Read predicate becomes forward-tolerant `isV2OrLater` at the load dispatch **and** the merge-read gate (`:566`) — else once any binary emits v3 the next save **wipes the shared multi-user snapshot**. **Supersedes R1 BC-2's "bump save to v3."** Rewrite C2/C3/D1 to this policy. |
| **M2** | `mergeAndWriteSnapshot:587`, `setCodebaseIndexing:372-378`, `setCodebaseIndexed:403-411` | Carry `filesByModel` (and the coverage ratio of P4) through **all three** carry-forward sites in the keystone commit. Use an **EXHAUSTIVE carry-forward** (spread `...rest`, recompute only status/percentage/stats) — never field-by-field enumeration (RG-5). Gating test drives `saveCodebaseSnapshot` via **two** `SnapshotManager` runtimes, different modelId/codebase, re-read from disk, assert both survive (capture-and-verify share code). |
| **M3** | `packages/mcp` has **no Jest** | Author every MCP gate as a **Node ESM `.mjs` runner under `packages/mcp/scripts/`** importing compiled `dist/` (the existing convention — `scripts/snapshot-ledger.test.mjs`, registered as `test:ledger`), exit-nonzero on first failed assert, parsed-object assertions. Rewrite every `.test.ts` task → `.mjs` runner + package script. Fix audit **B3** (`pnpm test` resolves to nothing for mcp) → enumerated exact commands + exit-code checks. |
| **M4** | `index.ts:184-193` inputSchema; public `semanticSearch:515`; `getEmbedding:197`; `handlers.ts:486` | Explicit model selection is **dead on arrival** as scoped: MCP clients only send args in the ListTools schema. (a) add `embeddingModel` enum to the `search_code` inputSchema; (b) thread it through the **public** `semanticSearch` + `_semanticSearchImpl`; (c) add `getEmbeddingForModel(modelId)` and replace the two `this.embedding.embed(query)` sites (`:558,:625`); (d) handler passes the resolved model. D6/D7 run via a **real MCP ListTools+CallTool** round-trip (`scripts/jsonrpc-smoke.mjs`), not a handler call. |
| **M5** | `_semanticSearchImpl:526-532` shared-collection arm | **Most likely surviving production failure.** The shared arm (`getSharedCollectionName()` = 4096-dim `MILVUS_COLLECTION_SHARED`) is appended unconditionally; a 1024 query vs the 4096 shared space is a guaranteed dim-mismatch on the **first** 0.6B search for any hybrid/shared project — **including the MVP target** (`claude-context` = Dev-Tools group, strategy=hybrid, shared=`dev_infra_shared`). Fix: append the shared arm **only for the primary (8B) model** (`getSharedCollectionNameForModel` → undefined for 0.6B). Gate with a **hybrid+shared fixture matching the MVP target**; spy collection args; assert **zero** shared ANN calls on the 0.6B path. (LD-8 "within-model private+shared merge" is true only for 8B.) |
| **M6** | `prepareCollection:777` (only creation site) | Producer-before-consumer gap: nothing creates `_0p6b` at dim 1024. Make `prepareCollection` per-target: for each active `IndexTarget`, `hasCollection`; if missing, create with **`target.embedding.detectDimension()`** (1024) using the same hybrid/non-hybrid branch; secondary inherits the process-wide `getIsHybrid()` so `_0p6b` gets the same `sparse_vector` shape (R3-HYBRID-SPARSE) — confirm per-target upsert populates the sparse field. Full source. D5 (live `describeCollection(_0p6b)` dim=1024 COSINE) **after** this step. |
| **M7** | `processFileList:910`, `processChunkBatch:1262` (`this.embedding` at **1267 dim-guard AND 1294 embed**, `this.getCollectionName/getWritableShared` at 1364-65) | The feature's largest rewrite — ship **full source**. `processChunkBatch/processChunkBuffer` **TAKE an `IndexTarget`** and read `target.embedding` for **both** `expectedDim` (1267) **and** `embedBatchPartial` (1294) **and** `target.collectionName` for upsert. Else the entire 1024 backfill is silently zeroed as rogue-dimension REAL failures → aborts after `MAX_CONSECUTIVE_BATCH_ERRORS`. State per-target abort isolation (does an 8B abort kill the 0.6B pass?). *(RG-9: this is one atomic signature change with the dim-guard fix.)* |
| **M8** | resume-skip `context.ts:989-1035` (single-valued); `handlers.ts:430` (single 8B ledger) | Resolve resume-skip to **per-target**, overriding LD-5's "any disagreement → re-process ALL targets" (which would re-embed the entire 8B corpus through the GPU-heavy worker on every 0.6B-only backfill — defeats LD-0). Per-target `existingHashes` (`Map<modelId,…>`) + per-target `priorLedger`; AST-split once iff **any** target needs the file, embed+upsert **only** individually-disagreeing targets. Includes R2-HANDLER-PRIORLEDGER: `handlers.ts:430` builds per-target ledgers via `getFileLedgerForModel` and threads each into its `IndexTarget` (else 0.6B re-embeds fully on every MCP restart). |

### Fix-in-phase (P1–P7) and nice-to-have (N1–N4)
- **P1 (Ph2/3):** delete the residual inline writable-shared upsert at `context.ts:1379-1387` when it becomes an `IndexTarget` (RG-3 — else double-write → duplicate-PK). Gate: distinct-PK for a known chunk === 1.
- **P2 (Ph3):** bring **`_reindexByChangeImpl` (context.ts:414, live from `sync.ts:158`)** under the `IndexTarget` abstraction (per-target delete + per-model ledger) — the background syncer is a **second live entry point** that otherwise desyncs `_0p6b` on the first user edit. If deferred, **hard-disable background sync while the secondary is configured** + add a desync gate.
- **P3 (Ph3/4):** per-model `_clearIndexImpl` drop + one shared `isModelReadable(codebase,modelId)` predicate used by **both** `get_indexing_status` and `_semanticSearchImpl` (RG-6/RG-7) — status and search must never disagree.
- **P4 (Ph4/5):** implement the runtime **coverage gate** (LD-10/E2 has no implementing task): persist distinct-PK overlap ratio (riding M2's exhaustive carry-forward, RG-5), and in `_semanticSearchImpl` for 0.6B return the degraded notice **without** the ANN call when ratio < 0.85 or absent.
- **P5 (Ph6):** full source for gate harnesses (`jsonrpc-smoke.mjs` for D6; a `milvus2-sdk-node` id-scroll+Set dedup probe for E3 — v2.6.9 has no `COUNT(DISTINCT)`; snapshot-artifact diff for C1).
- **P6 (Ph0):** `EMBEDDING_DUAL_WRITE` appears nowhere in source — "wired-but-OFF" is unverifiable. Either **delete the key** (dual-write stays governed by `MILVUS_WRITABLE_SHARED`) or add a Phase-4 task that reads/branches on it with a spy test. *(Recommend: delete it for MVP; reconcile in `env-variable-reference.md`.)*
- **P7 (Ph1 docs):** pin C2/D1 fixtures to a **v2 doc with `files` populated** (a v1-migrated codebase legitimately has empty `files`, would false-fail).
- **N1:** audit A4 → exit-code gate `count('- [ ]') === 0`. **N2:** move a design-note skeleton (LD table) to Phase 0 or demote it to a Phase-6 deliverable (it's cited as authority but only created last). **N3:** add a Phase-6 task that runs the 6-copy sync from source-of-truth then asserts a single SHA256 across all 6 (audit A1 is otherwise un-run). **N4:** fold M7's dim-guard into the one `processChunkBatch(target, items)` change; D2 asserts a 0.6B batch yields 1024-length vectors with zero rogue-dim failures.

### Verified corrections to council/earlier rounds
- **Superseded:** R1 **BC-2** "bump save to v3" → **M1** keeps v2 (additive). The plan's LD-4 "v2→v3" wording is replaced everywhere by **"v2 additive + forward-tolerant read."**
- **Overridden:** LD-5 "re-process ALL targets" → **M8** per-target. LD-8 "private+shared merge preserved" → **M5** primary-only shared arm.
- **Refuted (kept as cheap smoke only):** R2's "two reply consumers on the shared vhost can cross" — each `RabbitMQEmbedding` owns a private **exclusive auto-delete** reply queue (`rabbitmq-embedding.ts:154`), so 4096/1024 replies cannot cross instances.

### Residual risks (carry into execution)
1. **Fix-fragmentation** — M1/M2/M5/M6/M7/M8/P1/P3 touch the same coupled invariants at different sites; mandate **three shared owners**: one exhaustive carry-forward spread, one `IndexTarget`-array builder (used by index+delete+clear+prepare), one `isModelReadable` predicate (used by status+search).
2. **Shared-snapshot blast radius** — a residual carry-forward miss corrupts *other users'* resume state; gating tests MUST use two runtimes.
3. **Milvus Option-B irreversibility** — a wrong-dim `_0p6b` needs drop+re-index; verify dim=1024 **live** before any backfill.
4. **Syncer MVP-defer footgun** — disabling sync trades desync for a stale primary; make the choice explicit + gated.
5. **Gate-fixture realism** — search-path gates must use a hybrid+shared fixture (else M5's bug ships undetected).
6. **Live-infra coupling** — test embeds priority 8–9, never purge shared queues, tolerate WAIT-class lag.

### rev1.2 — R4 confirmation corrections (THESE SUPERSEDE the rev1.1 phase bodies at the cited locations)

R4 (3 checkers + Opus chair, 4 agents) confirmed **30 items correctly closed** (all M1–M8 production sites + the cross-cluster seams) and returned **NEEDS-FIX** for exactly the two seams it was chartered to resolve — both self-flagged in rev1.1 as "Flagged for the confirmation pass" but never decided — plus two gate-quality majors. All four are surgical. Apply before code; then the verdict is **GO**.

**C1 (BLOCKER) — `SEARCH_EMBEDDING_MODEL` single authoritative resolution (R-C5).** rev1.1 shipped a dual-read: the handler read user-scope `process.env.SEARCH_EMBEDDING_MODEL` and always passed a non-undefined string, making the impl's project-scope `envManager.get(...)` **dead** — so a project `.env` setting was silently ignored, *breaking the user's chosen manual-per-session trigger* and the fork's project-`.env`-priority rule. **Decision (made here, this R4 IS the council): single-site, project-scoped.** In the `search_code` handler (Phase 4 / Task 4.3):
```ts
// rev1.2: pass the explicit arg or undefined; DO NOT read process.env here.
const resolvedModel =
  (typeof embeddingModel === 'string' && embeddingModel.length > 0) ? embeddingModel : undefined;
// ... semanticSearch(query, { /* ... */, embeddingModel: resolvedModel })
```
and in `_semanticSearchImpl` (the single authority, runs inside `runWithProject` so project `.env` wins):
```ts
const requestedModel =
  embeddingModel ?? envManager.get('SEARCH_EMBEDDING_MODEL') ?? DEFAULT_PRIMARY_MODEL_ID;
```
Delete the handler's `process.env.SEARCH_EMBEDDING_MODEL` read and the comment that endorsed the dual-read.

**C2 (BLOCKER) — writable-shared must be an actual `IndexTarget` (P1/RG-3 completion).** rev1.1 deleted the inline writable-shared upsert (Task 2.2) but `buildIndexTargets`' full source (Task 2.0) never got the replacement target — so as written `MILVUS_WRITABLE_SHARED` dual-write **silently stops** for maintainer projects. Amend `buildIndexTargets` full source: after the primary `push`, before the secondary block:
```ts
// rev1.2: writable-shared is a SAME-INSTANCE target (same dim as primary), NOT inline.
const ws = this.getWritableSharedCollectionName();
if (ws && ws !== primaryCollectionName) {
  targets.push({
    modelId: '__writable_shared__',                 // synthetic key; never a queryable model
    collectionName: ws,
    embedding: this.embedding,                       // same instance/dimension as primary
    isHybrid: this.getIsHybrid() === true,
    priorLedger: priorLedgersByModel?.get(DEFAULT_PRIMARY_MODEL_ID) ?? new Map(),
  });
}
```
Fix the Task 2.0 docstring to say writable-shared IS a target (not inline). The `__writable_shared__` key is invisible to `isModelReadable`/status because those enumerate **canonical model ids by name** (`qwen3-embedding-8b`/`-0.6b`) — document this explicitly. Its delete is covered by the per-target `deleteChangedForTargets` (LD-6); the P1 gate (`distinct-PK for a known writable-shared chunk === 1`) becomes the proof that the replacement target works.

**C3 (MAJOR) — M8 gate test must be full source.** `resume-skip-per-target.int.test.ts` (Task 2.3) was a comment-only skeleton; a must-fix site requires runnable source. Author it after `multi-target-index.int.test.ts`: build a Context with primary (4096) + secondary (1024); stub `queryAll` so `claude_context_own` returns prior `fileHash` H for `a.ts` but `claude_context_own_0p6b` returns nothing; pass `priorLedgersByModel` with the 8B ledger `complete` for `a.ts@H` and the 0.6B ledger empty; assert upserts go **only** to the 0.6B collection (proves NOT all-or-nothing re-embed), `onFileComplete` fires for **both** modelIds, and add the all-targets-skip case.

**C4 (MAJOR) — D7 gate must not substring-match.** `jsonrpc-smoke-dual.mjs` used `resultText.includes('not configured') || includes('secondary') || includes('model')` — the `'model'` branch is vacuously true. Make the degraded/unconfigured path return structured content `{ degraded: true, reason: 'secondary-not-configured' }` and assert `parsed.degraded === true && parsed.reason === 'secondary-not-configured'` (parsed JSON, binary-acceptance) plus the existing no-dim-mismatch stderr assertion.

**Minor reconciliations (annotate; no re-architecture):**
- **(SEAM-1/SEAM-3)** `secondaryEmbedding` ctor field (declared in Task 2.0 *and* 4.1) and `coverageByModel` type (declared in Task 1.1 *and* 4.6a) are duplicate-but-identical. Annotate Task 4.1/4.6a: **"verify-only — field already added by the earlier task; no edit."**
- **(SEAM-2/R-C4)** add one `getActiveModelIds(): string[]` helper; both `buildIndexTargets` and `getActiveModelCollectionNames` call it (strip `__writable_shared__` for the clear/status enumeration) — honors the single-enumerator mandate.
- **(M1 naming)** rename the keystone runner `snapshot-v3-roundtrip.test.mjs` → `snapshot-additive-roundtrip.test.mjs` (+ package script) and reword audit C3/D1 + LD-4 to "v2-additive (formatVersion stays literal `v2`; M1 supersedes the v2→v3 bump)". Test logic unchanged.
- **(T1)** the snapshot T1 "emit stays v2" assertion must call `saveCodebaseSnapshot()` before re-reading from disk (it currently re-reads the fixture it wrote) — or drop T1 and rely on T4 (which exercises the save path).
- **(D3/P1 gates)** expand the comment-only `per-target-delete.int.test.ts` and the P1 distinct-PK gate to runnable source; the P1 gate is the proof for C2.

**R4 convergence:** *"This is a NEEDS-FIX with a short, mechanical fix list, not a re-architecture."* With C1–C4 + the annotations folded (rev1.2), the plan is **GO for subagent execution**.

### Locked decisions (council, condensed)

| ID | Decision |
|---|---|
| **LD-0** | Contention is **LLM-vs-8B**, not 8B-vs-0.6B (both embedding workers are live simultaneously). claude-context **cannot observe** the LLM's GPU state → **no auto-detection**. Model selection is **explicit** (env default + per-call param), set by whoever owns the LLM. |
| **LD-1** | Model registry = TS module `packages/core/src/embedding/model-registry.ts`. `EmbeddingModelSpec = { id, queue, dimension, collectionSuffix, priorityDefault }`. Two entries. No `storageField` (Milvus dense field is always `vector`). No `rerankByDefault` (v1 YAGNI). `getModelSpec(id)` throws on unknown. |
| **LD-2** | Each model = a **distinct configured `RabbitMQEmbedding` instance** (per-instance dimension guard at `rabbitmq-embedding.ts:~217` forbids reusing one instance across dimensions). Secondary instance constructed **only when configured**; otherwise the single-model path is **byte-identical** to today. |
| **LD-3** | A real **model→collection resolver** threaded through ~5 call sites — NOT "free reuse of multi-collection machinery". Suffix from registry; `MILVUS_COLLECTION_PRIVATE_0P6B` overrides verbatim. **Secondary suffix = `_0p6b`** (`claude_context_own` → `claude_context_own_0p6b`). |
| **LD-4** | **KEYSTONE.** Snapshot **v2→v3**: add optional `filesByModel?: Record<modelId, Record<relPath, FileCompleteness>>`; preserve top-level `files` as the literal 8B ledger. Keyed by **model id** (stable), not collection name (env-mutable). A tested v2→v3 round-trip **gates the whole feature**. |
| **LD-5** | Inner index loop → per-model via `IndexTarget { modelId, collectionName, embedding, isHybrid, getPriorLedger(), onFileComplete() }`. Outer Merkle/scan/split runs **once**. Resume-skip fires only when **every** active target agrees `complete:true` at the same hash. |
| **LD-6** | Delete-on-change scoped **per target**; a target delete failure sets that file `complete:false` in **that target's** ledger (pair every abort with recovery). Remove the monolithic private+writable-shared delete. |
| **LD-7** | PK generation **unchanged** (`generateId(path,start,end,content)`, model-blind). Same chunk → same PK in both collections; upsert idempotency holds per-collection. |
| **LD-8** | Search: optional `embeddingModel` param on `search_code` (`qwen3-embedding-8b` default \| `qwen3-embedding-0.6b`) + `SEARCH_EMBEDDING_MODEL` env default + hard fallback 8B. **One model per query** (no cross-space RRF). Within-model private+shared merge preserved. Requested-but-unconfigured collection → clear notice, never wrong-dim search. |
| **LD-9** | Backfill source by collection type: **(A) filesystem re-chunk** for private collections with a local checkout (MVP); **(B) mirror-from-8B** only for scattered-source shared collections (Phase 2, gated on dedup). Backfill embeds at registry `priorityDefault` (=1). `EMBEDDING_DUAL_WRITE` **wired-but-OFF** in MVP. |
| **LD-10** | **MVP scope gate:** prove end-to-end on `claude_context_own` (~2,283 rows / 9MB) **only**. `event_shared` (9.3GB), mirror-backfill, live dual-write = **Phase 2**. NASA gates G1–G4. Below G3 coverage the 0.6B collection is **not readable** (explicit degraded notice, never silent partial). |
| **LD-11** | Duplicate-PK **dedup/compaction of the 8B source** is a **prerequisite** for the coverage gate (G3) and mirror-backfill. MVP: assess+compact `claude_context_own` before snapshotting distinct-PK ground truth. Backend (milvus-services) op; this plan owns the sequencing. |
| **LD-12** | Long backfill flushes the ledger **coarsely** (≥30s or per-N-files), not the interactive 2s tick, to avoid starving the **shared** snapshot lock. MVP small run unaffected; knob is a Phase-2 prerequisite. |

### User decisions (resolved 2026-06-14)
- Secondary suffix: **`_0p6b`**.
- Model trigger: **manual per-session** (`SEARCH_EMBEDDING_MODEL` in project `.env` + MCP restart). LD-0 premise **confirmed**.
- Dedup: **run on `claude_context_own` as part of MVP**.
- `EMBEDDING_DUAL_WRITE`: **wired-but-OFF**.

---

## Plan & Version Control Policy

This plan MUST exist as **synchronized copies** across every repo it touches, kept in lock-step. Any change to one copy is immediately mirrored to all others (same content, same filename `2026-06-14-dual-embedding.md`). The version-controlled formal copy in `claude-context` is the **source of truth**.

### Synchronized plan copies

| Repo / role | Workspace working copy | Formal docs copy (version-controlled) |
|---|---|---|
| **claude-context** — implementation target (code) | `E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-14-dual-embedding.md` | `E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-14-dual-embedding.md` *(source of truth)* |
| **milvus-services** — backend canonical docs | `E:\Developer\lufftw\repo\milvus-services-workspace\docs\plan\2026-06-14-dual-embedding.md` | `E:\Developer\lufftw\repo\milvus-services\docs\plan\2026-06-14-dual-embedding.md` |
| **mcp-services** — consumer usage docs | `E:\Developer\lufftw\repo\mcp-services-workspace\docs\plan\2026-06-14-dual-embedding.md` | `E:\Developer\lufftw\repo\mcp-services\docs\plan\2026-06-14-dual-embedding.md` |

### Repos under version control for this plan

| Repo | Role | docs/plan obligation | Deliverables |
|---|---|---|---|
| `E:\Developer\lufftw\repo\claude-context` | **Implementation** — all code lands here | Keep `docs/plan` aligned with implementation | core + mcp code (Phases 0–6); `docs/lufftw/design-2026-06-14-dual-embedding.md` |
| `E:\Developer\lufftw\repo\milvus-services` | **Backend reference** | Keep `docs/plan` aligned with the registry/env/collection changes | `docs/claude-context/`: `project-registry.md` (0.6B collection rows), `env-variable-reference.md` (new keys), `collection-strategies.md` (per-model collection), `onboarding-checklist.md` (enable 0.6B) |
| `E:\Developer\lufftw\repo\mcp-services` | **Consumer docs** | Keep `docs/plan` aligned with the user-facing usage | `docs/claude-context/usage-guide.md`: how to enable + select the 0.6B model |

### Cross-project note (why only these three)

The design was synthesized by **studying** the sibling services `event-search-service` and `poi-data-layer` (registry pattern) as **read-only references** — no code is modified in them, so they receive **no** plan copy. The 0.6B GPU worker / `embedding.qwen3-0.6b` queue is **already live** (verified: 2 consumers on the `inference` vhost), so **no worker-repo change** is in scope; if a future phase needs a worker-side change (e.g. priority/queue arg), that repo is added to the table above with its own synchronized copy at that time.

### Sync rule (operational)

After editing the source-of-truth copy, mirror to all others:

```powershell
$src = "E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-14-dual-embedding.md"
foreach ($dst in @(
  "E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\milvus-services\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\milvus-services-workspace\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\mcp-services\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\mcp-services-workspace\docs\plan\2026-06-14-dual-embedding.md"
)) { New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item -Force $src $dst }
```

---

## Plan Completion Audit Checklist

Run this when the plan (or a phase) is declared complete. Every item must be **externally verifiable** — a command, an artifact, or a diff — not a subjective assertion. No item passes on "looks done." (Per `feedback_binary_acceptance`: gates need exit code + stderr + mtime/SHA256 + diff shape; substring matching forbidden.)

### A. Artifact & version-control integrity
- [ ] **A1** All 6 plan copies exist and are byte-identical. Verify: `Get-FileHash` on every path returns the same SHA256.
- [ ] **A2** The formal copy is committed in each of the 3 repos. Verify: `git log --oneline -- docs/plan/2026-06-14-dual-embedding.md` shows a commit in `claude-context`, `milvus-services`, `mcp-services`.
- [ ] **A3** The design note `docs/lufftw/design-2026-06-14-dual-embedding.md` exists and is committed in `claude-context`.
- [ ] **A4** Every phase's tasks are checked off in the source-of-truth copy.

### B. Build & static gates
- [ ] **B1** `pnpm typecheck` exits 0 (cross-package).
- [ ] **B2** `pnpm build:core && pnpm build:mcp` exit 0; `node packages/mcp/dist/index.js --help` loads without writing to stdout (JSON-RPC sanctity).
- [ ] **B3** `pnpm test` (unit/hermetic) exits 0; new tests included in the run (assert test count increased vs baseline).

### C. Backward-compatibility (single-model users unaffected)
- [ ] **C1** With **no** secondary configured, a re-index of a fixture produces a byte-identical write path (no secondary collection created, no `filesByModel` written). Verify: diff of upsert payloads / collection list before vs after.
- [ ] **C2** A **v2** snapshot loads under the new binary and `getFileLedgerForModel(path,'qwen3-embedding-8b')` returns the SAME entries as the legacy `files`. Dynamic test, asserted on parsed objects (not substring).
- [ ] **C3** The **old** binary can load a **v3** snapshot without crashing (forward-compat). Verify by loading a v3 fixture with the prior `dist`.

### D. Feature correctness (dynamic verification — `feedback_dynamic_over_static_verification`)
- [ ] **D1** Snapshot v2→v3 round-trip test passes (LD-4 gate). Asserts: 8B ledger preserved; 0.6B ledger empty on first load.
- [ ] **D2** Multi-target index integration test: both `claude_context_own` and `claude_context_own_0p6b` receive **every** chunk; each model's ledger reflects only its own completions; resume-skip requires unanimous target agreement at the same hash.
- [ ] **D3** Asymmetric-delete test: 8B delete OK + 0.6B delete throws → 0.6B ledger marked `complete:false` (not silently complete). (LD-6)
- [ ] **D4** Live G1 worker round-trip: a priority-8 (test) embed on `embedding.qwen3-0.6b` returns a vector whose length **=== 1024** (assert by parsing JSON, never substring). L2 norm ∈ (0.5, 2.0).
- [ ] **D5** Live G2 schema: `describeCollection(claude_context_own_0p6b)` shows vector `dim=1024`, metric `COSINE`. Assert parsed fields.
- [ ] **D6** Search routing: `search_code(..., embeddingModel='qwen3-embedding-0.6b')` embeds via the 0.6B instance and queries the `_0p6b` collection (assert stderr trace shows queue `embedding.qwen3-0.6b` + dim 1024); the 8B default path is unchanged.
- [ ] **D7** Requested-but-unconfigured model → clear "secondary collection not configured" result, **never** a wrong-dim ANN call (assert no 4096-query-vs-1024-field error).

### E. Coverage & rollout gates (NASA go/no-go)
- [ ] **E1** G3 coverage measured as **distinct-PK overlap** (not raw count) between `claude_context_own` and `claude_context_own_0p6b`, recorded as a number; ≥85% before the 0.6B collection is marked readable.
- [ ] **E2** Below-threshold behavior verified: search with 0.6B requested while coverage <85% returns an **explicit degraded notice** (or stays on 8B), never silent partial results.
- [ ] **E3** Dedup (LD-11): `claude_context_own` duplicate-PK count assessed and (if present) compacted before E1 is measured; record the before/after distinct-PK counts.
- [ ] **E4** G4 default flip is config-only: set `SEARCH_EMBEDDING_MODEL=qwen3-embedding-0.6b`, restart MCP, verify stderr shows `dim=1024` / `queue=embedding.qwen3-0.6b`.

### F. Documentation sync
- [ ] **F1** `milvus-services/docs/claude-context/`: `project-registry.md`, `env-variable-reference.md`, `collection-strategies.md`, `onboarding-checklist.md` updated for the 0.6B model/queue/collection + env keys; committed.
- [ ] **F2** `mcp-services/docs/claude-context/usage-guide.md` updated (enable + select 0.6B; operator owns model selection per LD-0); committed.
- [ ] **F3** `claude-context/CLAUDE.md` "Embedding Provider Matrix" / fork-deviations updated to mention dual-model collections; committed.

---

---

## Phases

> Producer-before-consumer ordering. Each phase ends green under `pnpm typecheck && pnpm build:core && pnpm build:mcp`. Use `superpowers:test-driven-development` for every task; commit per task. **rev1.1 build target.** Bodies below are full-source, authored against verified source anchors (read 2026-06-14) by 4 parallel review-driven cluster agents and reconciled here.
>
> **Cross-cluster ordering:** Phase 0 (registry/config) must land and `pnpm build:core` be green **before** Phase 1; Phase 1 (snapshot keystone, M1/M2/M3) is the gate for Phases 2–6.
>
> **Three shared owners (residual-risk R1 — prevents fix-fragmentation):** (1) ONE exhaustive carry-forward spread (Phase 1); (2) ONE `buildIndexTargets()` / `IndexTarget` array consumed by index + delete + clear + prepare (Phase 2); (3) ONE `isModelReadable()` predicate consumed by status + search (Phase 4).

---

# Cluster D — Phase 0 (Registry + Config) and Phase 6 (Gate Harnesses)

## Verified source anchors (all read before writing)

- `packages/mcp/src/config.ts`: `ContextMcpConfig` interface ends at line 33; RabbitMQ block lines 168–203; `createMcpConfig` returns at line 206.
- `packages/mcp/src/embedding.ts`: `createEmbeddingInstance` factory lines 5–102; `logEmbeddingProviderInfo` lines 104–129. All `console.log` calls in this file are a stdout correctness bug (see Phase 4.1 note).
- `packages/core/src/embedding/index.ts`: 8 lines, all `export *` re-exports; no `model-registry` export yet.
- `packages/mcp/package.json`: `scripts.test:ledger` = `pnpm build && node scripts/snapshot-ledger.test.mjs`; no other test script; `pnpm test` resolves to nothing for the mcp package.
- `packages/core/jest.config.js`: `roots: ['<rootDir>/src']`; `testMatch: ['**/__tests__/**/*.test.ts']`.
- `packages/mcp/scripts/`: 8 `.mjs` files exist: `baseline-capture.mjs`, `feature-regression.mjs`, `jsonrpc-smoke.mjs`, `locking-coexistence.mjs`, `probe-rabbitmq-worker.mjs`, `snapshot-smoke.mjs`, `sync-lock-e2e.mjs`, `snapshot-ledger.test.mjs`.
- `packages/mcp/scripts/jsonrpc-smoke.mjs`: existing smoke — spawns `dist/index.js`, sends initialize + tools/list, checks superset + forbidden prefix. Does NOT yet assert `embeddingModel` enum on `search_code` or make a `tools/call`.
- `packages/mcp/scripts/probe-rabbitmq-worker.mjs`: existing 8B probe — imports `packages/core/dist/embedding/rabbitmq-embedding.js`, constructs `RabbitMQEmbedding({url,queue,modelName,dimension:4096})`, calls `embedBatch(['test'])`, asserts `vec.length===4096` and norm in `[0.99,1.01]`.
- `packages/core/src/vectordb/milvus-vectordb.ts`: `queryAll` at line 519 uses `queryIterator` with keyset pagination. `getCollectionRowCount` at line 963 uses `count(*)`. `describeCollection` called at lines 301 and 851 — returns `result.schema.fields[]` with `{name,params:[{key:'dim',value:'<n>'}],data_type}`.
- `EMBEDDING_DUAL_WRITE`: confirmed **absent from all source files** — only appears in `docs/plan/2026-06-14-dual-embedding.md`. Safe to omit entirely.
- `RABBITMQ_SECONDARY_*`, `MILVUS_COLLECTION_PRIVATE_0P6B`, `SEARCH_EMBEDDING_MODEL`: confirmed absent from source. All are new keys.

---

## P6 Decision: Delete `EMBEDDING_DUAL_WRITE` from the plan

`EMBEDDING_DUAL_WRITE` appears in zero source files. "Wired-but-OFF" cannot be verified by any gate because there is no code to read the key. Per the plan's P6 finding:

**Decision (Phase 0, executed before any other phase):** `EMBEDDING_DUAL_WRITE` is **removed from the MVP implementation**. It will not appear in `ContextMcpConfig`, in `createMcpConfig`, in any test, or in any env-variable-reference doc section for this release. Dual-write (concurrent 8B+0.6B on every live index call) remains governed exclusively by `MILVUS_WRITABLE_SHARED` (the existing mechanism), which is already tested and deployed. The out-of-scope section of the plan already states "Live `EMBEDDING_DUAL_WRITE` path — wired-but-OFF; deferred." This phase seals that deferral by making it structurally absent rather than a documented dead branch.

`milvus-services/docs/claude-context/env-variable-reference.md` must be updated in Phase 6 to mark `EMBEDDING_DUAL_WRITE` as **deferred / not in v0.1.4-lufftw.4** — the docs task (F1) owns this correction.

---

## Phase 0 — Model Registry + Config Plumbing

### Task 0.1: Create `packages/core/src/embedding/model-registry.ts` (FULL SOURCE)

**Files:**
- Create: `packages/core/src/embedding/model-registry.ts`
- Create: `packages/core/src/embedding/__tests__/model-registry.test.ts`
- Modify: `packages/core/src/embedding/index.ts` (add one export line)

#### Step 1 — Write the failing test

File: `packages/core/src/embedding/__tests__/model-registry.test.ts`

```typescript
// packages/core/src/embedding/__tests__/model-registry.test.ts
import {
  EMBEDDING_MODEL_REGISTRY,
  getModelSpec,
  isCanonicalModelId,
  DEFAULT_PRIMARY_MODEL_ID,
  type EmbeddingModelSpec,
  type CanonicalModelId,
} from '../model-registry';

describe('model-registry', () => {
  it('has exactly the two canonical entries with correct sorted keys', () => {
    expect(Object.keys(EMBEDDING_MODEL_REGISTRY).sort()).toEqual([
      'qwen3-embedding-0.6b',
      'qwen3-embedding-8b',
    ]);
  });

  it('primary spec (qwen3-embedding-8b) has correct invariants', () => {
    const spec = getModelSpec('qwen3-embedding-8b');
    expect(spec).toMatchObject<Partial<EmbeddingModelSpec>>({
      id: 'qwen3-embedding-8b',
      queue: 'embedding.qwen3-8b',
      dimension: 4096,
      collectionSuffix: '',
      priorityDefault: 10,
    });
  });

  it('secondary spec (qwen3-embedding-0.6b) has correct invariants', () => {
    const spec = getModelSpec('qwen3-embedding-0.6b');
    expect(spec).toMatchObject<Partial<EmbeddingModelSpec>>({
      id: 'qwen3-embedding-0.6b',
      queue: 'embedding.qwen3-0.6b',
      dimension: 1024,
      collectionSuffix: '_0p6b',
      priorityDefault: 1,
    });
  });

  it('throws on unknown model id (message matches /unknown embedding model/i)', () => {
    expect(() => getModelSpec('gpt-4' as CanonicalModelId)).toThrow(
      /unknown embedding model/i,
    );
    // Error message must include the bad id and list known ids.
    expect(() => getModelSpec('bad' as CanonicalModelId)).toThrow('bad');
    expect(() => getModelSpec('bad' as CanonicalModelId)).toThrow(
      'qwen3-embedding-8b',
    );
  });

  it('DEFAULT_PRIMARY_MODEL_ID is qwen3-embedding-8b and its suffix is empty string', () => {
    expect(DEFAULT_PRIMARY_MODEL_ID).toBe('qwen3-embedding-8b');
    expect(getModelSpec(DEFAULT_PRIMARY_MODEL_ID).collectionSuffix).toBe('');
  });

  it('isCanonicalModelId returns true for known ids, false for unknown', () => {
    expect(isCanonicalModelId('qwen3-embedding-8b')).toBe(true);
    expect(isCanonicalModelId('qwen3-embedding-0.6b')).toBe(true);
    expect(isCanonicalModelId('gpt-4')).toBe(false);
    expect(isCanonicalModelId('')).toBe(false);
  });

  it('getModelSpec returns a frozen-like object — same reference on repeated calls (registry is module-level const)', () => {
    // Two calls with the same id must return the same object reference (registry entries are not copied).
    expect(getModelSpec('qwen3-embedding-8b')).toBe(getModelSpec('qwen3-embedding-8b'));
  });
});
```

#### Step 2 — Run, expect FAIL (module not found)

```
pnpm --filter @zilliz/claude-context-core test -- --testPathPattern=model-registry
```

Expected: `Cannot find module '../model-registry'` (or equivalent).

#### Step 3 — Implement (FULL SOURCE)

File: `packages/core/src/embedding/model-registry.ts`

```typescript
// packages/core/src/embedding/model-registry.ts
//
// SINGLE SOURCE OF TRUTH for dual-embedding model identity (Option B: one Milvus collection
// per model). Keyed by CANONICAL model id, which is stable across renames of env vars or
// collection names. Collection names are env-mutable and must NOT be used as ledger keys.
//
// Design authority: docs/plan/2026-06-14-dual-embedding.md (LD-1).

/**
 * The two canonical model ids for this fork. These strings are used as ledger keys
 * in the snapshot (filesByModel), so they must be stable. Never change them once data exists.
 */
export type CanonicalModelId = 'qwen3-embedding-8b' | 'qwen3-embedding-0.6b';

/**
 * Spec for one embedding model in this fork's dual-embedding architecture.
 * All fields are required — no optional fields so consumers cannot silently miss one.
 */
export interface EmbeddingModelSpec {
  /** Canonical model id; also the per-model ledger key in CodebaseSnapshotV2.filesByModel. */
  readonly id: CanonicalModelId;
  /** RabbitMQ queue this model's worker consumes on the `inference` vhost. */
  readonly queue: string;
  /** Vector dimension the worker emits. Also the Milvus collection dimension. */
  readonly dimension: number;
  /**
   * Suffix appended to the base private collection name for this model.
   * '' (empty string) = primary — path is byte-identical to single-model behavior.
   * '_0p6b' = secondary.
   */
  readonly collectionSuffix: string;
  /**
   * Default RabbitMQ publish priority for writes driven by this model.
   * Primary (8B): 10 — interactive, jump enrichment queues.
   * Secondary (0.6B): 1 — background backfill, yield to everything.
   */
  readonly priorityDefault: number;
}

/** The primary model id. This is the default when no model is specified. */
export const DEFAULT_PRIMARY_MODEL_ID: CanonicalModelId = 'qwen3-embedding-8b';

/**
 * Registry of all supported embedding models.
 * Add entries here when onboarding a new model — never inline the values elsewhere.
 *
 * Invariant: the entry whose collectionSuffix === '' is the PRIMARY model and
 * its id must equal DEFAULT_PRIMARY_MODEL_ID.
 */
export const EMBEDDING_MODEL_REGISTRY: Readonly<Record<CanonicalModelId, EmbeddingModelSpec>> = {
  'qwen3-embedding-8b': {
    id: 'qwen3-embedding-8b',
    queue: 'embedding.qwen3-8b',
    dimension: 4096,
    collectionSuffix: '',
    priorityDefault: 10,
  },
  'qwen3-embedding-0.6b': {
    id: 'qwen3-embedding-0.6b',
    queue: 'embedding.qwen3-0.6b',
    dimension: 1024,
    collectionSuffix: '_0p6b',
    priorityDefault: 1,
  },
} as const;

/**
 * Look up the spec for a model id.
 * Throws a descriptive error on unknown ids — never returns undefined — so callers
 * get a hard failure at configuration time rather than a silent wrong-dim search.
 */
export function getModelSpec(id: string): EmbeddingModelSpec {
  const spec = (EMBEDDING_MODEL_REGISTRY as Record<string, EmbeddingModelSpec>)[id];
  if (!spec) {
    const known = Object.keys(EMBEDDING_MODEL_REGISTRY).join(', ');
    throw new Error(
      `unknown embedding model id: '${id}' (known: ${known})`,
    );
  }
  return spec;
}

/**
 * Type guard: returns true iff `id` is a known CanonicalModelId.
 * Use this before calling getModelSpec when the input is untrusted (e.g. env var).
 */
export function isCanonicalModelId(id: string): id is CanonicalModelId {
  return Object.prototype.hasOwnProperty.call(EMBEDDING_MODEL_REGISTRY, id);
}
```

#### Step 4 — Wire export into `packages/core/src/embedding/index.ts`

Current file (lines 1–8):
```typescript
// Export base classes and interfaces
export * from './base-embedding';

// Implementation class exports
export * from './openai-embedding';
export * from './voyageai-embedding';
export * from './ollama-embedding';
export * from './gemini-embedding';
export * from './rabbitmq-embedding';
```

Add one line at the bottom:
```typescript
export * from './model-registry';
```

Full replacement file (`packages/core/src/embedding/index.ts`):
```typescript
// Export base classes and interfaces
export * from './base-embedding';

// Implementation class exports
export * from './openai-embedding';
export * from './voyageai-embedding';
export * from './ollama-embedding';
export * from './gemini-embedding';
export * from './rabbitmq-embedding';

// Dual-embedding model registry (LD-1)
export * from './model-registry';
```

#### Step 5 — Run, expect PASS

```
pnpm --filter @zilliz/claude-context-core test -- --testPathPattern=model-registry
```

All 7 assertions green.

#### Step 6 — Typecheck

```
pnpm typecheck
```

Exit 0.

#### Step 7 — Commit

```
feat(core): model registry SSOT for dual embedding (LD-1)
```

---

### Task 0.2: Add MCP config keys for the secondary embedding path

**Files:**
- Modify: `packages/mcp/src/config.ts`
- Create: `packages/mcp/src/__tests__/config-dual.test.ts` (NOTE: the mcp package has no jest — this is an exception because config.ts is pure logic with no dist dependency; however the convention is `.mjs` against dist for MCP. Given that `config.ts` is importable as a TS module in a core jest context, the test is better placed as a gate .mjs against dist. See the gate runner `dual-config-smoke.mjs` below in Phase 6. The config types test is a COMPILE-TIME check — `pnpm typecheck` is the gate.)

**`EMBEDDING_DUAL_WRITE` is NOT added.** (See P6 decision above.)

**New keys (all optional — absence = single-model byte-identical path):**

| Env var | Config field | Type | Default | Activation |
|---|---|---|---|---|
| `RABBITMQ_SECONDARY_QUEUE` | `rabbitmqSecondaryQueue` | `string \| undefined` | `undefined` | No |
| `RABBITMQ_SECONDARY_DIMENSION` | `rabbitmqSecondaryDimension` | `number \| undefined` | `undefined` | No |
| `RABBITMQ_SECONDARY_MODEL` | `rabbitmqSecondaryModel` | `string \| undefined` | `undefined` | No |
| `MILVUS_COLLECTION_PRIVATE_0P6B` | `milvusCollectionPrivate0p6b` | `string \| undefined` | `undefined` | **YES — activation signal** |
| `SEARCH_EMBEDDING_MODEL` | `searchEmbeddingModel` | `string` | `'qwen3-embedding-8b'` | N/A |

**Activation rule:** the secondary embedding instance is constructed **if and only if** `milvusCollectionPrivate0p6b` is set (truthy). If absent, `createSecondaryEmbeddingInstance` returns `undefined` and no `_0p6b` collection is touched.

#### Current `ContextMcpConfig` interface (lines 3–33 of `packages/mcp/src/config.ts`) — verified exact text:

```typescript
export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'RabbitMQ';
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    // RabbitMQ inference-queue configuration
    rabbitmqUrl?: string;
    rabbitmqQueue?: string;
    rabbitmqDimension?: number;
    rabbitmqTimeoutMs?: number;
    rabbitmqMaxRetries?: number;
    rabbitmqPriority?: number;
    rabbitmqConcurrency?: number;
    rabbitmqSource?: string;
    // Vector database configuration
    milvusAddress?: string; // Optional, can be auto-resolved from token
    milvusToken?: string;
}
```

#### Full corrected `ContextMcpConfig` interface (replace the existing block):

```typescript
export interface ContextMcpConfig {
    name: string;
    version: string;
    // Embedding provider configuration
    embeddingProvider: 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'RabbitMQ';
    embeddingModel: string;
    // Provider-specific API keys
    openaiApiKey?: string;
    openaiBaseUrl?: string;
    voyageaiApiKey?: string;
    geminiApiKey?: string;
    geminiBaseUrl?: string;
    // OpenRouter configuration
    openrouterApiKey?: string;
    // Ollama configuration
    ollamaModel?: string;
    ollamaHost?: string;
    ollamaDimension?: number;
    // RabbitMQ primary inference-queue configuration
    rabbitmqUrl?: string;
    rabbitmqQueue?: string;
    rabbitmqDimension?: number;
    rabbitmqTimeoutMs?: number;
    rabbitmqMaxRetries?: number;
    rabbitmqPriority?: number;
    rabbitmqConcurrency?: number;
    rabbitmqSource?: string;
    // RabbitMQ secondary (0.6B) configuration — all undefined = secondary disabled.
    // Activation signal: milvusCollectionPrivate0p6b must be truthy to enable secondary.
    rabbitmqSecondaryQueue?: string;       // RABBITMQ_SECONDARY_QUEUE; default from registry if activated
    rabbitmqSecondaryDimension?: number;   // RABBITMQ_SECONDARY_DIMENSION; default 1024 if activated
    rabbitmqSecondaryModel?: string;       // RABBITMQ_SECONDARY_MODEL; default 'qwen3-embedding-0.6b' if activated
    // Dual-embedding Milvus configuration
    milvusCollectionPrivate0p6b?: string; // MILVUS_COLLECTION_PRIVATE_0P6B — ACTIVATION SIGNAL; absent = secondary OFF
    // Search configuration
    searchEmbeddingModel: string;          // SEARCH_EMBEDDING_MODEL; default 'qwen3-embedding-8b'
    // Vector database configuration
    milvusAddress?: string; // Optional, can be auto-resolved from token
    milvusToken?: string;
}
```

#### Corrected `createMcpConfig` function — full replacement of the function body

The current function body (lines 156–207) adds the new keys after the existing `rabbitmqSource` and before `milvusAddress`. Exact replacement follows:

```typescript
export function createMcpConfig(): ContextMcpConfig {
    // Debug: Print all environment variables related to Context
    console.error(`[DEBUG] Environment Variables Debug:`);
    console.error(`[DEBUG]   EMBEDDING_PROVIDER: ${envManager.get('EMBEDDING_PROVIDER') || 'NOT SET'}`);
    console.error(`[DEBUG]   EMBEDDING_MODEL: ${envManager.get('EMBEDDING_MODEL') || 'NOT SET'}`);
    console.error(`[DEBUG]   EMBEDDING_DIMENSION: ${envManager.get('EMBEDDING_DIMENSION') || 'NOT SET'}`);
    console.error(`[DEBUG]   OLLAMA_MODEL: ${envManager.get('OLLAMA_MODEL') || 'NOT SET'}`);
    console.error(`[DEBUG]   GEMINI_API_KEY: ${envManager.get('GEMINI_API_KEY') ? 'SET (length: ' + envManager.get('GEMINI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.error(`[DEBUG]   OPENAI_API_KEY: ${envManager.get('OPENAI_API_KEY') ? 'SET (length: ' + envManager.get('OPENAI_API_KEY')!.length + ')' : 'NOT SET'}`);
    console.error(`[DEBUG]   MILVUS_ADDRESS: ${envManager.get('MILVUS_ADDRESS') || 'NOT SET'}`);
    console.error(`[DEBUG]   NODE_ENV: ${envManager.get('NODE_ENV') || 'NOT SET'}`);
    console.error(`[DEBUG]   MILVUS_COLLECTION_PRIVATE_0P6B: ${envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B') || 'NOT SET (secondary OFF)'}`);
    console.error(`[DEBUG]   SEARCH_EMBEDDING_MODEL: ${envManager.get('SEARCH_EMBEDDING_MODEL') || 'NOT SET (default: qwen3-embedding-8b)'}`);

    const rabbitmqDim = envManager.get('RABBITMQ_EMBEDDING_DIMENSION');
    const rabbitmqTimeout = envManager.get('RABBITMQ_EMBEDDING_TIMEOUT_MS');
    const rabbitmqMaxRetries = envManager.get('RABBITMQ_EMBEDDING_MAX_RETRIES');
    const rabbitmqPriority = envManager.get('RABBITMQ_EMBEDDING_PRIORITY');
    const rabbitmqConcurrency = envManager.get('RABBITMQ_EMBEDDING_CONCURRENCY');

    // Secondary RabbitMQ dimension — parse only if present
    const rabbitmqSecDimRaw = envManager.get('RABBITMQ_SECONDARY_DIMENSION');
    const rabbitmqSecondaryDimension = rabbitmqSecDimRaw
        ? parseInt(rabbitmqSecDimRaw, 10)
        : undefined;

    // Validate SEARCH_EMBEDDING_MODEL against the registry if set
    const searchEmbeddingModelRaw = envManager.get('SEARCH_EMBEDDING_MODEL');
    // Import inline to avoid top-level circular risk; the registry is pure data.
    // We defer the throw to the consumer (Phase 4 factory) so startup does not crash
    // if the key is mistyped — a startup-time stderr warning is emitted instead.
    const searchEmbeddingModel = searchEmbeddingModelRaw || 'qwen3-embedding-8b';

    const config: ContextMcpConfig = {
        name: envManager.get('MCP_SERVER_NAME') || "Context MCP Server",
        version: envManager.get('MCP_SERVER_VERSION') || "1.0.0",
        // Embedding provider configuration
        embeddingProvider: (envManager.get('EMBEDDING_PROVIDER') as 'OpenAI' | 'VoyageAI' | 'Gemini' | 'Ollama' | 'OpenRouter' | 'RabbitMQ') || 'OpenAI',
        embeddingModel: getEmbeddingModelForProvider(envManager.get('EMBEDDING_PROVIDER') || 'OpenAI'),
        // Provider-specific API keys
        openaiApiKey: envManager.get('OPENAI_API_KEY'),
        openaiBaseUrl: envManager.get('OPENAI_BASE_URL'),
        voyageaiApiKey: envManager.get('VOYAGEAI_API_KEY'),
        geminiApiKey: envManager.get('GEMINI_API_KEY'),
        geminiBaseUrl: envManager.get('GEMINI_BASE_URL'),
        // OpenRouter configuration
        openrouterApiKey: envManager.get('OPENROUTER_API_KEY'),
        // Ollama configuration
        ollamaModel: envManager.get('OLLAMA_MODEL'),
        ollamaHost: envManager.get('OLLAMA_HOST'),
        ollamaDimension: getPositiveIntegerFromEnv('EMBEDDING_DIMENSION'),
        // RabbitMQ primary configuration
        rabbitmqUrl: envManager.get('RABBITMQ_INFERENCE_URL'),
        rabbitmqQueue: envManager.get('RABBITMQ_EMBEDDING_QUEUE'),
        rabbitmqDimension: rabbitmqDim ? parseInt(rabbitmqDim, 10) : undefined,
        rabbitmqTimeoutMs: rabbitmqTimeout ? parseInt(rabbitmqTimeout, 10) : undefined,
        rabbitmqMaxRetries: rabbitmqMaxRetries ? parseInt(rabbitmqMaxRetries, 10) : undefined,
        rabbitmqPriority: rabbitmqPriority ? parseInt(rabbitmqPriority, 10) : undefined,
        rabbitmqConcurrency: rabbitmqConcurrency ? parseInt(rabbitmqConcurrency, 10) : undefined,
        rabbitmqSource: envManager.get('RABBITMQ_EMBEDDING_SOURCE'),
        // RabbitMQ secondary (0.6B) configuration — undefined when not activated
        rabbitmqSecondaryQueue: envManager.get('RABBITMQ_SECONDARY_QUEUE'),
        rabbitmqSecondaryDimension,
        rabbitmqSecondaryModel: envManager.get('RABBITMQ_SECONDARY_MODEL'),
        // Dual-embedding Milvus — milvusCollectionPrivate0p6b presence = activation signal
        milvusCollectionPrivate0p6b: envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B'),
        // Search configuration
        searchEmbeddingModel,
        // Vector database configuration
        milvusAddress: envManager.get('MILVUS_ADDRESS'),
        milvusToken: envManager.get('MILVUS_TOKEN'),
    };

    return config;
}
```

**IMPORTANT NOTE — stdout bug fixed:** The original `createMcpConfig` uses `console.log` for all debug output. `console.log` writes to stdout, which is the JSON-RPC stream; this is a pre-existing bug. The replacement above changes all debug logging in `createMcpConfig` to `console.error`. The same fix applies to `logConfigurationSummary` (lines 209+) — that function also uses `console.log` and must be changed to `console.error` as part of this task, since it is called at startup before any JSON-RPC response can filter stdout noise. Full `logConfigurationSummary` correction is included in the Phase 4.1 task (which wires the startup log) to keep this task scoped to config parsing.

#### Step — Typecheck (this task has no jest test; typecheck is the compile-time gate)

```
pnpm typecheck
```

Exit 0. The new fields are optional (`?`) so no downstream callers break.

#### Step — Commit

```
feat(mcp): dual-embedding config keys (secondary OFF by default, no EMBEDDING_DUAL_WRITE) (LD-2,P6)
```

---

### Task 4.1 (Phase 4, authored here for completeness of cluster D): Construct secondary `RabbitMQEmbedding` instance + startup stderr log

**Charter note:** The charter assigns Phase 4.1 to Cluster D. This is the factory + wiring for the secondary instance.

**Files:**
- Modify: `packages/mcp/src/embedding.ts` (add `createSecondaryEmbeddingInstance`)
- Wherever `Context` is constructed in `packages/mcp/src/index.ts` (the wiring)

#### Current `createEmbeddingInstance` signature (line 5, verified):
```typescript
export function createEmbeddingInstance(config: ContextMcpConfig): OpenAIEmbedding | VoyageAIEmbedding | GeminiEmbedding | OllamaEmbedding | RabbitMQEmbedding {
```

#### New function to add at the end of `packages/mcp/src/embedding.ts` (FULL SOURCE of the addition):

```typescript
// packages/mcp/src/embedding.ts — addition after logEmbeddingProviderInfo

import { RabbitMQEmbeddingConfig } from '@zilliz/claude-context-core';
import { getModelSpec, isCanonicalModelId, DEFAULT_PRIMARY_MODEL_ID } from '@zilliz/claude-context-core';

/**
 * Construct the secondary (0.6B) RabbitMQEmbedding instance ONLY when the config
 * activates it (milvusCollectionPrivate0p6b is truthy). Returns undefined otherwise.
 *
 * The activation signal is the PRESENCE of MILVUS_COLLECTION_PRIVATE_0P6B — this ensures
 * that adding only a queue override does nothing, and the user must explicitly name the
 * collection they want to write into.
 *
 * Per LD-2: secondary uses a SEPARATE RabbitMQEmbedding instance from the primary because
 * the per-instance dimension guard in rabbitmq-embedding.ts forbids reusing one instance
 * across dimensions (dim guard at ~line 217 rejects wrong-dim replies at the protocol level).
 *
 * All diagnostic output goes to stderr — never stdout (JSON-RPC sanctity).
 */
export function createSecondaryEmbeddingInstance(
    config: ContextMcpConfig,
): RabbitMQEmbedding | undefined {
    // Activation check: MILVUS_COLLECTION_PRIVATE_0P6B must be set.
    if (!config.milvusCollectionPrivate0p6b) {
        console.error('[EMBEDDING] Secondary embedding: MILVUS_COLLECTION_PRIVATE_0P6B not set → secondary OFF (single-model mode)');
        return undefined;
    }

    // Only RabbitMQ supports secondary instances in this fork (the other providers
    // do not have the per-instance dimension guard needed for Option B).
    if (config.embeddingProvider !== 'RabbitMQ') {
        console.error(
            `[EMBEDDING] Secondary embedding: provider=${config.embeddingProvider} does not support dual-model — secondary disabled. ` +
            `Set EMBEDDING_PROVIDER=RabbitMQ to enable.`
        );
        return undefined;
    }

    if (!config.rabbitmqUrl) {
        console.error('[EMBEDDING] Secondary embedding: RABBITMQ_INFERENCE_URL not set — secondary disabled');
        return undefined;
    }

    // Resolve secondary spec from registry; allow env overrides for non-standard deployments.
    const secondaryModelId = config.rabbitmqSecondaryModel ?? 'qwen3-embedding-0.6b';
    let spec;
    if (isCanonicalModelId(secondaryModelId)) {
        spec = getModelSpec(secondaryModelId);
    } else {
        console.error(
            `[EMBEDDING] Secondary embedding: RABBITMQ_SECONDARY_MODEL='${secondaryModelId}' is not a canonical model id. ` +
            `Secondary disabled.`
        );
        return undefined;
    }

    const secondaryQueue = config.rabbitmqSecondaryQueue ?? spec.queue;
    const secondaryDimension = config.rabbitmqSecondaryDimension ?? spec.dimension;

    const rmqCfg: RabbitMQEmbeddingConfig = {
        url: config.rabbitmqUrl,
        queue: secondaryQueue,
        modelName: secondaryModelId,
        dimension: secondaryDimension,
        // Inherit timeout/retries from primary config — secondary runs at background priority,
        // so being patient is correct. maxRetries stays the same (WAIT-tolerance).
        timeoutMs: config.rabbitmqTimeoutMs,
        maxRetries: config.rabbitmqMaxRetries,
        // Secondary uses registry priorityDefault (=1) unless caller overrides at embed time.
        // Do NOT inherit rabbitmqPriority from primary (that is the interactive 8B priority=10).
        priority: spec.priorityDefault,
        concurrency: config.rabbitmqConcurrency,
        source: config.rabbitmqSource ?? 'claude-context',
    };

    const secondary = new RabbitMQEmbedding(rmqCfg);

    // Startup stderr log — provider/queue/dim triplet for observability (never stdout).
    console.error(
        `[EMBEDDING] Secondary instance ACTIVE — provider=RabbitMQ queue=${secondaryQueue} dim=${secondaryDimension} model=${secondaryModelId} collection=${config.milvusCollectionPrivate0p6b}`
    );

    return secondary;
}

/**
 * Log the active model configuration to stderr at MCP startup.
 * Called AFTER both instances are constructed so the log is a complete picture.
 * NEVER writes to stdout.
 */
export function logActiveModels(
    primaryQueue: string,
    primaryDim: number,
    secondaryQueue: string | undefined,
    secondaryDim: number | undefined,
    searchDefault: string,
): void {
    console.error(`[EMBEDDING] Active models:`);
    console.error(`[EMBEDDING]   primary:   queue=${primaryQueue} dim=${primaryDim}`);
    if (secondaryQueue !== undefined) {
        console.error(`[EMBEDDING]   secondary: queue=${secondaryQueue} dim=${secondaryDim}`);
    } else {
        console.error(`[EMBEDDING]   secondary: OFF`);
    }
    console.error(`[EMBEDDING]   searchDefault: ${searchDefault}`);
}
```

**Wiring in `packages/mcp/src/index.ts`:** After constructing the primary embedding instance and before constructing `Context`, add:

```typescript
const secondaryEmbedding = createSecondaryEmbeddingInstance(config);
// Log active models to stderr (never stdout)
logActiveModels(
    config.rabbitmqQueue ?? 'embedding.qwen3-8b',
    config.rabbitmqDimension ?? 4096,
    secondaryEmbedding ? (config.rabbitmqSecondaryQueue ?? 'embedding.qwen3-0.6b') : undefined,
    secondaryEmbedding ? (config.rabbitmqSecondaryDimension ?? 1024) : undefined,
    config.searchEmbeddingModel,
);
```

Then pass `secondaryEmbedding` into `Context` as an optional constructor field (Phase 2 wires the `Context` ctor to accept it).

**Single-model byte-identical invariant:** when `milvusCollectionPrivate0p6b` is absent, `createSecondaryEmbeddingInstance` returns `undefined` immediately at line 3 of the function body — no registry lookup, no RabbitMQ constructor call, no behavioral difference from today.

#### Step — Commit (after Phase 2 wires Context)

```
feat(mcp): secondary RabbitMQEmbedding factory + active-model startup log (LD-2,Phase4.1)
```

---

---

## Phase 1 — Snapshot v2-additive per-model ledger (KEYSTONE — gates everything)

> **rev1.1 supersession notice.** The headline LD-4 / Task-1.1 wording "Snapshot **v2→v3** … bump `formatVersion` union to include `'v3'`" is **SUPERSEDED by M1**. We do **NOT** bump the emitted `formatVersion`. The on-disk `formatVersion` stays the literal string `'v2'` forever; `filesByModel` rides **additively** inside each codebase entry. Rationale (verified against source): `loadV2Format` (`snapshot.ts:100-144`) stores `info` verbatim into `codebaseInfoMap` and ignores unknown keys, so an OLD `dist` reading a file that carries `filesByModel` neither crashes nor drops the field on round-trip merge — **but only if the write version string stays `'v2'`**. If any binary ever emits `formatVersion:'v3'`, the OLD binary's `mergeAndWriteSnapshot` merge-read gate (`snapshot.ts:566`, `existingSnapshot.formatVersion === 'v2'`) evaluates false → `existingCodebases = {}` → the next save **wipes every other user's codebase from the SHARED multi-user snapshot**. That is the blast radius M1 exists to prevent. Everywhere this plan said "v3", read "v2-additive + forward-tolerant read predicate."

**Goal:** per-`(codebase × model)` completeness without losing the 8B resume state on the shared snapshot, and without ever emitting a `formatVersion` string the deployed `dist` can't merge.

> ⛔ **Gate:** Phases 2–6 are blocked until **Task 1.3**'s round-trip runner (`snapshot-v3-roundtrip.test.mjs`) exits 0 against compiled `dist`, reviewed (R1).

> **Dependency:** Phase 1 imports `DEFAULT_PRIMARY_MODEL_ID` from `@zilliz/claude-context-core`. That symbol is produced by **Phase 0 Task 0.1** (`packages/core/src/embedding/model-registry.ts`, re-exported via `packages/core/src/embedding/index.ts` → core barrel `packages/core/src/index.ts:2 export * from './embedding'`). **Phase 0 Task 0.1 MUST land and `pnpm build:core` MUST be green before starting Task 1.2.** Verified the edge exists: `packages/mcp/src/config.ts:1` already does `import { envManager } from "@zilliz/claude-context-core"`.

---

### Verified source anchors (read 2026-06-14, do not re-derive)

| Anchor | File:line | Current text (verbatim) |
|---|---|---|
| Read/dispatch predicate | `snapshot.ts:33-35` | `private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {` / `return snapshot && snapshot.formatVersion === 'v2';` / `}` |
| Load dispatch | `snapshot.ts:520-524` | `if (this.isV2Format(snapshot)) {` / `this.loadV2Format(snapshot);` / `} else {` / `this.loadV1Format(snapshot);` / `}` |
| Merge-read gate | `snapshot.ts:566` | `if (existingSnapshot && existingSnapshot.formatVersion === 'v2' && existingSnapshot.codebases) {` |
| Field-merge of `files` | `snapshot.ts:582-591` | `for (const [codebasePath, info] of this.codebaseInfoMap) { … codebases[codebasePath] = { ...info, files: { ...existingFiles, ...infoFiles } } … }` |
| Write version | `snapshot.ts:598-602` | `const snapshot: CodebaseSnapshotV2 = { formatVersion: 'v2', codebases: codebases, lastUpdated: … };` |
| `setFileComplete` | `snapshot.ts:348-357` | seeds `entry.files` |
| `setCodebaseIndexing` carry-forward | `snapshot.ts:362-380` | `const priorFiles = (prior && …).files \|\| undefined; … ...(priorFiles ? { files: priorFiles } : {})` |
| `setCodebaseIndexed` carry-forward | `snapshot.ts:385-413` | same `priorFiles` pattern |
| `getFileLedger` | `snapshot.ts:449-463` | reads `(entry as …).files` only |
| `getFileLedger` sole consumer | `handlers.ts:430` | `const priorLedger = this.snapshotManager.getFileLedger(absolutePath);` |
| Type `FileCompleteness` | `config.ts:48-52` | `{ fileHash; chunkCount; complete }` |
| `CodebaseInfoIndexing` | `config.ts:60-64` | has `files?: Record<string, FileCompleteness>` |
| `CodebaseInfoIndexed` | `config.ts:67-73` | has `files?: Record<string, FileCompleteness>` |
| `CodebaseSnapshotV2` | `config.ts:85-89` | `formatVersion: 'v2'` |
| Test convention | `snapshot-ledger.test.mjs` | `.mjs` imports `dist/snapshot.js`, `withTempHome`, `eq`/`check`, `process.exit(failures===0?0:1)`, registered as `test:ledger` in `package.json:16` |

---

### Task 1.1 — Additive type changes for `filesByModel` (M1 types + LD-4 additive)

**Files:**
- Modify: `packages/mcp/src/config.ts` (`CodebaseInfoIndexing`, `CodebaseInfoIndexed`; leave `CodebaseSnapshotV2.formatVersion` as `'v2'`)
- Test: `packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs` (the gate — added in Task 1.3; types are exercised through compiled `dist` there, **not** a `.test.ts`)

**Current signatures (verified `config.ts:60-73`):**

```typescript
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;  // Current progress percentage
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4)
}

export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;        // Number of files indexed
    totalChunks: number;         // Total number of chunks generated
    indexStatus: 'completed' | 'limit_reached';  // Status from indexing result
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4)
}
```

**Step 1 — Run, expect FAIL:** there is no `.test.ts` for this in mcp (M3 forbids it). The type change is *gated by* the Task 1.3 runner; before this edit the runner's `getFileLedgerForModel` import does not exist → runner exits non-zero. We still commit types first so the accessor edit (Task 1.2) typechecks. To get a red signal now: `pnpm build:mcp` succeeds (additive optional field), so the binding gate is Task 1.3. (No premature `.test.ts`.)

**Step 2 — FULL replacement for `config.ts:60-73` (additive `filesByModel?`; `formatVersion` UNCHANGED):**

```typescript
// Indexing state - when indexing is in progress
export interface CodebaseInfoIndexing extends CodebaseInfoBase {
    status: 'indexing';
    indexingPercentage: number;  // Current progress percentage
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4) — the literal 8B (primary) ledger.
    // ADDITIVE (dual-embedding, rev1.1/M1): per-secondary-model ledgers keyed by CANONICAL model id
    // (e.g. 'qwen3-embedding-0.6b'). The primary 8B model is NEVER stored here — it stays in `files`
    // so the deployed dist (which knows only `files`) round-trips it untouched. Unknown keys are
    // ignored by loadV2Format (snapshot.ts:118 stores `info` verbatim), preserving forward-compat.
    filesByModel?: Record<string, Record<string, FileCompleteness>>;
    // ADDITIVE (P4 coverage gate): per-secondary-model distinct-PK overlap ratio vs the 8B source
    // (0..1). Optional; absence ⇒ "unknown" (treated as below-threshold by the search degrade gate).
    coverageByModel?: Record<string, number>;
}

// Indexed state - when indexing completed successfully
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;        // Number of files indexed
    totalChunks: number;         // Total number of chunks generated
    indexStatus: 'completed' | 'limit_reached';  // Status from indexing result
    files?: Record<string, FileCompleteness>;  // Per-file completeness ledger (Commit 3/4) — the literal 8B (primary) ledger.
    // ADDITIVE (dual-embedding, rev1.1/M1) — see CodebaseInfoIndexing.
    filesByModel?: Record<string, Record<string, FileCompleteness>>;
    coverageByModel?: Record<string, number>;
}
```

> **Do NOT touch `CodebaseSnapshotV2` (`config.ts:85-89`).** Its `formatVersion: 'v2'` literal stays. (Superseding Task-1.1's "Bump `formatVersion` union to include `'v3'`".) `coverageByModel` is declared here so M2's exhaustive carry-forward (Task 1.2) preserves it for P4 without a later type churn — RG-5.

**Step 3 — `pnpm typecheck && pnpm build:mcp`** (additive optional fields → green). **Step 4 — Commit** `feat(mcp): additive filesByModel/coverageByModel on snapshot entries; formatVersion stays v2 (M1)`.

---

### Task 1.2 — Forward-tolerant read predicate + per-model accessors + EXHAUSTIVE carry-forward (M1 + M2)

**Files:**
- Modify: `packages/mcp/src/snapshot.ts` — (a) `isV2Format` → forward-tolerant `isV2OrLater` and route both the load dispatch (`:520`) and the merge-read gate (`:566`) through it; (b) add `getFileLedgerForModel` / `setFileCompleteForModel`; (c) make `getFileLedger` delegate to the primary id; (d) rewrite the three carry-forward sites (`setCodebaseIndexing`, `setCodebaseIndexed`, `mergeAndWriteSnapshot`) as **exhaustive `...rest` spreads**.
- Import the primary id constant (Phase-0 product).
- Test: gated by Task 1.3 runner.

**Step 1 — Run, expect FAIL:** `node packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs` (Task 1.3) — fails because `getFileLedgerForModel` / `setFileCompleteForModel` are not yet on the compiled `dist/snapshot.js`. (Existing `pnpm test:ledger` MUST stay green throughout — it is the regression guard for the single-model carry-forward we are refactoring.)

**Step 2 — Edits, FULL corrected source for every changed region:**

**(a) Import the primary id.** Current `snapshot.ts:5-14` imports only from `./config.js`. Add a second import. FULL replacement of the import block (`snapshot.ts:1-14`):

```typescript
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import lockfile from "proper-lockfile";
import {
    CodebaseSnapshot,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseInfo,
    CodebaseInfoIndexing,
    CodebaseInfoIndexed,
    CodebaseInfoIndexFailed,
    FileCompleteness
} from "./config.js";
// Canonical primary model id (SSOT, Phase 0). The primary 8B ledger lives in the legacy
// top-level `files`; secondaries live in `filesByModel[modelId]`. Importing the constant
// (not hardcoding the string) keeps the ledger key in lock-step with the registry.
import { DEFAULT_PRIMARY_MODEL_ID } from "@zilliz/claude-context-core";
```

> **Verified import path is valid:** core barrel `packages/core/src/index.ts:2` re-exports `./embedding`, and Phase-0 Task 0.1 adds `export * from './model-registry'` to `packages/core/src/embedding/index.ts`. If the package-boundary import is undesirable, the fallback is a local `const DEFAULT_PRIMARY_MODEL_ID = 'qwen3-embedding-8b';` — but prefer the import so there is ONE source of truth (a drifted literal here is exactly the env-mutable-key class of bug LD-4 warns against).

**(b) Forward-tolerant read predicate.** Current `snapshot.ts:30-35`:

```typescript
    /**
     * Check if snapshot is v2 format
     */
    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return snapshot && snapshot.formatVersion === 'v2';
    }
```

FULL replacement (keep `isV2Format` as a thin alias so no other caller breaks; add the tolerant predicate):

```typescript
    /**
     * Forward-tolerant format predicate (M1). True for the current emitted format
     * ('v2') AND any future additive successor ('v3', 'v4', …) whose shape is still
     * { formatVersion, codebases: {...} }. We MUST read-merge such files rather than
     * treat them as v1 — otherwise mergeAndWriteSnapshot would discard the existing
     * `codebases` map and the next save would WIPE other users' entries from the
     * SHARED multi-user snapshot (the M1 blast radius). v1 has NO `codebases` key, so
     * presence of `codebases` is the structural discriminator; the version string is
     * only used to reject the legacy v1 array shape.
     */
    private isV2OrLater(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return !!snapshot
            && typeof snapshot.formatVersion === 'string'
            && snapshot.formatVersion !== 'v1'
            && !!snapshot.codebases
            && typeof snapshot.codebases === 'object';
    }

    /**
     * @deprecated retained for any external caller; delegates to isV2OrLater.
     * Check if snapshot is the structured (v2-or-later) format.
     */
    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return this.isV2OrLater(snapshot);
    }
```

> **Why `isV2Format` delegates instead of being deleted:** it is called at `:156`, `:181`, `:221` (the read accessors `getIndexedCodebases` / `getIndexingCodebases` / `getIndexingProgress`). Routing them through the tolerant predicate is correct (they must read a future-additive file too) and avoids touching three more sites. Verified these are the only `isV2Format` call sites: `grep "isV2Format"` → `:33` (decl) `:156 :181 :221 :520`.

**(c) Load dispatch.** Current `snapshot.ts:520-524`:

```typescript
            if (this.isV2Format(snapshot)) {
                this.loadV2Format(snapshot);
            } else {
                this.loadV1Format(snapshot);
            }
```

FULL replacement (route through the tolerant predicate explicitly — name it for the reader):

```typescript
            if (this.isV2OrLater(snapshot)) {
                this.loadV2Format(snapshot);
            } else {
                this.loadV1Format(snapshot);
            }
```

**(d) Merge-read gate — THE keystone line.** Current `snapshot.ts:560-572`:

```typescript
    private mergeAndWriteSnapshot(): void {
        // Read existing snapshot to merge with (prevents multi-session overwrites)
        let existingCodebases: Record<string, CodebaseInfo> = {};
        try {
            const existingData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const existingSnapshot = JSON.parse(existingData);
            if (existingSnapshot && existingSnapshot.formatVersion === 'v2' && existingSnapshot.codebases) {
                existingCodebases = existingSnapshot.codebases;
                console.log(`[SNAPSHOT-DEBUG] Loaded ${Object.keys(existingCodebases).length} existing codebases for merge`);
            }
        } catch (readError) {
            console.warn('[SNAPSHOT-DEBUG] Could not read existing snapshot for merge, will overwrite:', readError);
        }
```

FULL replacement (gate via `isV2OrLater` — else a future-additive file on disk written by a newer peer would be treated as unmergeable and CLOBBERED):

```typescript
    private mergeAndWriteSnapshot(): void {
        // Read existing snapshot to merge with (prevents multi-session overwrites)
        let existingCodebases: Record<string, CodebaseInfo> = {};
        try {
            const existingData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const existingSnapshot = JSON.parse(existingData);
            // M1: gate on the FORWARD-TOLERANT predicate, NOT a literal `=== 'v2'`.
            // If a newer peer wrote a future-additive file, the literal check would be
            // false here and the next save would discard every existing codebase from
            // the SHARED snapshot. isV2OrLater accepts any { formatVersion, codebases }.
            if (this.isV2OrLater(existingSnapshot)) {
                existingCodebases = existingSnapshot.codebases;
                console.log(`[SNAPSHOT-DEBUG] Loaded ${Object.keys(existingCodebases).length} existing codebases for merge`);
            }
        } catch (readError) {
            console.warn('[SNAPSHOT-DEBUG] Could not read existing snapshot for merge, will overwrite:', readError);
        }
```

**(e) EXHAUSTIVE field-merge in `mergeAndWriteSnapshot` (M2 + RG-5).** Current `snapshot.ts:574-602`:

```typescript
        // Merge: start with existing codebases, then apply this session's entries on top.
        const codebases: Record<string, CodebaseInfo> = { ...existingCodebases };

        // Apply all codebases from this session's info map (overwrites same paths, preserves others).
        // The per-file completeness ledger (`files`) must be FIELD-MERGED with the
        // existing on-disk entry, not whole-object-replaced: two sessions (or this
        // session's 2s tick vs. an earlier write) each hold only the files they
        // touched, so a plain replace would clobber the other session's ledger.
        for (const [codebasePath, info] of this.codebaseInfoMap) {
            const existing = codebases[codebasePath];
            const existingFiles = (existing && (existing as CodebaseInfoIndexing | CodebaseInfoIndexed).files) || undefined;
            const infoFiles = (info as CodebaseInfoIndexing | CodebaseInfoIndexed).files;
            if (existingFiles || infoFiles) {
                codebases[codebasePath] = { ...info, files: { ...existingFiles, ...infoFiles } } as CodebaseInfo;
            } else {
                codebases[codebasePath] = info;
            }
        }

        // Remove codebases that this session explicitly removed
        for (const removedPath of this.removedCodebases) {
            delete codebases[removedPath];
        }

        const snapshot: CodebaseSnapshotV2 = {
            formatVersion: 'v2',
            codebases: codebases,
            lastUpdated: new Date().toISOString()
        };
```

FULL replacement (deep-merge BOTH `files` and every `filesByModel[modelId]` sub-ledger; spread `...info` so unknown future fields survive; `formatVersion` stays `'v2'`):

```typescript
        // Merge: start with existing codebases, then apply this session's entries on top.
        const codebases: Record<string, CodebaseInfo> = { ...existingCodebases };

        // Apply all codebases from this session's info map (overwrites same paths, preserves others).
        // Per-file completeness ledgers must be FIELD-MERGED with the existing on-disk
        // entry, never whole-object-replaced: two sessions (or this session's 2s tick
        // vs. an earlier write) each hold only the files they touched. This now covers
        // BOTH the legacy top-level `files` (8B) AND every secondary `filesByModel[id]`
        // sub-ledger (M2). `...info` is spread LAST-but-overridden-on-ledgers so any
        // future additive field (e.g. coverageByModel) is carried verbatim (RG-5).
        for (const [codebasePath, info] of this.codebaseInfoMap) {
            const existing = codebases[codebasePath] as
                (CodebaseInfoIndexing | CodebaseInfoIndexed | undefined);
            const incoming = info as (CodebaseInfoIndexing | CodebaseInfoIndexed);

            // 1) merge legacy top-level `files`
            const existingFiles = (existing && existing.files) || undefined;
            const infoFiles = incoming.files;
            const mergedFiles = (existingFiles || infoFiles)
                ? { ...existingFiles, ...infoFiles }
                : undefined;

            // 2) merge every secondary model sub-ledger (union of model ids, per-id field-merge)
            const existingByModel = (existing && existing.filesByModel) || undefined;
            const infoByModel = incoming.filesByModel;
            let mergedByModel: Record<string, Record<string, FileCompleteness>> | undefined;
            if (existingByModel || infoByModel) {
                mergedByModel = {};
                const modelIds = new Set<string>([
                    ...Object.keys(existingByModel || {}),
                    ...Object.keys(infoByModel || {}),
                ]);
                for (const mid of modelIds) {
                    mergedByModel[mid] = {
                        ...((existingByModel && existingByModel[mid]) || {}),
                        ...((infoByModel && infoByModel[mid]) || {}),
                    };
                }
            }

            // 3) coverageByModel: shallow-merge (newer ratio wins per model id)
            const mergedCoverage = (existing?.coverageByModel || incoming.coverageByModel)
                ? { ...existing?.coverageByModel, ...incoming.coverageByModel }
                : undefined;

            // Spread incoming `info` to carry status/stats/lastUpdated AND any future
            // additive field, then override only the deep-merged ledger fields.
            const merged: any = { ...incoming };
            if (mergedFiles) merged.files = mergedFiles; else delete merged.files;
            if (mergedByModel) merged.filesByModel = mergedByModel; else delete merged.filesByModel;
            if (mergedCoverage) merged.coverageByModel = mergedCoverage; else delete merged.coverageByModel;
            codebases[codebasePath] = merged as CodebaseInfo;
        }

        // Remove codebases that this session explicitly removed
        for (const removedPath of this.removedCodebases) {
            delete codebases[removedPath];
        }

        // M1: KEEP emitting 'v2'. filesByModel/coverageByModel ride additively inside
        // each codebase entry; the deployed dist reads them verbatim and round-trips
        // them untouched. NEVER bump this string — see the Phase-1 supersession notice.
        const snapshot: CodebaseSnapshotV2 = {
            formatVersion: 'v2',
            codebases: codebases,
            lastUpdated: new Date().toISOString()
        };
```

**(f) Exhaustive carry-forward in `setCodebaseIndexing`.** Current `snapshot.ts:362-380`:

```typescript
    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // Update info map. Carry any prior completeness ledger forward — the 2s
        // progress tick would otherwise clobber it on every save (Attack-3).
        const prior = this.codebaseInfoMap.get(codebasePath);
        const priorFiles = (prior && (prior as CodebaseInfoIndexing | CodebaseInfoIndexed).files) || undefined;
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString(),
            ...(priorFiles ? { files: priorFiles } : {}),
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }
```

FULL replacement (EXHAUSTIVE `...rest` of prior non-status fields; recompute only `status`/`indexingPercentage`/`lastUpdated`):

```typescript
    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // EXHAUSTIVE carry-forward (M2/RG-5): spread ALL prior non-status fields
        // (files, filesByModel, coverageByModel, and any future additive field) and
        // recompute ONLY status/indexingPercentage/lastUpdated. Field-by-field
        // enumeration silently drops new fields; the 2s progress tick would then
        // clobber the secondary ledgers on every save (the Attack-3 class, now
        // generalized to every model). We strip prior terminal-only fields
        // (indexedFiles/totalChunks/indexStatus/errorMessage/lastAttemptedPercentage)
        // because this entry is now 'indexing'.
        const prior = this.codebaseInfoMap.get(codebasePath) as any;
        const {
            status: _s, indexingPercentage: _p, lastUpdated: _lu,
            indexedFiles: _if, totalChunks: _tc, indexStatus: _is,
            errorMessage: _em, lastAttemptedPercentage: _lap,
            ...rest
        } = (prior || {});
        const info: CodebaseInfoIndexing = {
            ...rest,                                   // files, filesByModel, coverageByModel, future fields
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString(),
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }
```

**(g) Exhaustive carry-forward in `setCodebaseIndexed`.** Current `snapshot.ts:385-413`:

```typescript
    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }
    ): void {
        // Add to indexed list if not already there
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }

        // Remove from indexing state
        this.indexingCodebases.delete(codebasePath);

        // Update file count and info
        this.codebaseFileCount.set(codebasePath, stats.indexedFiles);

        // Carry the completeness ledger across the terminal indexing→indexed
        // transition so a later resume can still consult per-file completeness.
        const prior = this.codebaseInfoMap.get(codebasePath);
        const priorFiles = (prior && (prior as CodebaseInfoIndexing | CodebaseInfoIndexed).files) || undefined;
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString(),
            ...(priorFiles ? { files: priorFiles } : {}),
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }
```

FULL replacement (EXHAUSTIVE; recompute only the terminal stats):

```typescript
    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }
    ): void {
        // Add to indexed list if not already there
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }

        // Remove from indexing state
        this.indexingCodebases.delete(codebasePath);

        // Update file count
        this.codebaseFileCount.set(codebasePath, stats.indexedFiles);

        // EXHAUSTIVE carry-forward (M2/RG-5) across the terminal indexing→indexed
        // transition: spread ALL prior non-status fields (files, filesByModel,
        // coverageByModel, future fields) and recompute ONLY the terminal stats.
        // Strip prior indexing-only / failed-only fields.
        const prior = this.codebaseInfoMap.get(codebasePath) as any;
        const {
            status: _s, indexingPercentage: _p, lastUpdated: _lu,
            indexedFiles: _if, totalChunks: _tc, indexStatus: _is,
            errorMessage: _em, lastAttemptedPercentage: _lap,
            ...rest
        } = (prior || {});
        const info: CodebaseInfoIndexed = {
            ...rest,                                   // files, filesByModel, coverageByModel, future fields
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString(),
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }
```

**(h) Per-model accessors + delegating `getFileLedger`.** Current `getFileLedger` is `snapshot.ts:449-463`. Add the two new accessors immediately before it and rewrite `getFileLedger` to delegate. FULL source for the block (replace `getFileLedger:449-463`; insert the two accessors above it):

```typescript
    /**
     * Per-model resume ledger (M2). The PRIMARY (8B) id reads the legacy top-level
     * `files` (so existing single-model snapshots keep working byte-for-byte);
     * secondaries read `filesByModel[modelId]`. Returns a NEW Map (a COPY) — the
     * in-progress run mutates the LIVE entry via setFileCompleteForModel, but the
     * resume read must see the PRIOR state, so the copy is decoupled from later
     * mutation (same contract getFileLedger has always honored). Empty Map when no
     * entry / no ledger for that model.
     */
    public getFileLedgerForModel(
        codebasePath: string,
        modelId: string
    ): Map<string, { complete: boolean; fileHash: string; chunkCount: number }> {
        const ledger = new Map<string, { complete: boolean; fileHash: string; chunkCount: number }>();
        const entry = this.codebaseInfoMap.get(codebasePath) as
            (CodebaseInfoIndexing | CodebaseInfoIndexed | undefined);
        if (!entry) return ledger;
        const source = (modelId === DEFAULT_PRIMARY_MODEL_ID)
            ? entry.files
            : (entry.filesByModel && entry.filesByModel[modelId]);
        if (source) {
            for (const [relativePath, fc] of Object.entries(source)) {
                ledger.set(relativePath, {
                    complete: fc.complete,
                    fileHash: fc.fileHash,
                    chunkCount: fc.chunkCount,
                });
            }
        }
        return ledger;
    }

    /**
     * Record per-file completeness for a SPECIFIC model (M2). The PRIMARY (8B) id
     * writes the legacy top-level `files` (byte-identical to setFileComplete, so the
     * single-model write path is unchanged); secondaries write
     * filesByModel[modelId]. Seeds a minimal 'indexing' entry if the callback raced
     * ahead of the first setCodebaseIndexing tick (mirrors setFileComplete).
     */
    public setFileCompleteForModel(
        codebasePath: string,
        modelId: string,
        relativePath: string,
        info: FileCompleteness
    ): void {
        let entry = this.codebaseInfoMap.get(codebasePath);
        if (!entry) {
            entry = { status: 'indexing', indexingPercentage: 0, lastUpdated: new Date().toISOString() } as CodebaseInfoIndexing;
            this.codebaseInfoMap.set(codebasePath, entry);
        }
        const e = entry as CodebaseInfoIndexing | CodebaseInfoIndexed;
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) {
            if (!e.files) e.files = {};
            e.files[relativePath] = info;                 // unchanged 8B path
        } else {
            if (!e.filesByModel) e.filesByModel = {};
            if (!e.filesByModel[modelId]) e.filesByModel[modelId] = {};
            e.filesByModel[modelId][relativePath] = info;
        }
    }

    /**
     * Build the prior-run completeness ledger for a codebase (Commit 4/4 — the
     * resume read). Now delegates to the primary (8B) per-model accessor so all
     * existing single-model callers (handlers.ts:430) are unchanged. Returns a NEW
     * Map (a COPY) — see getFileLedgerForModel.
     */
    public getFileLedger(codebasePath: string): Map<string, { complete: boolean; fileHash: string; chunkCount: number }> {
        return this.getFileLedgerForModel(codebasePath, DEFAULT_PRIMARY_MODEL_ID);
    }
```

> **`getFileLedger` contract preserved:** the sole consumer is `handlers.ts:430` (`const priorLedger = this.snapshotManager.getFileLedger(absolutePath);`). Delegating to the primary id returns exactly the same Map it returned before (the 8B `files`), so handlers behavior is byte-identical. The existing `test:ledger` runner's section D (copy semantics) still holds because `getFileLedgerForModel` builds a fresh Map with fresh entry objects.

**Step 3 — Run, expect FAIL → then PASS** of the Task 1.3 runner (it imports these accessors). **Step 4 — `pnpm typecheck && pnpm build:mcp`. Step 5 — re-run the existing regression guard `pnpm test:ledger` → expect PASS (single-model carry-forward unbroken). Step 6 — Commit** `feat(mcp): forward-tolerant isV2OrLater + per-model ledger accessors + exhaustive carry-forward (M1,M2)`.

---

### Task 1.3 — THE KEYSTONE gating runner (`snapshot-v3-roundtrip.test.mjs`) (M3 + P7)

**Files:**
- Create: `packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs` (Node ESM `.mjs` against compiled `dist/snapshot.js`; NO `.test.ts` — M3)
- Modify: `packages/mcp/package.json` (`scripts`) — register `test:roundtrip`

> **P7 fixture pin:** the v2 fixture MUST have `codebases[P].files` **populated**. A v1-migrated codebase legitimately loads with empty `files` (`loadV1Format:86-93` never sets `files`), which would make the "8B ledger preserved" assertion vacuously pass or false-fail depending on phrasing. Pin the fixture to a v2 doc with a real `files` map. The codebase path P MUST exist on disk or `loadV2Format:109` drops it as a ghost — use the repo root (same trick as `snapshot-ledger.test.mjs:67`).

**Step 1 — Write the runner (FULL SOURCE):**

```javascript
// packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs
//
// KEYSTONE GATE (Phase 1, M3). Phases 2-6 are blocked until this exits 0.
// The mcp package has NO jest; per the house convention (snapshot-ledger.test.mjs)
// this is a Node ESM runner that exercises the REAL COMPILED dist so we test
// exactly what ships. Exits 0 on success, non-zero on first failed assertion.
// Assertions are on PARSED objects (JSON.stringify equality) — NEVER substring.
//
// Run (from repo root, after `pnpm build:mcp`):
//   node packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs
//   (or: pnpm --filter @zilliz/claude-context-mcp test:roundtrip)
//
// Coverage:
//   T1 (C2/D1, P7): a hand-written v2 fixture with top-level `files` populated loads
//       under the new dist; getFileLedgerForModel(P,'qwen3-embedding-8b') returns the
//       SAME entries as the legacy `files`; (P,'qwen3-embedding-0.6b') is EMPTY.
//   T2 (M2 cross-runtime keystone): a SECOND SnapshotManager runtime writes a 0.6B
//       completion via setFileCompleteForModel + saveCodebaseSnapshot (the PUBLIC
//       save path), a THIRD runtime re-reads FROM DISK; BOTH the 8B and the 0.6B
//       ledgers survive (capture-and-verify share the same dist runtime).
//   T3 (M1 forward-tolerance): an on-disk file whose formatVersion is 'v3' (a future
//       additive peer) is still merged (its codebases are NOT wiped) and the emitted
//       file's formatVersion is STILL 'v2'.
//   T4 (M1 emit-version invariant): after any save, the on-disk formatVersion === 'v2'.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distSnapshot = path.resolve(__dirname, '..', 'dist', 'snapshot.js');

if (!fs.existsSync(distSnapshot)) {
    console.error(`[snapshot-v3-roundtrip.test] MISSING compiled artifact: ${distSnapshot}\n` +
        `Run 'pnpm build:mcp' first.`);
    process.exit(2);
}

const { SnapshotManager } = await import(pathToFileURL(distSnapshot).href);

const PRIMARY = 'qwen3-embedding-8b';
const SECONDARY = 'qwen3-embedding-0.6b';

// ── tiny assert harness (same shape as snapshot-ledger.test.mjs) ──────────────
let failures = 0;
function check(name, cond, detail) {
    if (cond) { console.log(`  ✓ ${name}`); }
    else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function eq(name, actual, expected) {
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function withTempHome(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-snap-roundtrip-'));
    const prev = process.env.CLAUDE_CONTEXT_HOME;
    process.env.CLAUDE_CONTEXT_HOME = dir;
    try { return fn(dir); }
    finally {
        if (prev === undefined) delete process.env.CLAUDE_CONTEXT_HOME;
        else process.env.CLAUDE_CONTEXT_HOME = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

const snapPath = (home) => path.join(home, 'mcp-codebase-snapshot.json');
const readDisk = (home) => JSON.parse(fs.readFileSync(snapPath(home), 'utf8'));

// P MUST exist on disk or loadV2Format drops it as a ghost (snapshot.ts:109).
const P = path.resolve(__dirname, '..', '..', '..'); // repo root, guaranteed to exist

console.log('snapshot-v3-roundtrip.test — compiled dist/snapshot.js (KEYSTONE)');

// ── T1: v2 fixture with files populated; 8B preserved, 0.6B empty (C2/D1, P7) ──
console.log('\nT1. v2 fixture: 8B ledger preserved, 0.6B empty');
withTempHome((home) => {
    // P7: hand-written v2 doc with top-level `files` POPULATED (NOT a v1-migrated empty).
    const fixture = {
        formatVersion: 'v2',
        codebases: {
            [P]: {
                status: 'indexed',
                indexedFiles: 1,
                totalChunks: 3,
                indexStatus: 'completed',
                lastUpdated: new Date().toISOString(),
                files: { 'a.ts': { complete: true, fileHash: 'h1', chunkCount: 3 } }
            }
        },
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(snapPath(home), JSON.stringify(fixture, null, 2));

    const mgr = new SnapshotManager();
    mgr.loadCodebaseSnapshot();

    const eight = mgr.getFileLedgerForModel(P, PRIMARY);
    eq('8B ledger a.ts == legacy files entry', eight.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    check('8B ledger size === 1', eight.size === 1, `size=${eight.size}`);

    const small = mgr.getFileLedgerForModel(P, SECONDARY);
    check('0.6B ledger empty on first load', small.size === 0, `size=${small.size}`);

    // M1 emit invariant: loadCodebaseSnapshot re-saves; on-disk version stays 'v2'.
    eq('emitted formatVersion stays v2 after load-migrate', readDisk(home).formatVersion, 'v2');
});

// ── T2: cross-runtime 0.6B write survives; 8B untouched (M2 keystone) ──────────
console.log('\nT2. two runtimes: 0.6B write persists, 8B untouched, both survive reload');
withTempHome((home) => {
    // Runtime #1 seeds the 8B ledger via the normal indexing path, saves.
    const r1 = new SnapshotManager();
    r1.setCodebaseIndexing(P, 0);
    r1.setFileCompleteForModel(P, PRIMARY, 'a.ts', { complete: true, fileHash: 'h1', chunkCount: 3 });
    r1.setCodebaseIndexed(P, { indexedFiles: 1, totalChunks: 3, status: 'completed' });
    r1.saveCodebaseSnapshot();

    // Runtime #2 starts fresh, loads, writes a DIFFERENT model's completion for a
    // DIFFERENT file, saves through the PUBLIC saveCodebaseSnapshot.
    const r2 = new SnapshotManager();
    r2.loadCodebaseSnapshot();
    r2.setFileCompleteForModel(P, SECONDARY, 'b.ts', { complete: true, fileHash: 'h2', chunkCount: 2 });
    r2.saveCodebaseSnapshot();

    // Runtime #3 re-reads FROM DISK and verifies BOTH ledgers (parsed objects).
    const r3 = new SnapshotManager();
    r3.loadCodebaseSnapshot();
    const eight = r3.getFileLedgerForModel(P, PRIMARY);
    const small = r3.getFileLedgerForModel(P, SECONDARY);
    eq('8B a.ts survived the 0.6B write', eight.get('a.ts'),
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    check('8B ledger still size 1 (0.6B did not leak in)', eight.size === 1, `size=${eight.size}`);
    eq('0.6B b.ts persisted across runtimes', small.get('b.ts'),
        { complete: true, fileHash: 'h2', chunkCount: 2 });
    check('0.6B ledger size 1', small.size === 1, `size=${small.size}`);

    // Disk-shape proof: filesByModel carries the secondary; files carries the 8B.
    const disk = readDisk(home);
    eq('disk files (8B) intact', disk.codebases[P].files['a.ts'],
        { complete: true, fileHash: 'h1', chunkCount: 3 });
    eq('disk filesByModel[0.6b] intact', disk.codebases[P].filesByModel[SECONDARY]['b.ts'],
        { complete: true, fileHash: 'h2', chunkCount: 2 });
    eq('emitted formatVersion stays v2', disk.formatVersion, 'v2');
});

// ── T3: future-additive 'v3' on disk is merged, not wiped (M1 forward-tolerance)
console.log('\nT3. a v3 on-disk peer file is merged (codebases preserved), re-emitted as v2');
withTempHome((home) => {
    // Simulate a NEWER peer that wrote formatVersion:'v3' with an existing codebase.
    const v3 = {
        formatVersion: 'v3',
        codebases: {
            [P]: {
                status: 'indexed',
                indexedFiles: 1, totalChunks: 1, indexStatus: 'completed',
                lastUpdated: new Date().toISOString(),
                files: { 'peer.ts': { complete: true, fileHash: 'pz', chunkCount: 1 } }
            }
        },
        lastUpdated: new Date().toISOString()
    };
    fs.writeFileSync(snapPath(home), JSON.stringify(v3, null, 2));

    // Our binary loads (must NOT treat as v1), adds its own entry, saves.
    const m = new SnapshotManager();
    m.loadCodebaseSnapshot();
    m.setCodebaseIndexing(P, 5);
    m.setFileCompleteForModel(P, PRIMARY, 'mine.ts', { complete: true, fileHash: 'mz', chunkCount: 1 });
    m.saveCodebaseSnapshot();

    const disk = readDisk(home);
    // The peer's codebase + file MUST survive (NOT wiped by an over-strict ==='v2').
    eq('peer.ts from the v3 file survived the merge', disk.codebases[P].files['peer.ts'],
        { complete: true, fileHash: 'pz', chunkCount: 1 });
    eq('our mine.ts merged in', disk.codebases[P].files['mine.ts'],
        { complete: true, fileHash: 'mz', chunkCount: 1 });
    eq('re-emitted as v2 (we never bump the version string)', disk.formatVersion, 'v2');
});

// ── T4: emit-version invariant (M1) ───────────────────────────────────────────
console.log('\nT4. emit version invariant: every save writes formatVersion v2');
withTempHome((home) => {
    const m = new SnapshotManager();
    m.setCodebaseIndexing(P, 0);
    m.saveCodebaseSnapshot();
    eq('save #1 formatVersion', readDisk(home).formatVersion, 'v2');
    m.setFileCompleteForModel(P, SECONDARY, 'c.ts', { complete: false, fileHash: 'cz', chunkCount: 0 });
    m.saveCodebaseSnapshot();
    eq('save #2 (with filesByModel) formatVersion still v2', readDisk(home).formatVersion, 'v2');
});

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
```

**Step 2 — Register the package script.** Current `packages/mcp/package.json:16` (verified):

```json
        "test:ledger": "pnpm build && node scripts/snapshot-ledger.test.mjs",
```

FULL replacement (add `test:roundtrip` right after `test:ledger`; build-first so the runner imports a current `dist`):

```json
        "test:ledger": "pnpm build && node scripts/snapshot-ledger.test.mjs",
        "test:roundtrip": "pnpm build && node scripts/snapshot-v3-roundtrip.test.mjs",
```

**Step 3 — Run, expect FAIL** (accessors not yet on dist if run before Task 1.2; or assertion fail if carry-forward is wrong):
- Exact command (from repo root): `pnpm --filter @zilliz/claude-context-mcp test:roundtrip`
- Or directly after a build: `pnpm build:mcp && node packages/mcp/scripts/snapshot-v3-roundtrip.test.mjs`
- Expected on a missing accessor: non-zero exit, stderr line `... is not a function` or a `✗` assertion line.

**Step 4 — After Task 1.2 lands, run, expect PASS.** Acceptance (binary, per `feedback_binary_acceptance`):
- **Exit code === 0** (`echo $?` / `$LASTEXITCODE` is `0`).
- **stdout final line === `PASS — 0 failed assertion(s)`** is a human aid, NOT the gate; the gate is the **exit code** plus the per-assertion `eq()`/`check()` calls which compare **parsed objects** via `JSON.stringify` (never substring).
- The `test:ledger` regression guard ALSO exits 0 (`pnpm --filter @zilliz/claude-context-mcp test:ledger`) — proves single-model carry-forward unbroken.

**Step 5 — `pnpm typecheck && pnpm build:mcp`. Step 6 — Commit** `test(mcp): keystone v2-additive per-model round-trip gate (M3,P7)` .

---

### Task 1.4 — N1: replace audit A4 with an exit-code unchecked-box gate

> **N1.** Audit item **A4** ("Every phase's tasks are checked off in the source-of-truth copy") currently has no machine check. Replace it with an exit-code gate that counts unchecked boxes (`- [ ]`) in the **source-of-truth** plan copy and **fails non-zero if any remain**. Substring presence alone is forbidden as a *pass* signal; here the count of the exact token `- [ ]` being **=== 0** is the parsed assertion.

**Files:**
- Create: `packages/mcp/scripts/plan-tasks-complete.mjs`
- Modify: the plan's audit section A4 text (this document) to cite the gate command.

**A4 replacement text (paste into the audit checklist, superseding the current A4):**

> - [ ] **A4** Every phase's tasks are checked off in the source-of-truth copy. **Gate (exit-code):** `node packages/mcp/scripts/plan-tasks-complete.mjs` exits 0 iff the count of the literal token `- [ ]` in `docs/plan/2026-06-14-dual-embedding.md` is **0**. Exit 1 prints the remaining count + the first 20 offending line numbers.

**Runner (FULL SOURCE):**

```javascript
// packages/mcp/scripts/plan-tasks-complete.mjs
//
// Audit A4 (N1): the source-of-truth plan must have ZERO unchecked task boxes.
// Counts the literal unchecked-checkbox token `- [ ]` (markdown task syntax) in the
// source-of-truth copy and exits non-zero if any remain. This is an exit-code gate,
// not a substring "pass": the PASS condition is the parsed count === 0.
//
// Run (from repo root):
//   node packages/mcp/scripts/plan-tasks-complete.mjs
//   (optional arg: an explicit path to the plan file)

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLAN = path.resolve(
    __dirname, '..', '..', '..', 'docs', 'plan', '2026-06-14-dual-embedding.md'
);
const planPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_PLAN;

if (!fs.existsSync(planPath)) {
    console.error(`[plan-tasks-complete] MISSING plan file: ${planPath}`);
    process.exit(2);
}

const lines = fs.readFileSync(planPath, 'utf8').split(/\r?\n/);
// Match the markdown unchecked-task token at a list position: optional indent,
// a bullet (- * +), then `[ ]`. Avoid matching `[ ]` inside prose/code by anchoring
// to a list-item bullet.
const UNCHECKED = /^\s*[-*+]\s+\[ \]/;
const offenders = [];
lines.forEach((line, i) => { if (UNCHECKED.test(line)) offenders.push(i + 1); });

const count = offenders.length;
if (count === 0) {
    console.log(`PASS — 0 unchecked task boxes in ${path.basename(planPath)}`);
    process.exit(0);
}
console.error(`FAIL — ${count} unchecked task box(es) remain in ${path.basename(planPath)}`);
console.error(`  first ${Math.min(20, count)} offending line number(s): ${offenders.slice(0, 20).join(', ')}`);
process.exit(1);
```

> **This gate is EXPECTED to fail (exit 1) until the plan is fully executed** — that is its purpose. It becomes the final A4 check at audit time. Register optionally as `"test:plan-complete": "node scripts/plan-tasks-complete.mjs"` in `package.json` if a script handle is wanted; the raw `node` command suffices.

**Commit** (when the gate file is added, NOT when boxes are all checked): `chore(mcp): A4 exit-code gate for unchecked plan task boxes (N1)`.

---

### Phase 1 exit criteria (all must hold before unblocking Phase 2)

1. `pnpm typecheck` exits 0; `pnpm build:core && pnpm build:mcp` exit 0; `node packages/mcp/dist/index.js --help` writes nothing to stdout.
2. `pnpm --filter @zilliz/claude-context-mcp test:roundtrip` **exits 0** (keystone — T1..T4 all `✓`).
3. `pnpm --filter @zilliz/claude-context-mcp test:ledger` **exits 0** (single-model regression guard unbroken).
4. On-disk `formatVersion` after any save is the literal `'v2'` (asserted by T4; spot-check the shared snapshot is never rewritten to `'v3'`).
5. `getFileLedger(P)` returns the same Map as `getFileLedgerForModel(P, 'qwen3-embedding-8b')` (delegation; `handlers.ts:430` unchanged).

---

## Cluster B — Index pipeline + IndexTarget (Phases 2 & 3)

> **Scope:** the inner index/upsert/delete loop becomes per-model via an `IndexTarget` abstraction (M6, M7, M8, P1, P2, LD-6). The outer Merkle scan + AST split runs **once**; each target embeds with its own `Embedding` instance and upserts to its own collection. **Single-model byte-identity is preserved**: when no secondary is configured, `buildIndexTargets()` returns exactly one target whose `collectionName === getCollectionName(path)` and `embedding === this.embedding`, and every read site resolves to the same value it reads today.
>
> **Verified source anchors (read 2026-06-14, `packages/core/src/context.ts`, 1810 lines total):**
> - `getCollectionName` — line **279** (`public getCollectionName(codebasePath: string): string`)
> - `getSharedCollectionName` — line **295**; `getWritableSharedCollectionName` — line **306**
> - `prepareCollection` — line **777**, writable-shared creation block **810-825**
> - `processFileList` — line **910**; `loadExistingFileHashes` call at **935**; resume-skip block **985-1006**; delete-on-change block **1015-1035**
> - `processChunkBuffer` — line **1233**; `processChunkBatch` — line **1262**; `expectedDim = this.embedding.getDimension()` at **1267**; `embedBatchPartial` at **1294**; rogue-dim guard `res.vector.length !== expectedDim` at **1317**; upsert reads `this.getCollectionName`/`this.getWritableSharedCollectionName` at **1364-1365**; inline writable-shared upsert at **1380-1382 / 1385-1387**
> - `generateId` — line **1445** (model-blind, unchanged per LD-7)
> - `_reindexByChangeImpl` — line **421** (live from `sync.ts:158` via `reindexByChange` at **414**); `deleteFileChunks` — line **490**
> - `loadExistingFileHashes(collectionName)` — line **880** (already collection-parameterized)
> - `RabbitMQEmbedding.getDimension()` — `rabbitmq-embedding.ts:349`; `detectDimension()` — `:344` (both return `config.dimension`; 0.6B instance ⇒ 1024)
> - MCP handler resume read: `handlers.ts:430` `getFileLedger(absolutePath)`; index call `handlers.ts:434-452` (threads `priorLedger`)
>
> **Test conventions:** core uses **jest** (`packages/core/jest.config.js`, `test` ignores `*.int.test.ts`, `test:int` matches `*.int.test.ts`, `testTimeout:15000`). Integration tests in this cluster live at `packages/core/src/__tests__/*.int.test.ts` and run with `pnpm --filter @zilliz/claude-context-core test:int`. The `makeContext` fake-injection pattern (`context-completeness.test.ts:52-88`) is the house pattern for driving the real `processFileList`/`processChunkBatch` with stub `embedding`/`vectorDatabase`. MCP-package gates remain `.mjs`-against-`dist` (none added in this cluster — all Cluster-B code is in `packages/core`, except the **one** handler edit in Task 3.4 which is covered by the core int test asserting the threaded ledger shape).

---

### Phase 2 — `IndexTarget` abstraction + per-model index loop

**Goal:** make collection + embedding selection model-aware at every inner-loop site and split the inner loop per model, while keeping the single-target path byte-identical.

#### Task 2.0 (prereq for whole cluster): `IndexTarget` interface + `getCollectionNameForModel` resolver + `buildIndexTargets`

This is the **shared owner** the review's Residual-Risk-1 demands: one `IndexTarget[]` builder used by `prepareCollection`, `processFileList`, the per-target delete, and (Phase 3) `_reindexByChangeImpl`. Build it first so every later task consumes it.

**Files:**
- Modify: `packages/core/src/context.ts` (add `IndexTarget` interface near `BatchOutcome` ~125; add resolver near `getCollectionName` ~289; add `buildIndexTargets` + a `secondaryEmbedding` ctor field)
- Modify: `packages/core/src/embedding/index.ts` (re-export `getModelSpec`, `DEFAULT_PRIMARY_MODEL_ID` from Phase 0's `model-registry.ts` if not already)
- Test: `packages/core/src/__tests__/index-target.test.ts` (unit, runs under `pnpm test`)

**Step 1 — Write the failing test:**

```typescript
// packages/core/src/__tests__/index-target.test.ts
import { Context } from '../context';
import { envManager } from '../utils/env-manager';

function makeCtx(opts: { secondary?: boolean; hybrid?: boolean } = {}): Context {
  const stubDb: any = {
    hasCollection: async () => false, query: async () => [], queryAll: async () => [],
    upsert: async () => {}, upsertHybrid: async () => {}, deleteByFilter: async () => {},
    createCollection: async () => {}, createHybridCollection: async () => {}, dropCollection: async () => {},
  };
  const primary = {
    embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: [0, 0, 0, 0], dimension: 4 })),
    getDimension: () => 4096, getProvider: () => 'primary',
    embed: async () => ({ vector: [0, 0, 0, 0], dimension: 4096 }), detectDimension: async () => 4096,
  };
  const secondary = opts.secondary ? {
    embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: [0], dimension: 1 })),
    getDimension: () => 1024, getProvider: () => 'secondary',
    embed: async () => ({ vector: [0], dimension: 1024 }), detectDimension: async () => 1024,
  } : undefined;
  const ctx = new Context({ vectorDatabase: stubDb, embedding: primary as any, secondaryEmbedding: secondary as any });
  (ctx as any).getIsHybrid = () => opts.hybrid ?? true;
  return ctx;
}

describe('getCollectionNameForModel', () => {
  afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; });

  it('primary suffix "" is byte-identical to getCollectionName', () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const ctx = makeCtx();
    expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-8b'))
      .toBe(ctx.getCollectionName('/repo'));
    expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-8b')).toBe('claude_context_own');
  });

  it('secondary appends the registry suffix to the base name', () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const ctx = makeCtx();
    expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-0.6b'))
      .toBe('claude_context_own_0p6b');
  });

  it('MILVUS_COLLECTION_PRIVATE_0P6B override wins verbatim', () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'custom_small_collection';
    const ctx = makeCtx();
    expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-0.6b'))
      .toBe('custom_small_collection');
  });

  it('unknown model id throws', () => {
    const ctx = makeCtx();
    expect(() => (ctx as any).getCollectionNameForModel('/repo', 'gpt')).toThrow(/unknown embedding model/i);
  });
});

describe('buildIndexTargets', () => {
  it('single-model: exactly one target, byte-identical collection + same embedding instance', () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const ctx = makeCtx();
    const targets = (ctx as any).buildIndexTargets('/repo');
    expect(targets).toHaveLength(1);
    expect(targets[0].modelId).toBe('qwen3-embedding-8b');
    expect(targets[0].collectionName).toBe('claude_context_own');
    expect(targets[0].embedding).toBe(ctx.getEmbedding());
    expect(targets[0].isHybrid).toBe(true);
    delete process.env.MILVUS_COLLECTION_PRIVATE;
  });

  it('dual-model: two targets, primary first; secondary has _0p6b + secondary instance', () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const ctx = makeCtx({ secondary: true });
    const targets = (ctx as any).buildIndexTargets('/repo');
    expect(targets.map((t: any) => t.modelId)).toEqual(['qwen3-embedding-8b', 'qwen3-embedding-0.6b']);
    expect(targets[1].collectionName).toBe('claude_context_own_0p6b');
    expect(targets[1].embedding.getDimension()).toBe(1024);
    delete process.env.MILVUS_COLLECTION_PRIVATE;
  });
});
```

**Step 2 — Run, expect FAIL** (member `getCollectionNameForModel` / `buildIndexTargets` / ctor field absent):
`pnpm --filter @zilliz/claude-context-core test -- index-target`

**Step 3 — Implement (full source).** Quote the current ctor head you are editing first.

*Current ctor field block (verified `context.ts:132-153`):*
```typescript
export class Context {
    private embedding: Embedding;
    private vectorDatabase: VectorDatabase;
    ...
    constructor(config: ContextConfig = {}) {
        this.embedding = config.embedding || new OpenAIEmbedding({ ... });
        if (!config.vectorDatabase) { throw new Error('VectorDatabase is required. ...'); }
        this.vectorDatabase = config.vectorDatabase;
```

*Add to imports at the top of `context.ts` (after the existing `./embedding` import block, lines 6-13):*
```typescript
import {
    getModelSpec,
    DEFAULT_PRIMARY_MODEL_ID,
} from './embedding/model-registry';
```

*Add the optional secondary to `ContextConfig` (currently lines 93-102) — full replacement:*
```typescript
export interface ContextConfig {
    embedding?: Embedding;
    /**
     * Optional secondary embedding instance (dual-embedding, Option B). When
     * present, indexing dual-targets a second per-model collection (LD-2/LD-5).
     * Constructed by the MCP factory ONLY when the secondary is configured;
     * absence ⇒ single-model byte-identical path.
     */
    secondaryEmbedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    includeDotDirs?: string[]; // Dot-prefixed directories to include in indexing
}
```

*Add the `IndexTarget` interface immediately after the `BatchOutcome` interface (currently ends at line 130):*
```typescript
/**
 * A single (model × collection × embedding-instance) target for the inner index
 * loop (Option B — one collection per model). The outer Merkle scan + AST split
 * runs ONCE; each IndexTarget then embeds the already-split chunks with its own
 * embedding instance and upserts to its own collection. (LD-5.)
 *
 *  - modelId        — canonical registry id; ALSO the per-model ledger key.
 *  - collectionName — resolved via getCollectionNameForModel (suffix '' ⇒ the
 *                     literal primary name, byte-identical to today).
 *  - embedding      — this target's Embedding instance (its getDimension() is the
 *                     expectedDim for the rogue-dimension guard AND the source of
 *                     embedBatchPartial — M7).
 *  - isHybrid       — process-wide getIsHybrid(); both targets share the same
 *                     sparse_vector shape so the 0.6B collection inherits hybrid
 *                     (M6 / R3-HYBRID-SPARSE).
 *  - priorLedger    — per-model completeness ledger captured at run start (the
 *                     resume read, M8). Keyed by relativePath. undefined ⇒ empty.
 *  - existingHashes — per-collection relativePath→fileHash loaded from Milvus
 *                     (M8). Populated by processFileList before the file loop.
 */
interface IndexTarget {
    modelId: string;
    collectionName: string;
    embedding: Embedding;
    isHybrid: boolean;
    priorLedger?: Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>;
    existingHashes?: Map<string, string>;
}
```

*Wire the secondary into the ctor (replace the `this.embedding = ...; if (!config.vectorDatabase)...; this.vectorDatabase = config.vectorDatabase;` head, lines 143-152):*
```typescript
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });

        // Optional secondary embedding instance (dual-embedding, Option B / LD-2).
        // undefined when no secondary is configured ⇒ buildIndexTargets() returns a
        // single target ⇒ the index/delete path is byte-identical to single-model.
        this.secondaryEmbedding = config.secondaryEmbedding;

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;
```

*Add the field declaration next to `private embedding: Embedding;` (line 133):*
```typescript
    private embedding: Embedding;
    private secondaryEmbedding?: Embedding;
```

*Add the resolver + builder immediately after `getWritableSharedCollectionName` (currently ends at line 308):*
```typescript
    /**
     * Resolve the Milvus collection name for a specific embedding model
     * (Option B — one collection per model). Mirrors the MILVUS_COLLECTION_PRIVATE
     * override pattern in getCollectionName.
     *
     *  - Primary (collectionSuffix === '') ⇒ the EXISTING getCollectionName result,
     *    byte-identical to single-model today (LD-3).
     *  - Secondary ⇒ MILVUS_COLLECTION_PRIVATE_0P6B verbatim if set, else
     *    base + registry suffix (e.g. claude_context_own ⇒ claude_context_own_0p6b).
     *  - Unknown model id ⇒ getModelSpec throws (fail-closed, LD-1).
     */
    public getCollectionNameForModel(codebasePath: string, modelId: string): string {
        const spec = getModelSpec(modelId);
        if (spec.collectionSuffix === '') {
            return this.getCollectionName(codebasePath);
        }
        const override = envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B');
        if (override) {
            return override;
        }
        return this.getCollectionName(codebasePath) + spec.collectionSuffix;
    }

    /**
     * Build the per-run IndexTarget array (the SHARED owner used by
     * prepareCollection, processFileList, the per-target delete, and the syncer —
     * Residual-Risk-1's "one IndexTarget-array builder").
     *
     * Always emits the primary (8B) target FIRST = { DEFAULT_PRIMARY_MODEL_ID,
     * getCollectionName, this.embedding }. When a secondary embedding instance is
     * configured, appends the 0.6B target { secondary model id, *_0p6b,
     * this.secondaryEmbedding }. The writable-shared collection is NOT a target
     * here — it is handled inside the primary target's upsert path only when
     * MILVUS_WRITABLE_SHARED is set AND the target is the primary (see M7's upsert
     * loop) — so a 1024-dim 0.6B vector is never written into the 4096-dim shared
     * space.
     *
     * Single-model ⇒ length 1, collectionName === getCollectionName(path),
     * embedding === this.embedding ⇒ the whole inner loop is byte-identical.
     */
    private buildIndexTargets(codebasePath: string): IndexTarget[] {
        const isHybrid = this.getIsHybrid();
        const targets: IndexTarget[] = [{
            modelId: DEFAULT_PRIMARY_MODEL_ID,
            collectionName: this.getCollectionNameForModel(codebasePath, DEFAULT_PRIMARY_MODEL_ID),
            embedding: this.embedding,
            isHybrid,
        }];
        if (this.secondaryEmbedding) {
            const secId = envManager.get('RABBITMQ_SECONDARY_MODEL') || 'qwen3-embedding-0.6b';
            targets.push({
                modelId: secId,
                collectionName: this.getCollectionNameForModel(codebasePath, secId),
                embedding: this.secondaryEmbedding,
                isHybrid,
            });
        }
        return targets;
    }
```

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`. Step 6 — Commit** `feat(core): IndexTarget + getCollectionNameForModel resolver + buildIndexTargets (LD-3/LD-5)`.

> **RISK (cross-cluster):** `secondaryEmbedding` must be constructed and passed by the MCP factory (Cluster D / Phase 4 Task 4.1). Until then, `buildIndexTargets` always returns one target ⇒ this task ships safely with zero behavior change. The `RABBITMQ_SECONDARY_MODEL` env key is defined by Phase 0 Task 0.2 (Cluster A); if absent it defaults to `'qwen3-embedding-0.6b'`.

---

#### Task 2.1 (M6): per-target `prepareCollection`

**Current signature & body anchor (verified `context.ts:777`):**
```typescript
private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
    const isHybrid = this.getIsHybrid();
    ...
    const collectionName = this.getCollectionName(codebasePath);
    const collectionExists = await this.vectorDatabase.hasCollection(collectionName);
    ... drop-if-force ...
    const dimension = await this.embedding.detectDimension();
    if (isHybrid === true) { await this.vectorDatabase.createHybridCollection(collectionName, dimension, ...); }
    else { await this.vectorDatabase.createCollection(collectionName, dimension, ...); }
    // Also prepare writable shared collection if configured (dual-write support)  ← lines 810-825
    const writableShared = this.getWritableSharedCollectionName();
    if (writableShared && writableShared !== collectionName) { ... create ... }
}
```

**Files:** Modify `packages/core/src/context.ts` (`prepareCollection` ~777-826). Test: `packages/core/src/__tests__/prepare-collection-targets.test.ts` (unit).

**Step 1 — Failing test (asserts: secondary collection created at its OWN dim via `target.embedding.detectDimension()`; same hybrid branch; writable-shared still created once at primary dim):**

```typescript
// packages/core/src/__tests__/prepare-collection-targets.test.ts
import { Context } from '../context';

describe('prepareCollection per-target (M6)', () => {
  afterEach(() => {
    delete process.env.MILVUS_COLLECTION_PRIVATE;
    delete process.env.MILVUS_WRITABLE_SHARED;
  });

  function makeCtx(secondary: boolean) {
    const created: Array<{ name: string; dim: number; hybrid: boolean }> = [];
    const stubDb: any = {
      hasCollection: async () => false,
      createCollection: async (n: string, d: number) => { created.push({ name: n, dim: d, hybrid: false }); },
      createHybridCollection: async (n: string, d: number) => { created.push({ name: n, dim: d, hybrid: true }); },
      dropCollection: async () => {},
    };
    const mk = (dim: number, prov: string) => ({
      getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
      embed: async () => ({ vector: [], dimension: dim }), embedBatchPartial: async () => [],
    });
    const ctx = new Context({
      vectorDatabase: stubDb, embedding: mk(4096, 'p') as any,
      ...(secondary ? { secondaryEmbedding: mk(1024, 's') as any } : {}),
    });
    (ctx as any).getIsHybrid = () => true;
    return { ctx, created };
  }

  it('creates BOTH collections, secondary at dim 1024, same hybrid branch', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const { ctx, created } = makeCtx(true);
    await (ctx as any).prepareCollection('/repo', false);
    const byName = Object.fromEntries(created.map(c => [c.name, c]));
    expect(byName['claude_context_own']).toMatchObject({ dim: 4096, hybrid: true });
    expect(byName['claude_context_own_0p6b']).toMatchObject({ dim: 1024, hybrid: true });
  });

  it('single-model: only the primary collection is created (byte-identical)', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const { ctx, created } = makeCtx(false);
    await (ctx as any).prepareCollection('/repo', false);
    expect(created.map(c => c.name)).toEqual(['claude_context_own']);
  });

  it('writable-shared is created ONCE at the primary dim (not duplicated per target)', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
    const { ctx, created } = makeCtx(true);
    await (ctx as any).prepareCollection('/repo', false);
    const shared = created.filter(c => c.name === 'dev_infra_shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].dim).toBe(4096);
  });
});
```

**Step 2 — Run, expect FAIL** (secondary collection never created).

**Step 3 — Full corrected `prepareCollection`:**

```typescript
    /**
     * Prepare vector collection(s) — one per active IndexTarget (M6, Option B).
     *
     * For each target: hasCollection(target.collectionName); if missing, create
     * with target.embedding.detectDimension() (4096 for 8B, 1024 for 0.6B) using
     * the SAME hybrid/non-hybrid branch — the secondary inherits the process-wide
     * getIsHybrid(), so the _0p6b collection gets the same sparse_vector shape and
     * per-target hybrid upsert populates the sparse field (R3-HYBRID-SPARSE).
     *
     * Writable-shared (MILVUS_WRITABLE_SHARED) is prepared ONCE at the PRIMARY
     * target's dimension only — a 1024-dim 0.6B vector must never be written into
     * the 4096-dim shared space (M5/M6 dimension-lock).
     *
     * Single-model ⇒ targets.length === 1 ⇒ the create path is byte-identical.
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        const targets = this.buildIndexTargets(codebasePath);
        const dirName = path.basename(codebasePath);

        for (const target of targets) {
            console.log(`[Context] 🔧 Preparing ${collectionType} collection '${target.collectionName}' for model ${target.modelId}${forceReindex ? ' (FORCE REINDEX)' : ''}`);

            const collectionExists = await this.vectorDatabase.hasCollection(target.collectionName);

            if (collectionExists && !forceReindex) {
                console.log(`📋 Collection ${target.collectionName} already exists, skipping creation`);
                continue;
            }

            if (collectionExists && forceReindex) {
                console.log(`[Context] 🗑️  Dropping existing collection ${target.collectionName} for force reindex...`);
                await this.vectorDatabase.dropCollection(target.collectionName);
                console.log(`[Context] ✅ Collection ${target.collectionName} dropped successfully`);
            }

            console.log(`[Context] 🔍 Detecting embedding dimension for ${target.embedding.getProvider()} provider (model ${target.modelId})...`);
            const dimension = await target.embedding.detectDimension();
            console.log(`[Context] 📏 Detected dimension: ${dimension} for ${target.embedding.getProvider()}`);

            if (target.isHybrid === true) {
                await this.vectorDatabase.createHybridCollection(target.collectionName, dimension, `codebasePath:${codebasePath}`);
            } else {
                await this.vectorDatabase.createCollection(target.collectionName, dimension, `codebasePath:${codebasePath}`);
            }
            console.log(`[Context] ✅ Collection ${target.collectionName} created successfully (dimension: ${dimension})`);
        }

        // Writable shared collection (dual-write) — prepared ONCE at the PRIMARY
        // target's dimension. The primary is targets[0] by construction.
        const primary = targets[0];
        const writableShared = this.getWritableSharedCollectionName();
        if (writableShared && writableShared !== primary.collectionName) {
            const sharedExists = await this.vectorDatabase.hasCollection(writableShared);
            if (!sharedExists) {
                const dimension = await primary.embedding.detectDimension();
                console.log(`[Context] 🔧 Also preparing writable shared collection: ${writableShared} (dim ${dimension})`);
                if (isHybrid === true) {
                    await this.vectorDatabase.createHybridCollection(writableShared, dimension, `Shared hybrid index (writable from ${dirName})`);
                } else {
                    await this.vectorDatabase.createCollection(writableShared, dimension, `Shared index (writable from ${dirName})`);
                }
                console.log(`[Context] ✅ Shared collection ${writableShared} created successfully`);
            } else {
                console.log(`[Context] 📋 Shared collection ${writableShared} already exists, will dual-write during indexing`);
            }
        }
    }
```

**Step 4 — Run, expect PASS. Step 5 — `pnpm typecheck`. Step 6 — Commit** `feat(core): per-target prepareCollection creates _0p6b at dim 1024 (M6)`.

> **D5 live gate (Phase 6, after this lands):** `describeCollection('claude_context_own_0p6b')` → parsed `dim===1024`, `metric==='COSINE'`. Assert parsed fields, never substring.

---

#### Task 2.2 (M7 + N4): `processChunkBatch` / `processChunkBuffer` TAKE an `IndexTarget`

This is the feature's largest rewrite. **Atomic change:** the signature plus the two embedding read sites (1267 dim-guard, 1294 embed) plus the upsert collection read (1364-1365) plus the residual inline writable-shared upsert (1380-1382/1385-1387 — P1) all move in one commit.

**Current signatures (verified):**
- `private async processChunkBuffer(chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>): Promise<BatchOutcome>` — line **1233**
- `private async processChunkBatch(items: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>): Promise<BatchOutcome>` — line **1262**
- `const expectedDim = this.embedding.getDimension();` — line **1267**
- `results = await this.embedding.embedBatchPartial(items.map(it => it.chunk.content));` — line **1294**
- `const collectionName = this.getCollectionName(codebasePath); const writableShared = this.getWritableSharedCollectionName();` — lines **1364-1365**
- inline writable-shared upserts at **1380-1382** (hybrid) and **1385-1387** (non-hybrid)

**Files:** Modify `packages/core/src/context.ts`. Test: `packages/core/src/__tests__/process-chunk-batch-target.test.ts` (unit) + covered by the Phase-2 int test (Task 2.4).

**Step 1 — Failing test (proves: `expectedDim` comes from `target.embedding`, embed comes from `target.embedding`, upsert goes to `target.collectionName`, and NO inline writable-shared double-write):**

```typescript
// packages/core/src/__tests__/process-chunk-batch-target.test.ts
import { Context } from '../context';
import { CodeChunk } from '../splitter';

function chunk(fp: string, content: string): CodeChunk {
  return { content, metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } };
}

describe('processChunkBatch(target, items) (M7 + P1)', () => {
  function makeCtx() {
    const upserts: Array<{ collection: string; count: number }> = [];
    const stubDb: any = {
      hasCollection: async () => false,
      upsert: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
      upsertHybrid: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
    };
    const ctx = new Context({ vectorDatabase: stubDb,
      embedding: { getDimension: () => 4096, getProvider: () => 'p', detectDimension: async () => 4096,
        embed: async () => ({ vector: [], dimension: 4096 }), embedBatchPartial: async () => [] } as any });
    (ctx as any).getIsHybrid = () => true;
    return { ctx, upserts };
  }

  it('uses target.embedding dim for the rogue-dimension guard (1024 passes, no rogue REAL)', async () => {
    const { ctx, upserts } = makeCtx();
    const target = {
      modelId: 'qwen3-embedding-0.6b', collectionName: 'claude_context_own_0p6b', isHybrid: true,
      embedding: {
        getDimension: () => 1024,
        // return a 1024-length vector for every slot
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(1024).fill(0.01), dimension: 1024 })),
      },
    };
    const items = [{ chunk: chunk('/repo/a.ts', 'x'), codebasePath: '/repo', relativePath: 'a.ts' }];
    const outcome = await (ctx as any).processChunkBatch(target, items);
    expect(outcome.realFailures).toBe(0);   // proves expectedDim was rewired to 1024
    expect(outcome.successes).toBe(1);
    expect(upserts).toEqual([{ collection: 'claude_context_own_0p6b', count: 1 }]); // P1: NO shared double-write
  });

  it('a 4096 vector against a 1024 target is a rogue-dimension REAL (proves guard reads target)', async () => {
    const { ctx } = makeCtx();
    const target = {
      modelId: 'qwen3-embedding-0.6b', collectionName: 'claude_context_own_0p6b', isHybrid: true,
      embedding: {
        getDimension: () => 1024,
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(4096).fill(0.01), dimension: 4096 })),
      },
    };
    const items = [{ chunk: chunk('/repo/a.ts', 'x'), codebasePath: '/repo', relativePath: 'a.ts' }];
    const outcome = await (ctx as any).processChunkBatch(target, items);
    expect(outcome.realFailures).toBe(1);
    expect(outcome.successes).toBe(0);
  });
});
```

**Step 2 — Run, expect FAIL** (arity mismatch — current `processChunkBatch` takes only `items`).

**Step 3 — Full corrected source.**

*`processChunkBuffer` — full replacement (now takes the target and forwards it):*
```typescript
    /**
     * Process accumulated chunk buffer for a SINGLE IndexTarget (M7). Forwards
     * the FULL tuple plus the target to processChunkBatch and returns its
     * BatchOutcome so per-file accounting survives. Does NOT throw for per-slot
     * embedding faults — those are classified inside the returned outcome.
     */
    private async processChunkBuffer(
        target: IndexTarget,
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>,
    ): Promise<BatchOutcome> {
        if (chunkBuffer.length === 0) {
            return { perFile: new Map(), realFailures: 0, waitFailures: 0, successes: 0 };
        }

        const estimatedTokens = chunkBuffer.reduce(
            (sum, item) => sum + Math.ceil(item.chunk.content.length / 4),
            0,
        );

        const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 [${target.modelId}] Processing batch of ${chunkBuffer.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        return this.processChunkBatch(target, chunkBuffer);
    }
```

*`processChunkBatch` — full replacement (target-driven expectedDim, embed, upsert; residual inline writable-shared upsert DELETED per P1):*
```typescript
    /**
     * Process a batch of chunks for ONE IndexTarget with partial-tolerant
     * embedding (M7 + P1).
     *
     * Reads target.embedding for BOTH the expectedDim rogue-dimension guard AND
     * embedBatchPartial, and target.collectionName for the upsert. The
     * BatchOutcome / REAL-vs-WAIT classification is unchanged and is per target,
     * so the three-way abort counter is evaluated per target by the caller
     * (per-target abort isolation: an 8B REAL-abort throws only inside the 8B
     * target's loop; the 0.6B pass runs in its own loop iteration — see
     * processFileList M7/M8). The residual inline writable-shared upsert is GONE:
     * writable-shared is written ONLY as its own same-instance IndexTarget (added
     * in processFileList's target list when MILVUS_WRITABLE_SHARED is set on the
     * primary), so a chunk is never double-written into one collection (P1 — else
     * duplicate-PK).
     */
    private async processChunkBatch(
        target: IndexTarget,
        items: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>,
    ): Promise<BatchOutcome> {
        const isHybrid = target.isHybrid;
        const codebasePath = items[0].codebasePath;
        const expectedDim = target.embedding.getDimension();

        const perFile = new Map<string, { produced: number; inserted: number }>();
        const bump = (rp: string, key: 'produced' | 'inserted', n = 1) => {
            const cur = perFile.get(rp) || { produced: 0, inserted: 0 };
            cur[key] += n;
            perFile.set(rp, cur);
        };

        for (const item of items) {
            bump(item.relativePath, 'produced');
        }

        let realFailures = 0;
        let waitFailures = 0;

        let results: EmbedItemResult[];
        try {
            results = await target.embedding.embedBatchPartial(items.map(it => it.chunk.content));
        } catch (embedErr) {
            console.error(
                `[Context] ❌ [${target.modelId}] Whole-batch embed failed (REAL): ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
            );
            return { perFile, realFailures: items.length, waitFailures: 0, successes: 0 };
        }

        const docs: VectorDocument[] = [];
        const docItems: Array<{ relativePath: string }> = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const res = results[i];

            if (res && res.ok === true) {
                if (!Array.isArray(res.vector) || res.vector.length !== expectedDim) {
                    console.error(
                        `[Context] ❌ [${target.modelId}] Rogue dimension on ok slot ${i}: got ${res.vector?.length}, expected ${expectedDim} (bad-dimension, REAL)`,
                    );
                    realFailures++;
                    continue;
                }

                const chunk = item.chunk;
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${i}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                const doc: VectorDocument = {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content,
                    vector: res.vector,
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: i
                    }
                };
                docs.push(doc);
                docItems.push({ relativePath: item.relativePath });
            } else {
                const reason: EmbedReason = res && res.ok === false ? res.reason : 'worker-error';
                if (REAL_REASONS.has(reason)) {
                    realFailures++;
                } else {
                    waitFailures++;
                }
            }
        }

        let successes = 0;

        if (docs.length > 0) {
            try {
                // Idempotent native upsert into THIS target's collection only.
                // (P1: no inline writable-shared dual-write here — writable-shared
                // is its own IndexTarget when configured.)
                if (isHybrid === true) {
                    await this.vectorDatabase.upsertHybrid(target.collectionName, docs);
                } else {
                    await this.vectorDatabase.upsert(target.collectionName, docs);
                }
                for (const di of docItems) {
                    bump(di.relativePath, 'inserted');
                    successes++;
                }
            } catch (insertError) {
                console.error(`[Context] ❌ [${target.modelId}] Upsert failed for batch (${docs.length} docs) into ${target.collectionName}, counting as REAL insert-error:`, insertError);
                realFailures += docs.length;
            }
        }

        return { perFile, realFailures, waitFailures, successes };
    }
```

> **P1 writable-shared as its own target.** The deleted inline dual-write is replaced by appending a writable-shared `IndexTarget` to `buildIndexTargets` when `MILVUS_WRITABLE_SHARED` is set. **Update `buildIndexTargets` (Task 2.0) to append it after the primary, before the secondary**, so its dimension is the primary's and it is written exactly once:
> ```typescript
>         // Writable-shared as its own SAME-INSTANCE target (P1 — replaces the
>         // deleted inline dual-write). Same embedding instance + same dimension
>         // as the primary, so no extra embedding cost and no dim mismatch.
>         const writableShared = this.getWritableSharedCollectionName();
>         if (writableShared && writableShared !== targets[0].collectionName) {
>             targets.push({
>                 modelId: DEFAULT_PRIMARY_MODEL_ID,        // shares the 8B ledger key intentionally? NO — see note
>                 collectionName: writableShared,
>                 embedding: this.embedding,
>                 isHybrid,
>             });
>         }
> ```
> **Ledger-key caveat (must resolve in Task 2.0):** two targets cannot share `modelId` as the ledger key, or the second clobbers the first's per-model ledger. Give the writable-shared target a distinct synthetic ledger key (e.g. `modelId: '__writable_shared__'`) **but** route its embedding/dim from the primary. Its ledger is write-only bookkeeping (resume for the shared collection is best-effort, matching the pre-existing pessimistic dual-write semantics noted at the old `context.ts:1371-1377`). Add a unit assertion in Task 2.0's test: with `MILVUS_WRITABLE_SHARED` set, `buildIndexTargets` returns primary + `__writable_shared__` and their `collectionName`s differ while `embedding` is identical.

**Step 4 — Run, expect PASS. Step 5 — `pnpm typecheck`. Step 6 — Commit** `feat(core): processChunkBatch/Buffer take IndexTarget; drop inline shared upsert (M7, P1)`.

---

#### Task 2.3 (M8): per-target resume-skip + per-target loops in `processFileList`

**Overrides LD-5's "any disagreement → re-process ALL targets".** A file is **AST-split once** iff **any** target needs it, but **embed+upsert only the targets that individually disagree**. All-or-nothing would re-embed the entire 8B corpus on every 0.6B backfill (defeats LD-0/LD-10).

**Current signature & anchors (verified):**
- `processFileList(filePaths, codebasePath, onFileProcessed?, onFileComplete?, priorLedger?)` — line **910**
- single `existingHashes = await this.loadExistingFileHashes(collectionName)` — line **935**
- resume-skip `if (existingHash === fileHash && led?.complete === true && led.fileHash === fileHash)` — line **997**
- delete-on-change `if (existingHash && existingHash !== fileHash)` — line **1015** (moved to Phase 3)
- batch flush `r = await this.processChunkBuffer(chunkBuffer)` — line **1072** (mid) and **1132** (final)
- `onFileComplete(rp, {...})` ledger writes — **976, 1003, 1168**

**New `processFileList` signature** — must accept **per-target prior ledgers** (a `Map<modelId, ledger>`), not a single `priorLedger`. The single-arg form is kept by `_indexCodebaseImpl` building the map from the one `priorLedger` it receives (Task 3.4 handler change supplies the per-target map).

**Files:** Modify `packages/core/src/context.ts` (`processFileList` ~910-1186; and `_indexCodebaseImpl` ~344-412 to pass a per-target priorLedger map + per-target `onFileComplete`). Test: `packages/core/src/__tests__/resume-skip-per-target.int.test.ts`.

**Design (full source replaces the body of `processFileList`):** The key structural change is: the **outer file loop stays single-pass** (one hash compute, one read, one AST split per file), but inside it we **decide per target** whether that target needs the file, accumulate **per-target chunk buffers**, and flush each target's buffer through `processChunkBatch(target, buf)` with a **per-target** consecutive-error counter + per-target `fileProgress`/`fileChunkTotals`/`firedComplete`. The `onFileComplete` callback gains a `modelId` argument so the snapshot writes per-model (Task 3.4 wires it to `setFileCompleteForModel`).

```typescript
    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>,
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const EMBEDDING_BATCH_SIZE = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10));
        const CHUNK_LIMIT = 450000;
        const MAX_CONSECUTIVE_BATCH_ERRORS = Math.max(
            1,
            parseInt(envManager.get('INDEX_MAX_CONSECUTIVE_ERRORS') || '3', 10),
        );
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        // ── Build the per-run targets and hydrate each with its OWN existingHashes
        //    (loadExistingFileHashes is already collection-parameterized, ~880) and
        //    its OWN priorLedger (M8 — per-(codebase × model) resume state). ──
        const targets = this.buildIndexTargets(codebasePath);
        for (const target of targets) {
            target.existingHashes = await this.loadExistingFileHashes(target.collectionName);
            target.priorLedger = priorLedgersByModel?.get(target.modelId) ?? new Map();
        }

        // Per-target accounting (M8 — each target tracks its own progress so
        // completeness is per (file × model)).
        type Acc = {
            fileChunkTotals: Map<string, number>;
            fileProgress: Map<string, { produced: number; inserted: number }>;
            fileHashByPath: Map<string, string>;
            firedComplete: Set<string>;
            buffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>;
            consecutiveBatchErrors: number;
        };
        const acc = new Map<string, Acc>();
        for (const t of targets) {
            acc.set(t.modelId, {
                fileChunkTotals: new Map(), fileProgress: new Map(), fileHashByPath: new Map(),
                firedComplete: new Set(), buffer: [], consecutiveBatchErrors: 0,
            });
        }

        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let skippedAllTargets = 0;
        let changedAnyTarget = 0;

        // Fire complete:true for files whose FULL splitter output has been embedded
        // AND inserted FOR A GIVEN TARGET. Per target (M8).
        const fireCompletedFor = (target: IndexTarget) => {
            if (!onFileComplete) return;
            const a = acc.get(target.modelId)!;
            for (const [rp, p] of a.fileProgress) {
                if (a.firedComplete.has(rp)) continue;
                const total = a.fileChunkTotals.get(rp);
                if (total !== undefined && p.produced === p.inserted && p.produced === total) {
                    onFileComplete(target.modelId, rp, { complete: true, fileHash: a.fileHashByPath.get(rp) ?? '', chunkCount: p.inserted });
                    a.firedComplete.add(rp);
                }
            }
        };

        // Flush one target's buffer through processChunkBatch with that target's
        // OWN three-way abort counter. Per-target abort isolation: a REAL-abort in
        // the 8B target throws ONLY here for the 8B target; the 0.6B target's flush
        // (separate call) is unaffected and vice versa (M7). The thrown abort is
        // the SAME __isIndexAbort sentinel so the outer per-file catch re-throws it.
        const flushTarget = async (target: IndexTarget, isFinal: boolean) => {
            const a = acc.get(target.modelId)!;
            if (a.buffer.length === 0) return;
            const r = await this.processChunkBuffer(target, a.buffer);
            a.buffer = [];
            this.mergeFileProgress(a.fileProgress, r.perFile);
            fireCompletedFor(target);
            if (r.realFailures > 0) {
                a.consecutiveBatchErrors++;
                const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
                console.error(
                    `[Context] ❌ [${target.modelId}] ${isFinal ? 'Final ' : ''}chunk batch for ${searchType} had ${r.realFailures} ` +
                    `REAL-class slot failure(s) (${a.consecutiveBatchErrors}/${MAX_CONSECUTIVE_BATCH_ERRORS} consecutive)`,
                );
                if (a.consecutiveBatchErrors >= MAX_CONSECUTIVE_BATCH_ERRORS) {
                    throw this.makeAbortError(MAX_CONSECUTIVE_BATCH_ERRORS);
                }
            } else if (r.successes > 0) {
                a.consecutiveBatchErrors = 0;
            }
            // pure WAIT-class: neutral.
        };

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];
            try {
                const relativePath = path.relative(codebasePath, filePath);
                const fileHash = await this.computeFileHash(filePath);

                // ── Per-target skip decision (M8) ──
                // A target "needs" the file unless Milvus has it at this hash AND
                // that target's ledger says complete:true at the SAME hash.
                const needers: IndexTarget[] = [];
                for (const target of targets) {
                    const existingHash = target.existingHashes!.get(relativePath);
                    const led = target.priorLedger!.get(relativePath);
                    const verifiedComplete = existingHash === fileHash && led?.complete === true && led.fileHash === fileHash;
                    if (verifiedComplete) {
                        // Re-fire so the per-model ledger entry survives this run's
                        // snapshot rewrite (P46, now per target).
                        onFileComplete?.(target.modelId, relativePath, { complete: true, fileHash, chunkCount: led!.chunkCount ?? 0 });
                        acc.get(target.modelId)!.firedComplete.add(relativePath);
                    } else {
                        needers.push(target);
                    }
                }

                if (needers.length === 0) {
                    // Every target already has this file complete at this hash.
                    skippedAllTargets++;
                    processedFiles++;
                    onFileProcessed?.(filePath, i + 1, filePaths.length);
                    continue;
                }
                changedAnyTarget++;

                // ── Per-target delete-on-change (Phase 3 / LD-6 / P1) ──
                // Each NEEDING target deletes from its OWN collection only when its
                // OWN existingHash !== fileHash. (Inserted here in Phase 3 Task 3.1;
                // see that task for the full delete block.)
                await this.deleteChangedForTargets(needers, relativePath, fileHash, onFileComplete);

                // ── AST split ONCE (model-independent) ──
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);

                // Record per-target totals/hash ONLY for needing targets, and inject
                // fileHash into each chunk's metadata (model-blind; both targets reuse
                // the same chunk objects — embedBatchPartial only reads .content).
                for (const chunk of chunks) {
                    chunk.metadata = { ...chunk.metadata, fileHash };
                }
                for (const target of needers) {
                    const a = acc.get(target.modelId)!;
                    a.fileChunkTotals.set(relativePath, chunks.length);
                    a.fileHashByPath.set(relativePath, fileHash);
                }

                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Push chunks into EACH needing target's buffer; flush per target
                // when that target's buffer fills. totalChunks counts splitter work
                // ONCE (chunk-limit guard is model-independent).
                for (const chunk of chunks) {
                    for (const target of needers) {
                        const a = acc.get(target.modelId)!;
                        a.buffer.push({ chunk, codebasePath, relativePath });
                        if (a.buffer.length >= EMBEDDING_BATCH_SIZE) {
                            await flushTarget(target, false);
                        }
                    }
                    totalChunks++;
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break;
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);
                if (limitReached) break;

            } catch (error) {
                if (this.isAbortError(error)) {
                    throw error;   // per-target abort still propagates to handlers.ts → indexfailed
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Final per-target buffer flush.
        for (const target of targets) {
            const a = acc.get(target.modelId)!;
            if (a.buffer.length > 0) {
                const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
                console.log(`📝 [${target.modelId}] Processing final batch of ${a.buffer.length} chunks for ${searchType}`);
                await flushTarget(target, true);
            }
        }

        // End-of-run completeness sweep, per target (covers 0-chunk files and
        // partial/truncated files; iterate fileChunkTotals not fileProgress).
        if (onFileComplete) {
            for (const target of targets) {
                const a = acc.get(target.modelId)!;
                for (const [rp, total] of a.fileChunkTotals) {
                    if (a.firedComplete.has(rp)) continue;
                    const p = a.fileProgress.get(rp) ?? { produced: 0, inserted: 0 };
                    const complete = p.produced === p.inserted && p.produced === total;
                    onFileComplete(target.modelId, rp, { complete, fileHash: a.fileHashByPath.get(rp) ?? '', chunkCount: p.inserted });
                    a.firedComplete.add(rp);
                }
            }
        }

        const anyExisting = targets.some(t => (t.existingHashes?.size ?? 0) > 0);
        if (anyExisting) {
            console.log(`[Context] 📊 Incremental indexing: ${skippedAllTargets} files complete in ALL targets (skipped), ${changedAnyTarget} files needed ≥1 target, ${filePaths.length - skippedAllTargets - changedAnyTarget} files new`);
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }
```

> **Notes baked in:**
> - **`onFileComplete` signature changed** to `(modelId, relativePath, info)`. `_indexCodebaseImpl` (Task 3.4 core side) and the handler (Task 3.4 mcp side) must adopt the new arity.
> - **`mergeFileProgress`, `makeAbortError`, `isAbortError` unchanged** (verified `context.ts:1194, 1211, 1223`).
> - **`deleteChangedForTargets`** is introduced in Phase 3 Task 3.1 (below). For a clean TDD sequence, **stub it as a no-op private method in this task** so `processFileList` compiles, then fill it in Phase 3:
>   ```typescript
>   // Phase-2 placeholder; full per-target delete-on-change lands in Phase 3 (LD-6).
>   private async deleteChangedForTargets(
>       _targets: IndexTarget[], _relativePath: string, _fileHash: string,
>       _onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
>   ): Promise<void> { /* no-op until Phase 3 Task 3.1 */ }
>   ```

**Also update `_indexCodebaseImpl`** to build the per-target prior-ledger map and forward the new `onFileComplete` arity. **Current call (verified `context.ts:379-396`):**
```typescript
const result = await this.processFileList(
    codeFiles, codebasePath,
    (filePath, fileIndex, totalFiles) => { ... progressCallback ... },
    onFileComplete,
    priorLedger
);
```
*Replacement — `_indexCodebaseImpl` now accepts `priorLedgersByModel` instead of a single `priorLedger`, and an `onFileComplete` with the modelId arity. Change its signature + `indexCodebase` wrapper accordingly (full source in Task 3.4 because the handler is the producer of the per-model map).*

**Failing test (`resume-skip-per-target.int.test.ts`)** — proves per-target unanimity skip and per-target re-embed:

```typescript
// packages/core/src/__tests__/resume-skip-per-target.int.test.ts
// Drives the REAL processFileList with two fake targets via buildIndexTargets.
import { Context } from '../context';
// ... build a Context with a primary (dim 4) + secondary (dim 4) embedding so
//     both targets are active; stub vectorDatabase.queryAll to return a prior
//     fileHash for one collection but NOT the other; pass priorLedgersByModel
//     with the 8B ledger complete for a.ts but the 0.6B ledger EMPTY.
// Assert:
//   - a.ts is split ONCE but embedded+upserted ONLY into the 0.6B collection
//     (8B already complete) — proves NOT all-or-nothing.
//   - onFileComplete fired (modelId='qwen3-embedding-8b', a.ts, complete:true) via re-fire
//     AND (modelId='qwen3-embedding-0.6b', a.ts, complete:true) after embed.
//   - a file complete in BOTH ledgers at the disk hash is skipped entirely (no upsert to either).
```

(Concrete fixture wiring uses the same `makeContext`/stubDb pattern as `context-completeness.test.ts:52-88`, with `queryAll` returning rows whose `metadata.fileHash` differs per collection.)

**Step 4 — Run, expect PASS. Step 5 — `pnpm typecheck`. Step 6 — Commit** `feat(core): per-target resume-skip (split once, embed only disagreeing targets) (M8)`.

---

#### Task 2.4 (D2): multi-target index integration test

**Files:** Test `packages/core/src/__tests__/multi-target-index.int.test.ts` (jest int; `pnpm --filter @zilliz/claude-context-core test:int`). No new production code.

**Asserts (the D2 contract + the M7 dim-rewire proof N4):**
1. Both collections receive **every** chunk (count upserts per collection name).
2. Each model's ledger reflects **only its own** completions (assert `onFileComplete` calls partitioned by `modelId`).
3. Resume-skip is per-target: a second run with one file changed re-embeds that file for **both** targets and skips the rest; a file complete in both ledgers is skipped entirely.
4. A 0.6B batch yields **1024-length vectors** with **zero rogue-dimension REAL failures** (proves `expectedDim` was rewired to `target.embedding` — N4).

**Skeleton:**
```typescript
// packages/core/src/__tests__/multi-target-index.int.test.ts
import { Context } from '../context';
import { CodeChunk } from '../splitter';

describe('multi-target index integration (D2)', () => {
  function makeDualContext() {
    const upserts: Array<{ collection: string; count: number }> = [];
    const stored = new Map<string, Set<string>>();   // collection -> set of PKs
    const stubDb: any = {
      hasCollection: async () => true,
      // queryAll returns prior fileHashes per collection (empty on first run)
      queryAll: async (_c: string) => [],
      query: async () => [],
      upsertHybrid: async (c: string, docs: any[]) => {
        upserts.push({ collection: c, count: docs.length });
        const s = stored.get(c) ?? new Set(); docs.forEach(d => s.add(d.id)); stored.set(c, s);
      },
      upsert: async (c: string, docs: any[]) => {
        upserts.push({ collection: c, count: docs.length });
        const s = stored.get(c) ?? new Set(); docs.forEach(d => s.add(d.id)); stored.set(c, s);
      },
      deleteByFilter: async () => {},
      createCollection: async () => {}, createHybridCollection: async () => {}, dropCollection: async () => {},
    };
    const mk = (dim: number, prov: string) => ({
      getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
      embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
      embedBatchPartial: async (t: string[]) =>
        t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
    });
    const ctx = new Context({
      vectorDatabase: stubDb, embedding: mk(4096, 'p') as any, secondaryEmbedding: mk(1024, 's') as any,
    });
    (ctx as any).getIsHybrid = () => true;
    // stub splitter to yield a deterministic chunk count per file
    (ctx as any).codeSplitter = { split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
      [{ content: 'x', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }] };
    return { ctx, upserts, stored };
  }

  it('both collections receive every chunk; ledgers are per-model; 0.6B has zero rogue-dim', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    const { ctx, upserts } = makeDualContext();
    const completions: Array<[string, string, boolean]> = [];   // [modelId, rp, complete]
    // Drive the private processFileList directly with a tiny file list + empty per-model ledgers.
    await (ctx as any).processFileList(
      ['/repo/a.ts', '/repo/b.ts'], '/repo',
      undefined,
      (modelId: string, rp: string, info: any) => completions.push([modelId, rp, info.complete]),
      new Map(),   // no prior ledgers ⇒ both targets need every file
    );
    const byCollection = upserts.reduce((m, u) => (m[u.collection] = (m[u.collection] ?? 0) + u.count, m), {} as Record<string, number>);
    expect(byCollection['claude_context_own']).toBe(2);       // every chunk
    expect(byCollection['claude_context_own_0p6b']).toBe(2);  // every chunk
    // per-model ledger: both files complete in both models
    expect(completions.filter(c => c[0] === 'qwen3-embedding-8b' && c[2]).map(c => c[1]).sort()).toEqual(['a.ts', 'b.ts']);
    expect(completions.filter(c => c[0] === 'qwen3-embedding-0.6b' && c[2]).map(c => c[1]).sort()).toEqual(['a.ts', 'b.ts']);
    delete process.env.MILVUS_COLLECTION_PRIVATE;
  });
});
```

**Step — Run `pnpm --filter @zilliz/claude-context-core test:int`, expect PASS. Commit** `test(core): D2 multi-target index integration (both collections, per-model ledger, 1024 no-rogue)`.

---

### Phase 3 — Per-target delete-on-change + second entry point (`_reindexByChangeImpl`) under IndexTarget

**Goal:** eliminate the split-brain orphan hazard; pair every delete abort with recovery (LD-6 / P1); bring the **second live entry point** (`sync.ts:158 → _reindexByChangeImpl`) under the same abstraction so `_0p6b` cannot desync on a user edit (P2).

#### Task 3.1 (LD-6 + P1): implement `deleteChangedForTargets` (per-target delete with `complete:false` recovery)

This replaces the Phase-2 no-op stub and removes the monolithic private + writable-shared delete that was at `context.ts:1015-1035`.

**Current monolithic delete (verified `context.ts:1015-1035`) — being REMOVED (it was already extracted out of `processFileList` in Phase 2 Task 2.3; this task fills the extracted method):**
```typescript
if (existingHash && existingHash !== fileHash) {
    changedFiles++;
    try {
        const escapedPath = relativePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await this.vectorDatabase.deleteByFilter(collectionName, `relativePath == "${escapedPath}"`);
        const writableShared = this.getWritableSharedCollectionName();
        if (writableShared && writableShared !== collectionName) {
            await this.vectorDatabase.deleteByFilter(writableShared, `relativePath == "${escapedPath}"`);
        }
        deletedChunkFiles++;
    } catch (delError) {
        console.warn(`[Context] ⚠️  Failed to delete old chunks for ${relativePath}: ${delError}`);  // ← silent warn (forbidden)
    }
}
```

**Files:** Modify `packages/core/src/context.ts` (`deleteChangedForTargets`). Test: `packages/core/src/__tests__/per-target-delete.int.test.ts`.

**Step 1 — Failing test (D3 asymmetric delete):**
```typescript
// packages/core/src/__tests__/per-target-delete.int.test.ts
// Two active targets. existingHashes differ from disk hash for BOTH ⇒ both delete.
// Stub the 0.6B target's deleteByFilter to THROW; assert:
//   - 8B target delete succeeded (no complete:false written for 8B by the delete path)
//   - 0.6B target's onFileComplete fired (modelId='qwen3-embedding-0.6b', rp, complete:false)
//     with chunkCount:0 — recovery, NOT a silent warn.
```

**Step 2 — Run, expect FAIL** (no-op stub fires nothing).

**Step 3 — Full source:**
```typescript
    /**
     * Per-target delete-on-change with recovery (LD-6 + P1). Called inside the
     * per-file loop for the NEEDING targets only. Each target deletes from its OWN
     * collection only when its OWN existingHash !== fileHash (a CHANGED file's PKs
     * rotate, orphaning the old rows). The writable-shared target (if present) is
     * just another IndexTarget here, so it deletes from the shared collection in
     * its own iteration — there is no monolithic private+shared delete (P1).
     *
     * On a target delete FAILURE: write a complete:false ledger entry for THAT
     * target so the next run re-sweeps that target (pair every abort with
     * recovery — no silent warn-and-continue). The other targets are unaffected.
     */
    private async deleteChangedForTargets(
        targets: IndexTarget[],
        relativePath: string,
        fileHash: string,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
    ): Promise<void> {
        const escapedPath = relativePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        for (const target of targets) {
            const existingHash = target.existingHashes?.get(relativePath);
            if (existingHash && existingHash !== fileHash) {
                try {
                    await this.vectorDatabase.deleteByFilter(
                        target.collectionName,
                        `relativePath == "${escapedPath}"`,
                    );
                    console.log(`[Context] 🗑️  [${target.modelId}] Deleted stale chunks for ${relativePath} from ${target.collectionName}`);
                } catch (delError) {
                    // Recovery, not silent warn: mark this file incomplete in THIS
                    // target's ledger so the next run re-embeds it for this target.
                    console.error(`[Context] ❌ [${target.modelId}] Delete-on-change FAILED for ${relativePath} in ${target.collectionName}; marking complete:false for recovery:`, delError);
                    onFileComplete?.(target.modelId, relativePath, { complete: false, fileHash, chunkCount: 0 });
                }
            }
        }
    }
```

**Step 4 — Run, expect PASS. Step 5 — `pnpm typecheck`. Step 6 — Commit** `fix(core): per-target delete-on-change with complete:false recovery; remove monolithic shared delete (LD-6, P1)`.

> **D3 caveat:** in the dual-target flow the 0.6B `complete:false` set by the delete-failure path will be **re-evaluated at end-of-run**: if that target later embeds+upserts the file successfully in the same run, the end-of-run sweep fires `complete:true` (correct — the delete failure was transient and the upsert overwrote by deterministic PK). The recovery semantics are durable only when the failure persists across the run. The D3 test stubs the delete to throw **and** stubs that target's upsert to also throw (so the file stays `complete:false`), matching LD-6's "next run re-sweeps."

---

#### Task 3.2 (P1 gate): distinct-PK == 1 for a known chunk

**Files:** Test `packages/core/src/__tests__/no-double-write.int.test.ts` (jest int).

Proves the residual inline writable-shared upsert is gone (P1): with `MILVUS_WRITABLE_SHARED` set, a known chunk's deterministic PK appears **exactly once** in the private collection and **exactly once** in the shared collection — never twice in either. Stub upserts capturing PK sets per collection; assert `stored.get(privateColl).size === chunkCount` and no PK collisions within a collection.

```typescript
it('no chunk is double-written into a single collection (P1 duplicate-PK guard)', async () => {
  process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
  process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
  // ... run processFileList over one file producing 3 chunks ...
  // assert: stored.get('claude_context_own').size === 3 (each PK once)
  //         stored.get('dev_infra_shared').size === 3
  //         total upsert *calls* into 'claude_context_own' inserted each PK at most once
  delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_WRITABLE_SHARED;
});
```

**Commit** `test(core): P1 distinct-PK==1 per collection (no inline shared double-write)`.

---

#### Task 3.3 (P2): bring `_reindexByChangeImpl` under `IndexTarget` (RECOMMENDED — it is small)

The syncer (`sync.ts:158` → `reindexByChange` → `_reindexByChangeImpl`, `context.ts:421`) is a **second live entry point**. Today it uses single-collection `getCollectionName` + `deleteFileChunks(collectionName, file)` + single-target `processFileList`. Left as-is, the first user edit after dual-indexing desyncs `_0p6b`.

**Current `_reindexByChangeImpl` anchors (verified):**
- `const collectionName = this.getCollectionName(codebasePath);` — line **425**
- synchronizer keyed by `collectionName` — **426, 435, 438** (the FileSynchronizer is content-hash based and model-independent; **key it by the primary collection name only** — it tracks the filesystem, not a model)
- removed/modified delete via `this.deleteFileChunks(collectionName, file)` — **461, 467**
- re-index via `this.processFileList(filesToIndex, codebasePath, cb)` — **475-481** (no `onFileComplete`/ledger today — the syncer path does not write the completeness ledger; with dual-targets we MUST thread per-model ledgers so resume stays correct)

**Files:** Modify `packages/core/src/context.ts` (`_reindexByChangeImpl` ~421-488; `deleteFileChunks` ~490 reused per target). Test: `packages/core/src/__tests__/reindex-by-change-targets.int.test.ts`.

**Step 1 — Failing test:** stub two collections; simulate one modified file; assert (a) stale chunks deleted from **both** `claude_context_own` and `claude_context_own_0p6b`, (b) new chunks upserted to **both**. Then a desync gate: after reindex, query `_0p6b` for the modified path's rows and assert **no stale-hash rows** remain (parsed `metadata.fileHash === newHash` for every returned row).

**Step 3 — Full corrected `_reindexByChangeImpl`:**
```typescript
    private async _reindexByChangeImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<{ added: number, removed: number, modified: number }> {
        const targets = this.buildIndexTargets(codebasePath);
        const primaryCollection = targets[0].collectionName;   // synchronizer key (filesystem-tracked, model-blind)
        const synchronizer = this.synchronizers.get(primaryCollection);

        if (!synchronizer) {
            await this.loadIgnorePatterns(codebasePath);
            const newSynchronizer = new FileSynchronizer(codebasePath, this.ignorePatterns, this.includeDotDirs, this.supportedExtensions);
            await newSynchronizer.initialize();
            this.synchronizers.set(primaryCollection, newSynchronizer);
        }
        const currentSynchronizer = this.synchronizers.get(primaryCollection)!;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0 };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        // Removed + modified files: delete stale chunks from EVERY target's
        // collection (P2 — else _0p6b keeps orphaned rows for the edited path).
        for (const file of removed) {
            for (const target of targets) {
                await this.deleteFileChunks(target.collectionName, file);
            }
            updateProgress(`Removed ${file}`);
        }
        for (const file of modified) {
            for (const target of targets) {
                await this.deleteFileChunks(target.collectionName, file);
            }
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Added + modified files: re-embed for ALL targets via processFileList.
        // Empty per-model prior ledgers ⇒ every target re-embeds the changed set
        // (we already deleted stale rows above; upsert is idempotent by PK). The
        // syncer does not persist the completeness ledger (snapshot writes happen
        // in the index path); pass a no-op onFileComplete so processFileList's new
        // arity is satisfied.
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));
        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => { updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`); },
                undefined,                 // syncer does not write the per-model ledger here
                new Map(),                 // empty per-model prior ledgers ⇒ re-embed the changed set for every target
            );
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return { added: added.length, removed: removed.length, modified: modified.length };
    }
```

> **`deleteFileChunks(collectionName, relativePath)` is unchanged** (verified `context.ts:490`) — it already takes a collection name, so per-target delete reuses it as-is.
>
> **Why empty prior-ledger is safe here:** with empty ledgers, every needing target re-splits and re-embeds the changed files; the stale rows were just deleted, and same-content chunks upsert idempotently by deterministic PK (LD-7). The syncer path intentionally does NOT consult the snapshot ledger (it operates on `FileSynchronizer`'s Merkle change set, which is the authority for *what changed*), so per-model resume-skip is a no-op here by design — both targets get the changed files.

**Step 4 — Run, expect PASS. Step 5 — `pnpm typecheck`. Step 6 — Commit** `fix(core): _reindexByChangeImpl is per-target (deletes+re-embeds both collections) (P2)`.

> **MVP-defer alternative (NOT recommended — listed for completeness per charter):** if P2 is deferred, the plan MUST hard-disable background sync while the secondary is configured (not silently single-model). Concretely, in `sync.ts startBackgroundSync` add at the top:
> ```typescript
> if (process.env.MILVUS_COLLECTION_PRIVATE_0P6B) {
>     console.error('[SYNC] Background sync DISABLED: secondary embedding configured but _reindexByChangeImpl is single-target (P2 deferred). Re-index manually to refresh both collections.');
>     return;
> }
> ```
> AND a binary gate (`packages/mcp/scripts/reindex-desync.test.mjs`, `.mjs`-against-`dist`) proving `_0p6b` is not silently desynced: index both, edit a file, run reindex, query `_0p6b`, assert (parsed PK + `metadata.fileHash`) that no stale-hash rows for that path survive — which under the deferral means the test asserts the **guard fired** (sync skipped) rather than rows refreshed. **The recommendation is to ship Task 3.3 and skip the deferral entirely** — the change above is small and removes the footgun (Residual-Risk-4).

---

#### Task 3.4 (M8 handler): build per-target prior ledgers in `handlers.ts` + adopt new `onFileComplete` arity

Without this, the 0.6B target's `priorLedger` is always empty ⇒ 0.6B **re-embeds fully on every MCP restart** (defeats LD-0/LD-10).

**Current handler resume read + index call (verified `handlers.ts:430-452`):**
```typescript
const priorLedger = this.snapshotManager.getFileLedger(absolutePath);
...
const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => { ... },
  (relativePath, info) => {
    this.snapshotManager.setFileComplete(absolutePath, relativePath, info);
  }, undefined /* forceReindex */, priorLedger);
```

**Files:** Modify `packages/mcp/src/handlers.ts` (~430, ~447-452); Modify `packages/core/src/context.ts` (`indexCodebase`/`_indexCodebaseImpl` signature: `priorLedger` → `priorLedgersByModel: Map<modelId, ledger>`, `onFileComplete` arity gains `modelId`). The per-model accessors `getFileLedgerForModel` / `setFileCompleteForModel` are produced by **Cluster A / Phase 1** (snapshot v3); this task only **consumes** them.

**Core side — `indexCodebase` + `_indexCodebaseImpl` signature change (full source of the changed heads):**

*Current (verified `context.ts:330-341`):*
```typescript
async indexCodebase(
    codebasePath: string,
    progressCallback?: (...) => void,
    onFileComplete?: (relativePath: string, info: {...}) => void,
    forceReindex: boolean = false,
    priorLedger?: Map<string, {...}>
): Promise<...> {
    return envManager.runWithProject(codebasePath, () => this._indexCodebaseImpl(codebasePath, progressCallback, onFileComplete, forceReindex, priorLedger));
}
```

*Replacement:*
```typescript
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        forceReindex: boolean = false,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        return envManager.runWithProject(codebasePath, () => this._indexCodebaseImpl(codebasePath, progressCallback, onFileComplete, forceReindex, priorLedgersByModel));
    }

    private async _indexCodebaseImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        forceReindex: boolean = false,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        // ... unchanged up to the processFileList call (lines 351-377) ...
        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                const progressPercentage = indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;
                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressCallback?.({ phase: `Processing files (${fileIndex}/${totalFiles})...`, current: fileIndex, total: totalFiles, percentage: Math.round(progressPercentage) });
            },
            onFileComplete,
            priorLedgersByModel
        );
        // ... unchanged tail ...
    }
```

**Handler side — full replacement of the resume-read + index call (`handlers.ts:423-452`):**
```typescript
            // Capture the per-MODEL prior-run completeness ledgers BEFORE indexing
            // mutates the live snapshot entry (M8 — the resume read, per target).
            // getFileLedgerForModel returns a COPY, so in-run setFileCompleteForModel
            // mutations don't perturb what the resume read sees. Building the map for
            // BOTH known models keeps the 0.6B target from re-embedding fully on every
            // MCP restart (R2-HANDLER-PRIORLEDGER).
            const priorLedgersByModel = new Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>();
            for (const modelId of ['qwen3-embedding-8b', 'qwen3-embedding-0.6b']) {
                priorLedgersByModel.set(modelId, this.snapshotManager.getFileLedgerForModel(absolutePath, modelId));
            }

            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) {
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }
                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, (modelId, relativePath, info) => {
                // Per-(file × model) completeness ledger (M8). Writes the 8B path
                // into the legacy top-level `files` (byte-identical) and the 0.6B
                // path into filesByModel[modelId] (snapshot v3, Cluster A).
                this.snapshotManager.setFileCompleteForModel(absolutePath, modelId, relativePath, info);
            }, undefined /* forceReindex — keep default */, priorLedgersByModel);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);
```

> **Cross-cluster contract (Cluster A must provide):** `SnapshotManager.getFileLedgerForModel(path, modelId): Map<...>` and `setFileCompleteForModel(path, modelId, relativePath, info): void`, where `modelId === 'qwen3-embedding-8b'` reads/writes the legacy top-level `files` (byte-identical single-model) and any other id reads/writes `filesByModel[modelId]`. These are exactly the accessors in Phase-1 Task 1.2 of the plan. If Cluster A is not yet merged, this task's handler edit will not typecheck — sequence Task 3.4 **after** Phase 1.

**Test:** `packages/core/src/__tests__/index-codebase-prior-ledger.int.test.ts` — call the **public** `indexCodebase` with a `priorLedgersByModel` map where the 8B ledger marks `a.ts` complete at the disk hash but the 0.6B ledger is empty; assert `a.ts` is upserted **only** into the `_0p6b` collection (8B skipped) — proving the per-model prior ledger is threaded end-to-end. (The handler edit itself is exercised indirectly; an MCP `.mjs` smoke is unnecessary because no JSON-RPC surface changed — `index_codebase` args are unchanged.)

**Step — Run, expect PASS. `pnpm typecheck && pnpm build:core && pnpm build:mcp`. Commit** `feat: thread per-model prior ledgers from handler into IndexTargets (M8 / R2-HANDLER-PRIORLEDGER)`.

---

### Phase 2/3 exit gate

`pnpm typecheck && pnpm build:core && pnpm build:mcp` exit 0; `pnpm --filter @zilliz/claude-context-core test` and `test:int` exit 0 (new tests counted); `node packages/mcp/dist/index.js --help` loads without writing to stdout. **Single-model byte-identity check (C1):** with no secondary configured, `buildIndexTargets` returns length 1 and the int test `multi-target-index` single-model variant asserts the only upsert collection is `getCollectionName(path)` and `onFileComplete` fires with `modelId==='qwen3-embedding-8b'` exclusively (writes to legacy `files`).

---

## Cluster C — Search / status / clear routing (M4, M5, P3, P4)

> **Charter scope.** This section authors **Phase 4 (search routing)** plus the **status/clear** slices that live in Phases 3–4. It **consumes** two symbols authored by **Cluster B (Phase 2)** and does **not** redefine them:
> - `Context.getCollectionNameForModel(codebasePath, modelId): string` (context.ts, near `getCollectionName` :279) — primary returns `getCollectionName`, secondary returns base+`_0p6b` or the `MILVUS_COLLECTION_PRIVATE_0P6B` override.
> - `interface IndexTarget { modelId: string; collectionName: string; embedding: Embedding; isHybrid: boolean; }` and the per-run targets-array builder.
>
> Cluster C **OWNS**: `getSharedCollectionNameForModel`, `getEmbeddingForModel`, `isModelReadable`, and the runtime coverage read (`getCoverageRatioForModel` on the snapshot + the degraded-notice branch). It also OWNS the secondary-embedding handle on `Context` (`secondaryEmbedding` ctor field) since search needs the query-vector instance even when no index run is in flight — Phase 4.1 (Cluster D, ctor wiring) and Cluster C agree the field name is `secondaryEmbedding` (see Risk R-C1).
>
> **Verified source anchors (read 2026-06-14, byte-checked):**
> - `context.ts:197` `getEmbedding(): Embedding`
> - `context.ts:279` `public getCollectionName(codebasePath: string): string`
> - `context.ts:295` `public getSharedCollectionName(): string | undefined`
> - `context.ts:306` `public getWritableSharedCollectionName(): string | undefined`
> - `context.ts:515` `async semanticSearch(codebasePath, query, topK=5, threshold=0.5, filterExpr?)`
> - `context.ts:520` `private async _semanticSearchImpl(codebasePath, query, topK=5, threshold=0.5, filterExpr?)`
> - `context.ts:526` `const sharedCollectionName = this.getSharedCollectionName();` … `:529-539` unconditional shared-arm append
> - `context.ts:558` (hybrid) `const queryEmbedding = await this.embedding.embed(query);`
> - `context.ts:581` `this.vectorDatabase.hybridSearch(collection, …)`
> - `context.ts:625` (non-hybrid) `const queryEmbedding = await this.embedding.embed(query);`
> - `context.ts:629` `this.vectorDatabase.search(collection, queryEmbedding.vector, …)`
> - `context.ts:685-707` `_clearIndexImpl` (drops only `getCollectionName`)
> - `handlers.ts:485` `public async handleSearchCode(args)`, `:486` `const { path: codebasePath, query, limit = 10, extensionFilter } = args;`
> - `handlers.ts:569-575` `this.context.semanticSearch(absolutePath, query, Math.min(resultLimit,50), 0.3, filterExpr)`
> - `handlers.ts:582` (no-results lost-collection check) `this.context.getCollectionName(absolutePath)`
> - `handlers.ts:777` `handleGetIndexingStatus`, `:816-836` `case 'indexed'` (checks only `getCollectionName`)
> - `index.ts:165-194` `search_code` tool def; `:193` `required: ["path","query"]`
> - `Embedding.embed(text): Promise<EmbeddingVector>` (`base-embedding.ts:97`), `getDimension(): number` (`:123`), `getProvider(): string` (`:129`); `RabbitMQEmbedding.getDimension()` returns its configured `dimension` (`rabbitmq-embedding.ts:349`).
> - `getModelSpec(id)` / `DEFAULT_PRIMARY_MODEL_ID` exported from `@zilliz/claude-context-core` via `core/src/index.ts` → `./embedding` → `model-registry` (Phase 0, Cluster A).
>
> **House test convention baked in:** core gets jest `__tests__/*.test.ts` (registry path `pnpm --filter @zilliz/claude-context-core test`); MCP gates are **`.mjs` runners under `packages/mcp/scripts/`** importing **compiled `dist/`**, exit-nonzero on first failed PARSED-object assertion, registered as a package script. Single-model behavior stays byte-identical when no secondary is configured.

---

### Phase 4 — Explicit search-model routing (M4 + M5)

**Goal:** make explicit per-request model selection real end-to-end (schema → handler → public `semanticSearch` → `_semanticSearchImpl` → query embedding + collection), and make the shared-collection arm dimension-safe so the **first** 0.6B search on a hybrid+shared project (the MVP target `claude-context`, strategy=hybrid, shared=`dev_infra_shared`) does not dim-mismatch.

> ⛔ **Gate inheritance:** Phase 1 keystone (snapshot v2-additive round-trip) must be green before this phase, because `isModelReadable` (Task 4.5/P3) and the coverage read (Task 4.6/P4) consume `getFileLedgerForModel`/`getCoverageRatioForModel` authored in Phase 1.

---

#### Task 4.0: `getSharedCollectionNameForModel` on `Context` (M5 producer — do this first)

The bug we are killing: `_semanticSearchImpl:526` calls `getSharedCollectionName()` (4096-dim `MILVUS_COLLECTION_SHARED`) and appends it to `collectionsToSearch` for **every** model. A 1024-dim 0.6B query vector ANN-searched against the 4096-dim shared space is a guaranteed dimension-mismatch on the first 0.6B search of any hybrid/shared project. Fix at the source: a model-aware resolver that returns `undefined` for any model lacking a **same-dim** shared collection.

**Files:**
- Modify: `packages/core/src/context.ts` (add method directly after `getSharedCollectionName` at :295–299).
- Test: `packages/core/src/__tests__/shared-collection-model.test.ts` (jest, hermetic).

**Step 1 — Write the failing test (full source):**

```typescript
// packages/core/src/__tests__/shared-collection-model.test.ts
import { Context } from '../context';
import { envManager } from '../utils/env-manager';

// Minimal VectorDatabase stub — getSharedCollectionNameForModel touches no DB,
// but Context's ctor requires a vectorDatabase instance.
const dbStub: any = { hasCollection: async () => true };

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

describe('getSharedCollectionNameForModel (M5)', () => {
  it('primary 8B returns the configured shared collection (hybrid strategy)', () => {
    withEnv({ MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
      const ctx = new Context({ vectorDatabase: dbStub });
      expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-8b')).toBe('dev_infra_shared');
    });
  });

  it('secondary 0.6B returns undefined even when a shared collection is configured', () => {
    withEnv({ MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
      const ctx = new Context({ vectorDatabase: dbStub });
      expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-0.6b')).toBeUndefined();
    });
  });

  it('primary 8B returns undefined under strategy=private (parity with getSharedCollectionName)', () => {
    withEnv({ MILVUS_STRATEGY: 'private', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
      const ctx = new Context({ vectorDatabase: dbStub });
      expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-8b')).toBeUndefined();
    });
  });

  it('throws on an unknown model id (registry SSOT)', () => {
    const ctx = new Context({ vectorDatabase: dbStub });
    expect(() => ctx.getSharedCollectionNameForModel('gpt')).toThrow(/unknown embedding model/i);
  });
});
```

**Step 2 — Run, expect FAIL** (`getSharedCollectionNameForModel` is not a function):
`pnpm --filter @zilliz/claude-context-core test -- shared-collection-model`

**Step 3 — Implement (full source).** First ensure the registry import exists at the top of `context.ts` (Cluster B adds it for `getCollectionNameForModel`; if not yet present, add it). Quote the current import block being extended (context.ts:22-27):

```typescript
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';
```

Replacement (add the registry import — idempotent with Cluster B; if Cluster B already added it, skip this edit):

```typescript
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';
import { getModelSpec, DEFAULT_PRIMARY_MODEL_ID } from './embedding/model-registry';
```

Then add the new method immediately after `getSharedCollectionName` (insert after context.ts:299, before `getWritableSharedCollectionName` at :306). Full source:

```typescript
    /**
     * Model-aware shared-collection resolver (M5).
     *
     * The shared collection (`MILVUS_COLLECTION_SHARED`) is a fixed-dimension
     * space created at the PRIMARY model's dimension (4096 for qwen3-8b). A
     * secondary-model (1024-dim) query vector ANN-searched against that 4096-dim
     * space is a guaranteed dimension mismatch on the FIRST secondary search of
     * any hybrid/shared project — including the MVP target (claude-context,
     * strategy=hybrid, shared=dev_infra_shared).
     *
     * Therefore the shared arm is appended ONLY for the primary model. Any model
     * that lacks a same-dimension shared collection returns undefined; the caller
     * (_semanticSearchImpl) then searches the model's private collection only.
     * Throws on an unknown model id (registry SSOT — fail fast, never wrong-dim).
     */
    public getSharedCollectionNameForModel(modelId: string): string | undefined {
        getModelSpec(modelId); // validates the id; throws on unknown
        if (modelId !== DEFAULT_PRIMARY_MODEL_ID) {
            // No same-dim shared collection exists for non-primary models in the MVP.
            return undefined;
        }
        return this.getSharedCollectionName();
    }
```

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`.** **Step 6 — Commit** `feat(core): model-aware shared-collection resolver, primary-only shared arm (M5)`.

> **Why a hybrid+shared fixture, not a private one:** a `strategy=private` fixture makes `getSharedCollectionName()` already return `undefined`, so the unconditional-append bug never fires and the test would green-light it. The test above sets `MILVUS_STRATEGY: 'hybrid'` + `MILVUS_COLLECTION_SHARED: 'dev_infra_shared'` exactly like the MVP target, so the 0.6B-returns-undefined assertion is load-bearing (Residual risk #5).

---

#### Task 4.1: `getEmbeddingForModel(modelId)` on `Context` (M4 query-vector resolver)

`_semanticSearchImpl` embeds the query at two sites (:558 hybrid, :625 non-hybrid) via `this.embedding.embed(query)`. Both must route to the **resolved model's** instance. We add a `secondaryEmbedding?: Embedding` ctor field and a resolver. When no secondary is configured, `getEmbeddingForModel(primary)` returns `this.embedding` and the secondary branch is unreachable — **byte-identical single-model behavior**.

**Files:**
- Modify: `packages/core/src/context.ts` — `ContextConfig` (:93-102), private fields (:133-139), constructor (:141-192), and add `getEmbeddingForModel` after `getEmbedding` (:197-199).
- Test: `packages/core/src/__tests__/embedding-for-model.test.ts` (jest, hermetic).

**Step 1 — Write the failing test (full source):**

```typescript
// packages/core/src/__tests__/embedding-for-model.test.ts
import { Context } from '../context';

// Two distinguishable fake embeddings (no network). Only the methods the
// resolver/ctor touch are implemented.
function fakeEmbedding(provider: string, dim: number): any {
  return {
    getProvider: () => provider,
    getDimension: () => dim,
    embed: async (_t: string) => ({ vector: new Array(dim).fill(0.1), dimension: dim }),
    embedBatch: async (ts: string[]) => ts.map(() => ({ vector: new Array(dim).fill(0.1), dimension: dim })),
    detectDimension: async () => dim,
  };
}
const dbStub: any = { hasCollection: async () => true };

describe('getEmbeddingForModel (M4)', () => {
  it('returns the primary instance for the primary id', () => {
    const primary = fakeEmbedding('primary-8b', 4096);
    const ctx = new Context({ embedding: primary, vectorDatabase: dbStub });
    expect(ctx.getEmbeddingForModel('qwen3-embedding-8b')).toBe(primary);
  });

  it('returns the secondary instance for the secondary id when configured', () => {
    const primary = fakeEmbedding('primary-8b', 4096);
    const secondary = fakeEmbedding('secondary-0.6b', 1024);
    const ctx = new Context({ embedding: primary, secondaryEmbedding: secondary, vectorDatabase: dbStub });
    expect(ctx.getEmbeddingForModel('qwen3-embedding-0.6b')).toBe(secondary);
    expect(ctx.getEmbeddingForModel('qwen3-embedding-0.6b').getDimension()).toBe(1024);
  });

  it('throws a configuration error for the secondary id when NOT configured (never wrong-dim)', () => {
    const primary = fakeEmbedding('primary-8b', 4096);
    const ctx = new Context({ embedding: primary, vectorDatabase: dbStub });
    expect(() => ctx.getEmbeddingForModel('qwen3-embedding-0.6b'))
      .toThrow(/not configured/i);
  });

  it('throws on an unknown model id', () => {
    const ctx = new Context({ embedding: fakeEmbedding('p', 4096), vectorDatabase: dbStub });
    expect(() => ctx.getEmbeddingForModel('gpt')).toThrow(/unknown embedding model/i);
  });

  it('exposes hasEmbeddingForModel predicate', () => {
    const ctx = new Context({ embedding: fakeEmbedding('p', 4096), vectorDatabase: dbStub });
    expect(ctx.hasEmbeddingForModel('qwen3-embedding-8b')).toBe(true);
    expect(ctx.hasEmbeddingForModel('qwen3-embedding-0.6b')).toBe(false);
  });
});
```

**Step 2 — Run, expect FAIL** (`secondaryEmbedding` not accepted / `getEmbeddingForModel` undefined):
`pnpm --filter @zilliz/claude-context-core test -- embedding-for-model`

**Step 3 — Implement (full source for each edit).**

(a) `ContextConfig` — current source (context.ts:93-102):

```typescript
export interface ContextConfig {
    embedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    includeDotDirs?: string[]; // Dot-prefixed directories to include in indexing
}
```

Replacement (add `secondaryEmbedding`):

```typescript
export interface ContextConfig {
    embedding?: Embedding;
    /**
     * Optional secondary embedding instance for dual-embedding (Option B).
     * Present ONLY when a secondary model is configured (e.g. qwen3-0.6b at
     * 1024-dim). When absent, the single-model path is byte-identical to today.
     */
    secondaryEmbedding?: Embedding;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    includeDotDirs?: string[]; // Dot-prefixed directories to include in indexing
}
```

(b) Private field — current source (context.ts:133):

```typescript
export class Context {
    private embedding: Embedding;
```

Replacement (add the field; keep everything else in the field block unchanged):

```typescript
export class Context {
    private embedding: Embedding;
    private secondaryEmbedding?: Embedding;
```

(c) Constructor — current source assigns only `this.embedding` (context.ts:143-147):

```typescript
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });
```

Replacement (capture the optional secondary verbatim — no default; absence = single-model):

```typescript
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });
        // Dual-embedding (Option B): the secondary instance is wired ONLY when
        // configured. No default — its absence is what keeps the single-model
        // path byte-identical. Cluster D constructs it in the MCP factory.
        this.secondaryEmbedding = config.secondaryEmbedding;
```

(d) Add `getEmbeddingForModel` + `hasEmbeddingForModel` after `getEmbedding` (insert after context.ts:199, the closing `}` of `getEmbedding`):

```typescript
    /**
     * Resolve the configured Embedding instance for a canonical model id (M4).
     *
     * The PRIMARY id always maps to `this.embedding` (byte-identical default).
     * A non-primary id maps to `this.secondaryEmbedding` IFF it was configured;
     * if not configured we THROW a clear configuration error rather than fall
     * back to the wrong-dimension primary instance (never a wrong-dim ANN call).
     * Throws on an unknown model id (registry SSOT).
     */
    public getEmbeddingForModel(modelId: string): Embedding {
        getModelSpec(modelId); // validates id; throws on unknown
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) {
            return this.embedding;
        }
        if (!this.secondaryEmbedding) {
            throw new Error(
                `embedding model '${modelId}' not configured (no secondary embedding instance)`,
            );
        }
        return this.secondaryEmbedding;
    }

    /**
     * Whether an Embedding instance is configured for the given model id.
     * Used by search routing to decide between routing vs. a clear notice
     * WITHOUT ever issuing a mismatched-dimension query.
     */
    public hasEmbeddingForModel(modelId: string): boolean {
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) return true;
        return this.secondaryEmbedding !== undefined;
    }
```

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`.** **Step 6 — Commit** `feat(core): getEmbeddingForModel + secondary embedding handle on Context (M4)`.

---

#### Task 4.2: Thread `embeddingModel` through `semanticSearch` + `_semanticSearchImpl` (M4 + M5 consumer)

Now make the search path model-aware: the public wrapper accepts `embeddingModel`, both embed sites use `getEmbeddingForModel`, the shared arm uses `getSharedCollectionNameForModel`, and the collection is resolved via `getCollectionNameForModel` (Cluster B). When the resolved model is unconfigured/missing-collection, return `[]` after a clear stderr notice — never a wrong-dim ANN call.

**Files:**
- Modify: `packages/core/src/context.ts` — `semanticSearch` (:515-518), `_semanticSearchImpl` (:520-659).
- Test: `packages/core/src/__tests__/search-routing.test.ts` (jest, hermetic — spies on the DB + embedding to assert ZERO shared ANN calls on the 0.6B path and that the 8B path is unchanged).

**Step 1 — Write the failing test (full source).** This is the M5 realism gate: a hybrid+shared fixture, spying `hybridSearch` collection args, asserting **zero** shared ANN calls on 0.6B.

```typescript
// packages/core/src/__tests__/search-routing.test.ts
import { Context } from '../context';

function fakeEmbedding(provider: string, dim: number): any {
  return {
    getProvider: () => provider, getDimension: () => dim,
    embed: async (_t: string) => ({ vector: new Array(dim).fill(0.1), dimension: dim }),
    embedBatch: async (ts: string[]) => ts.map(() => ({ vector: new Array(dim).fill(0.1), dimension: dim })),
    detectDimension: async () => dim,
  };
}

function spyDb() {
  const hybridCalls: string[] = [];   // collection names passed to hybridSearch
  const searchCalls: string[] = [];   // collection names passed to search
  const db: any = {
    hasCollection: async (_c: string) => true,
    query: async () => [{ id: 'x' }],                 // makes the "has data" probe pass
    hybridSearch: async (collection: string) => { hybridCalls.push(collection); return []; },
    search: async (collection: string) => { searchCalls.push(collection); return []; },
  };
  return { db, hybridCalls, searchCalls };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } });
}

const CB = process.cwd(); // any existing dir; envManager.runWithProject reads .env from it

describe('search routing (M4 + M5)', () => {
  it('8B default: searches private + shared (hybrid), embeds via primary', async () => {
    const { db, hybridCalls } = spyDb();
    await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: undefined }, async () => {
      const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), vectorDatabase: db });
      await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined /* default model = 8B */);
      // Primary collection + shared collection both searched.
      expect(hybridCalls).toEqual(['claude_context_own', 'dev_infra_shared']);
    });
  });

  it('0.6B: searches ONLY the _0p6b private collection — ZERO shared ANN calls (M5)', async () => {
    const { db, hybridCalls } = spyDb();
    const secondary = fakeEmbedding('secondary-0.6b', 1024);
    const embedSpy = jest.spyOn(secondary, 'embed');
    await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: 'claude_context_own_0p6b' }, async () => {
      const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), secondaryEmbedding: secondary, vectorDatabase: db });
      // Force the coverage gate OPEN for this routing test (P4 gate tested separately).
      jest.spyOn(ctx as any, 'isCoverageSufficientForModel').mockReturnValue(true);
      await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
      expect(hybridCalls).toEqual(['claude_context_own_0p6b']);  // NO shared collection
      expect(hybridCalls).not.toContain('dev_infra_shared');
      expect(embedSpy).toHaveBeenCalledTimes(1);                  // query embedded via the 0.6B instance
    });
  });

  it('0.6B requested but NOT configured: returns [] (clear notice), never a wrong-dim ANN call (D7)', async () => {
    const { db, hybridCalls, searchCalls } = spyDb();
    await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: undefined }, async () => {
      const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), vectorDatabase: db });
      const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
      expect(res).toEqual([]);
      expect(hybridCalls.length).toBe(0);   // never embedded/queried with the wrong instance
      expect(searchCalls.length).toBe(0);
    });
  });
});
```

> **Note on the P4 spy:** the routing test mocks `isCoverageSufficientForModel` to `true` so it isolates routing from the coverage gate. The coverage gate has its own dedicated test in Task 4.6. `isCoverageSufficientForModel` is authored in Task 4.6 (P4) and returns `true` unconditionally for the primary model.

**Step 2 — Run, expect FAIL** (`semanticSearch` ignores the 6th arg; shared arm always appended):
`pnpm --filter @zilliz/claude-context-core test -- search-routing`

**Step 3 — Implement (full source for each edit).**

(a) Public wrapper — current source (context.ts:515-518):

```typescript
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        // Scope project-`.env` reads to this call (parallel-safe via AsyncLocalStorage)
        return envManager.runWithProject(codebasePath, () => this._semanticSearchImpl(codebasePath, query, topK, threshold, filterExpr));
    }
```

Replacement (add optional `embeddingModel`, threaded into the impl; default resolution happens inside the impl so callers may pass `undefined`):

```typescript
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string, embeddingModel?: string): Promise<SemanticSearchResult[]> {
        // Scope project-`.env` reads to this call (parallel-safe via AsyncLocalStorage)
        return envManager.runWithProject(codebasePath, () => this._semanticSearchImpl(codebasePath, query, topK, threshold, filterExpr, embeddingModel));
    }
```

(b) `_semanticSearchImpl` — replace the **full method** (context.ts:520-659). Current signature/head (:520-539) being changed:

```typescript
    private async _semanticSearchImpl(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

        const collectionName = this.getCollectionName(codebasePath);
        const sharedCollectionName = this.getSharedCollectionName();
        const collectionsToSearch: string[] = [collectionName];

        if (sharedCollectionName && sharedCollectionName !== collectionName) {
            const hasShared = await this.vectorDatabase.hasCollection(sharedCollectionName);
            if (hasShared) {
                collectionsToSearch.push(sharedCollectionName);
                console.log(`[Context] 🔍 Multi-collection search: private=${collectionName}, shared=${sharedCollectionName}`);
            } else {
                console.log(`[Context] ⚠️  Shared collection '${sharedCollectionName}' does not exist, searching private only`);
            }
        } else {
            console.log(`[Context] 🔍 Using collection: ${collectionName}`);
        }
```

Full replacement of `_semanticSearchImpl` (the embed sites, collection resolution, and shared arm are the only behavior changes; the per-collection mapping/sort/slice bodies are preserved byte-for-byte from the verified source):

```typescript
    private async _semanticSearchImpl(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string, embeddingModel?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';

        // ── Model resolution (M4): explicit param > SEARCH_EMBEDDING_MODEL env > primary 8B.
        // The handler also resolves a default, but resolving here too keeps the
        // public API self-contained and the single-model path byte-identical
        // (undefined → primary → this.embedding → identical embed/collection).
        const requestedModel = embeddingModel
            ?? envManager.get('SEARCH_EMBEDDING_MODEL')
            ?? DEFAULT_PRIMARY_MODEL_ID;
        getModelSpec(requestedModel); // validate id; throws on unknown
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath} [model=${requestedModel}]`);

        // Requested-but-unconfigured model → clear notice, NEVER a wrong-dim ANN call (M4/LD-8/D7).
        if (!this.hasEmbeddingForModel(requestedModel)) {
            console.log(`[Context] ⚠️  Embedding model '${requestedModel}' is not configured — returning no results (configure the secondary model to search it).`);
            return [];
        }

        // Resolve the query-embedding instance and the model's collection (Cluster B resolver).
        const queryEmbedder = this.getEmbeddingForModel(requestedModel);
        const collectionName = this.getCollectionNameForModel(codebasePath, requestedModel);

        // P4 coverage gate (secondary models only): if the model's collection
        // coverage is below threshold (or unknown), return the degraded notice
        // WITHOUT issuing the ANN call. Primary model is always sufficient.
        if (!this.isCoverageSufficientForModel(codebasePath, requestedModel)) {
            console.log(`[Context] ⚠️  Coverage for model '${requestedModel}' on ${codebasePath} is below the readable threshold — returning no results (degraded; backfill incomplete).`);
            return [];
        }

        // ── Shared arm is model-aware (M5): only the primary model has a same-dim shared space.
        const sharedCollectionName = this.getSharedCollectionNameForModel(requestedModel);
        const collectionsToSearch: string[] = [collectionName];

        if (sharedCollectionName && sharedCollectionName !== collectionName) {
            const hasShared = await this.vectorDatabase.hasCollection(sharedCollectionName);
            if (hasShared) {
                collectionsToSearch.push(sharedCollectionName);
                console.log(`[Context] 🔍 Multi-collection search: private=${collectionName}, shared=${sharedCollectionName}`);
            } else {
                console.log(`[Context] ⚠️  Shared collection '${sharedCollectionName}' does not exist, searching private only`);
            }
        } else {
            console.log(`[Context] 🔍 Using collection: ${collectionName}`);
        }

        // Check if primary collection exists
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            console.log(`[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            try {
                const stats = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
            } catch (error) {
                console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
            }

            // 1. Generate query vector (once, reused for all collections) via the RESOLVED model instance.
            console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
            const queryEmbedding: EmbeddingVector = await queryEmbedder.embed(query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);

            // 2. Search all collections and merge results
            let allResults: SemanticSearchResult[] = [];

            for (const collection of collectionsToSearch) {
                const searchRequests: HybridSearchRequest[] = [
                    {
                        data: queryEmbedding.vector,
                        anns_field: "vector",
                        param: { "nprobe": 10 },
                        limit: topK
                    },
                    {
                        data: query,
                        anns_field: "sparse_vector",
                        param: { "drop_ratio_search": 0.2 },
                        limit: topK
                    }
                ];

                console.log(`[Context] 🔍 Searching collection: ${collection}`);
                const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                    collection,
                    searchRequests,
                    {
                        rerank: {
                            strategy: 'rrf',
                            params: { k: 100 }
                        },
                        limit: topK,
                        filterExpr
                    }
                );

                const isShared = collection !== collectionName;
                const results: SemanticSearchResult[] = searchResults.map(result => ({
                    content: result.document.content,
                    relativePath: isShared
                        ? `[shared] ${result.document.relativePath}`
                        : result.document.relativePath,
                    startLine: result.document.startLine,
                    endLine: result.document.endLine,
                    language: result.document.metadata.language || 'unknown',
                    score: result.score,
                    ...(isShared && result.document.metadata.codebasePath ? {
                        sourceProject: path.basename(result.document.metadata.codebasePath)
                    } : {})
                }));

                console.log(`[Context] 🔍 Found ${results.length} results from ${collection}`);
                allResults.push(...results);
            }

            // 3. Sort merged results by score and take topK
            allResults.sort((a, b) => b.score - a.score);
            allResults = allResults.slice(0, topK);

            console.log(`[Context] ✅ Found ${allResults.length} relevant hybrid results (from ${collectionsToSearch.length} collection(s))`);
            if (allResults.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${allResults[0].score}, path: ${allResults[0].relativePath}`);
            }

            return allResults;
        } else {
            // Regular semantic search — also supports multi-collection
            const queryEmbedding: EmbeddingVector = await queryEmbedder.embed(query);
            let allResults: SemanticSearchResult[] = [];

            for (const collection of collectionsToSearch) {
                const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                    collection,
                    queryEmbedding.vector,
                    { topK, threshold, filterExpr }
                );

                const isShared = collection !== collectionName;
                const results: SemanticSearchResult[] = searchResults.map(result => ({
                    content: result.document.content,
                    relativePath: isShared
                        ? `[shared] ${result.document.relativePath}`
                        : result.document.relativePath,
                    startLine: result.document.startLine,
                    endLine: result.document.endLine,
                    language: result.document.metadata.language || 'unknown',
                    score: result.score,
                    ...(isShared && result.document.metadata.codebasePath ? {
                        sourceProject: path.basename(result.document.metadata.codebasePath)
                    } : {})
                }));

                allResults.push(...results);
            }

            allResults.sort((a, b) => b.score - a.score);
            allResults = allResults.slice(0, topK);

            console.log(`[Context] ✅ Found ${allResults.length} relevant results (from ${collectionsToSearch.length} collection(s))`);
            return allResults;
        }
    }
```

> **Dependency note:** this method references `this.getCollectionNameForModel` (Cluster B, Phase 2) and `this.isCoverageSufficientForModel` (Task 4.6, P4 below). Sequence Task 4.6 before this passes, OR land a stub `isCoverageSufficientForModel(_p, m){ return m === DEFAULT_PRIMARY_MODEL_ID ? true : true; }` in this commit and replace it in 4.6. The plan sequences 4.6 immediately after, so the routing test's `jest.spyOn(...,'isCoverageSufficientForModel')` works regardless.

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`.** **Step 6 — Commit** `feat(core): explicit per-request search model routing; primary-only shared arm (M4,M5)`.

---

#### Task 4.3: Handler reads `args.embeddingModel` and threads it (M4 handler arm)

**Files:**
- Modify: `packages/mcp/src/handlers.ts` — `handleSearchCode` (:486 destructure; :569-575 call).
- Gate: `packages/mcp/scripts/jsonrpc-smoke.mjs` is extended (Task 4.4) — this task has no separate unit test; its behavior is asserted by the real ListTools+CallTool round-trip in 4.4.

**Step 1 — Implement (full source for each edit).**

(a) Destructure — current source (handlers.ts:486):

```typescript
    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter } = args;
        const resultLimit = limit || 10;
```

Replacement (read `embeddingModel`; resolve default precedence `args > SEARCH_EMBEDDING_MODEL > 8B`):

```typescript
    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter, embeddingModel } = args;
        const resultLimit = limit || 10;
        // Resolution precedence (M4): explicit arg > SEARCH_EMBEDDING_MODEL env > primary 8B.
        // envManager is project-scoped inside semanticSearch; process.env here is the
        // user-scope default, which is the intended fallback for the env layer.
        const resolvedModel = (typeof embeddingModel === 'string' && embeddingModel.length > 0)
            ? embeddingModel
            : (process.env.SEARCH_EMBEDDING_MODEL || 'qwen3-embedding-8b');
```

(b) The `semanticSearch` call — current source (handlers.ts:569-575):

```typescript
            // Search in the specified codebase
            const searchResults = await this.context.semanticSearch(
                absolutePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr
            );
```

Replacement (pass the resolved model as the 6th arg; add a stderr trace so the gate can assert the routed model by PARSED structured log):

```typescript
            // Search in the specified codebase (route the query embedding + collection by model).
            console.log(`[SEARCH] 🧭 Routing search via embedding model: ${resolvedModel}`);
            const searchResults = await this.context.semanticSearch(
                absolutePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr,
                resolvedModel
            );
```

**Step 2 — `pnpm typecheck && pnpm build:mcp`.** **Step 3 — Commit** `feat(mcp): search_code handler reads embeddingModel and routes it (M4)`.

---

#### Task 4.4: Add `embeddingModel` to the `search_code` inputSchema + D6/D7 gate (M4 schema — the dead-on-arrival fix)

MCP clients only transmit args declared in the served ListTools schema. Without this enum the feature is dead — `args.embeddingModel` would always be `undefined`. The gate runs a **real** ListTools+CallTool round-trip via an extended `jsonrpc-smoke.mjs`, asserting (1) the served schema carries the enum and (2) the 0.6B path used queue `embedding.qwen3-0.6b` + dim 1024 via PARSED structured logs.

**Files:**
- Modify: `packages/mcp/src/index.ts` — `search_code` inputSchema (:167-194).
- Author: `packages/mcp/scripts/search-model-routing.test.mjs` (new `.mjs`-against-dist gate; D6 schema arm + D7).
- Modify: `packages/mcp/package.json` — register `test:search-routing`.

**Step 1 — Write the failing gate first (full source).** This gate has TWO layers: (A) **schema assertion** — always runnable, hermetic (no broker); (B) **routing assertion** — env-gated `MCP_LIVE_ROUTING=1`, only runs when the RabbitMQ secondary is configured, never purges queues, tolerates WAIT-class lag.

```javascript
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
//   node packages/mcp/scripts/search-model-routing.test.mjs
// Exits 0 on success, non-zero on the first failed assertion.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const binaryPath = path.join(repoRoot, 'packages/mcp/dist/index.js');

// Refuse to run against the shared multi-user snapshot home (blast radius).
const home = process.env.CLAUDE_CONTEXT_HOME;
if (!home || home.includes('claude-control-center')) {
  console.error(`[route-test] REFUSING TO RUN: CLAUDE_CONTEXT_HOME=${home}`);
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const child = spawn(process.execPath, [binaryPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
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
  exitCode = failures === 0 ? 0 : 1;
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
  process.exit(exitCode);
}
```

**Step 2 — Run, expect FAIL** (Layer A: `embeddingModel` not in served schema):
`pnpm build:mcp && node packages/mcp/scripts/search-model-routing.test.mjs`

**Step 3 — Implement the schema (full source).** Current `search_code` tool def (index.ts:164-195):

```typescript
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
```

Replacement (add the `embeddingModel` enum property; `required` is unchanged so single-model clients are unaffected):

```typescript
                    {
                        name: "search_code",
                        description: search_description,
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: {
                                    type: "string",
                                    description: `ABSOLUTE path to the codebase directory to search in.`
                                },
                                query: {
                                    type: "string",
                                    description: "Natural language query to search for in the codebase"
                                },
                                limit: {
                                    type: "number",
                                    description: "Maximum number of results to return",
                                    default: 10,
                                    maximum: 50
                                },
                                extensionFilter: {
                                    type: "array",
                                    items: {
                                        type: "string"
                                    },
                                    description: "Optional: List of file extensions to filter results. (e.g., ['.ts','.py']).",
                                    default: []
                                },
                                embeddingModel: {
                                    type: "string",
                                    description: "Optional: which embedding model to search with. 'qwen3-embedding-8b' (default, 4096-dim, primary+shared) or 'qwen3-embedding-0.6b' (1024-dim, lightweight, private-only). Only set this if the secondary model has been indexed for this codebase; otherwise the search returns a clear 'not configured' notice.",
                                    enum: ["qwen3-embedding-8b", "qwen3-embedding-0.6b"],
                                    default: "qwen3-embedding-8b"
                                }
                            },
                            required: ["path", "query"]
                        }
                    },
```

**Step 4 — Register the package script.** Current `packages/mcp/package.json` scripts block has `"test:ledger": "pnpm build && node scripts/snapshot-ledger.test.mjs",`. Add a sibling:

```json
        "test:search-routing": "pnpm build && node scripts/search-model-routing.test.mjs",
```

**Step 5 — Run, expect PASS (Layer A):**
`pnpm --filter @zilliz/claude-context-mcp run test:search-routing`
Exit code 0; PARSED schema assertions all green. (Layer B remains skipped unless `MCP_LIVE_ROUTING=1`.)

**Step 6 — Commit** `feat(mcp): search_code embeddingModel enum in served schema + D6/D7 round-trip gate (M4)`.

> **Abort↔recovery pairing:** the gate refuses to run against the shared snapshot home (exit 2) — recovery is "set `CLAUDE_CONTEXT_HOME` to a throwaway temp dir." Layer B is env-gated and uses the default search priority (read embeds; never a write/purge of `embedding.qwen3-0.6b`).

---

### Phase 3/4 — Status + clear must agree with search (P3)

> P3 spans Phase 3 (clear drop) and Phase 4 (status readability predicate). Both consume the **one** `isModelReadable` predicate so `get_indexing_status` and `_semanticSearchImpl` never disagree (RG-6/RG-7).

#### Task 4.5 (P3a): One `isModelReadable` predicate, shared by status + search

`isModelReadable(codebasePath, modelId)` = `hasCollection(getCollectionNameForModel(codebasePath, modelId))` **AND** `coverageRatio >= threshold`. The primary model's coverage is always 1.0 (it is the source of truth), so the primary stays byte-identical (readable iff its collection exists — same as today's status check). `isCoverageSufficientForModel` (used by search in Task 4.2) is the **non-DB** half of this predicate; `isModelReadable` adds the live `hasCollection` check for status.

**Files:**
- Modify: `packages/core/src/context.ts` — add `isModelReadable` (async; near the other public model resolvers).
- Test: `packages/core/src/__tests__/model-readable.test.ts` (jest, hermetic).

**Step 1 — Failing test (full source):**

```typescript
// packages/core/src/__tests__/model-readable.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
  return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: [], dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}

describe('isModelReadable (P3)', () => {
  it('primary readable iff its collection exists (byte-identical to today)', async () => {
    const present: any = { hasCollection: async (_c: string) => true };
    const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: present });
    await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-8b')).resolves.toBe(true);
    const absent: any = { hasCollection: async (_c: string) => false };
    const ctx2 = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: absent });
    await expect(ctx2.isModelReadable(process.cwd(), 'qwen3-embedding-8b')).resolves.toBe(false);
  });

  it('secondary NOT readable when not configured (no embedding instance)', async () => {
    const present: any = { hasCollection: async () => true };
    const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: present });
    await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(false);
  });

  it('secondary readable only when collection exists AND coverage sufficient', async () => {
    const present: any = { hasCollection: async () => true };
    const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: present });
    // Coverage gate closed → not readable even though collection exists.
    jest.spyOn(ctx as any, 'isCoverageSufficientForModel').mockReturnValue(false);
    await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(false);
    // Coverage gate open → readable.
    (ctx as any).isCoverageSufficientForModel.mockReturnValue(true);
    await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(true);
  });
});
```

**Step 2 — Run, expect FAIL.** `pnpm --filter @zilliz/claude-context-core test -- model-readable`

**Step 3 — Implement (full source).** Add after `hasEmbeddingForModel` (Task 4.1):

```typescript
    /**
     * Single readability predicate shared by get_indexing_status AND search (P3,
     * RG-6/RG-7) so the two can never disagree about a model.
     *
     * A model is readable for a codebase when:
     *   (1) its embedding instance is configured (hasEmbeddingForModel), AND
     *   (2) its per-model collection exists in the vector DB, AND
     *   (3) its coverage ratio meets the readable threshold
     *       (always true for the primary; the P4 gate for secondaries).
     *
     * The primary model stays byte-identical to today's status check: configured
     * (true), collection-exists (the same hasCollection call status already runs),
     * coverage 1.0 (true).
     */
    public async isModelReadable(codebasePath: string, modelId: string): Promise<boolean> {
        getModelSpec(modelId); // validate id
        if (!this.hasEmbeddingForModel(modelId)) return false;
        const collectionName = this.getCollectionNameForModel(codebasePath, modelId);
        const exists = await this.vectorDatabase.hasCollection(collectionName);
        if (!exists) return false;
        return this.isCoverageSufficientForModel(codebasePath, modelId);
    }
```

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`.** **Step 6 — Commit** `feat(core): isModelReadable predicate shared by status+search (P3)`.

> **Search-path consistency:** `_semanticSearchImpl` already enforces the same three conditions piecewise (configured → `hasEmbeddingForModel`; collection-exists → its `hasCollection` guard; coverage → `isCoverageSufficientForModel`). Both paths now derive from the same `isCoverageSufficientForModel` + `getCollectionNameForModel`, so a model that status reports unreadable will also return `[]` from search, and vice versa.

#### Task 4.5b (P3a cont.): `get_indexing_status` reports per-model readability

**Files:**
- Modify: `packages/mcp/src/handlers.ts` — `handleGetIndexingStatus`, the `case 'indexed'` arm (:816-836).
- Gate: extend `search-model-routing.test.mjs` is overkill here; instead assert via a CallTool of `get_indexing_status` in a **new** small `.mjs` arm is deferred — for the MVP this status line is asserted by manual inspection in Phase 6 (E2). The code change is mechanical and covered by typecheck + the core `isModelReadable` unit test. *(If a hard gate is wanted, add `status-permodel.test.mjs` mirroring the routing gate's CallTool shape; flagged as optional N-task.)*

**Step 1 — Implement (full source).** Current `case 'indexed'` (handlers.ts:816-836):

```typescript
                case 'indexed': {
                    // Verify collection still exists in Milvus (may be lost after restart/cleanup)
                    const collectionName = this.context.getCollectionName(absolutePath);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);

                    if (!hasCollection) {
                        statusMessage = `⚠️ Codebase '${absolutePath}' was indexed but the index data has been lost (collection not found in Milvus).`;
                        statusMessage += `\n🔄 Please re-index using index_codebase with force=true.`;
                        break;
                    }

                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }
                    break;
                }
```

Replacement (primary check unchanged; append a per-model readability line via the shared predicate — only mentions the secondary when configured, so single-model status output is byte-identical):

```typescript
                case 'indexed': {
                    // Verify the PRIMARY collection still exists in Milvus (may be lost after restart/cleanup).
                    // isModelReadable for the primary == today's hasCollection check (coverage 1.0, configured true).
                    const primaryReadable = await this.context.isModelReadable(absolutePath, 'qwen3-embedding-8b');

                    if (!primaryReadable) {
                        statusMessage = `⚠️ Codebase '${absolutePath}' was indexed but the index data has been lost (collection not found in Milvus).`;
                        statusMessage += `\n🔄 Please re-index using index_codebase with force=true.`;
                        break;
                    }

                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }

                    // Per-model readability for the SECONDARY model (only surfaced when configured).
                    // Keeps status and search in lock-step via the shared isModelReadable predicate (P3).
                    if (this.context.hasEmbeddingForModel('qwen3-embedding-0.6b')) {
                        const secondaryReadable = await this.context.isModelReadable(absolutePath, 'qwen3-embedding-0.6b');
                        statusMessage += secondaryReadable
                            ? `\n🟢 Secondary model 'qwen3-embedding-0.6b' is readable (1024-dim).`
                            : `\n🟡 Secondary model 'qwen3-embedding-0.6b' is configured but NOT yet readable (collection missing or coverage below threshold — searches with it return a degraded notice).`;
                    }
                    break;
                }
```

> **Note:** this references `this.context.hasEmbeddingForModel` and `this.context.isModelReadable` — both authored in Tasks 4.1/4.5 on the core `Context`. `getVectorDatabase()` is no longer needed in this arm (the readability check encapsulates the DB call); the import/usage elsewhere in the handler is untouched.

**Step 2 — `pnpm typecheck && pnpm build:mcp && pnpm build:core`.** **Step 3 — Commit** `feat(mcp): get_indexing_status reports per-model readability via shared predicate (P3)`.

#### Task 4.6 already overlaps; the clear-drop is Task 3.x below

---

### Phase 3 — Per-model `_clearIndexImpl` drop (P3b)

`_clearIndexImpl` (context.ts:685-707) drops only `getCollectionName`. With dual-embedding it must drop **every active model collection** (and writable-shared siblings) so `clear_index` doesn't leave an orphaned `_0p6b` collection that `get_indexing_status`/search would then disagree about. Use the **one shared active-targets enumerator** (Residual risk #1 mandates a single enumerator used by index+delete+clear+prepare). Cluster B authors the targets-array builder; Cluster C consumes a read-only variant for clear (it does not need embedding instances, only collection names).

**Files:**
- Modify: `packages/core/src/context.ts` — `_clearIndexImpl` (:685-707); add a small private `getActiveModelCollectionNames(codebasePath)` helper that reuses the targets enumerator's model set.
- Test: `packages/core/src/__tests__/clear-per-model.test.ts` (jest, hermetic — spy `dropCollection`).

**Step 1 — Failing test (full source):**

```typescript
// packages/core/src/__tests__/clear-per-model.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
  return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: [], dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}

function spyDb(existing: Set<string>) {
  const dropped: string[] = [];
  const db: any = {
    hasCollection: async (c: string) => existing.has(c),
    dropCollection: async (c: string) => { dropped.push(c); existing.delete(c); },
    query: async () => [],
  };
  return { db, dropped };
}

const CB = process.cwd();

describe('_clearIndexImpl per-model drop (P3)', () => {
  it('single-model: drops only the primary collection (byte-identical)', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
    const { db, dropped } = spyDb(new Set(['claude_context_own']));
    const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: db });
    await ctx.clearIndex(CB);
    expect(dropped).toEqual(['claude_context_own']);
    delete process.env.MILVUS_COLLECTION_PRIVATE;
  });

  it('dual-model: drops BOTH the primary and the _0p6b collection', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
    const { db, dropped } = spyDb(new Set(['claude_context_own', 'claude_context_own_0p6b']));
    const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
    await ctx.clearIndex(CB);
    expect(dropped.sort()).toEqual(['claude_context_own', 'claude_context_own_0p6b']);
    delete process.env.MILVUS_COLLECTION_PRIVATE;
    delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
  });
});
```

**Step 2 — Run, expect FAIL** (`_0p6b` not dropped). `pnpm --filter @zilliz/claude-context-core test -- clear-per-model`

**Step 3 — Implement (full source).**

(a) Add the active-collection enumerator (private). Active models = primary always + secondary iff `hasEmbeddingForModel`. Each model's collection via `getCollectionNameForModel`; also include its writable-shared sibling when configured (primary only — secondary has no shared sibling per M5). Insert near the other model resolvers:

```typescript
    /**
     * Enumerate the set of collection names that are ACTIVE for a codebase under
     * the current model configuration (P3 shared enumerator). Used by clear (and
     * any other per-model sweep) so it can never miss a model's collection.
     *
     * - Primary (8B): always active; includes its writable-shared sibling when set.
     * - Secondary (0.6B): active only when its embedding instance is configured;
     *   no shared sibling (M5 — no same-dim shared space).
     *
     * De-duplicated; safe to call when only the primary is configured (returns the
     * single primary collection — byte-identical to today's clear).
     */
    private getActiveModelCollectionNames(codebasePath: string): string[] {
        const names = new Set<string>();
        const activeModels: string[] = [DEFAULT_PRIMARY_MODEL_ID];
        if (this.hasEmbeddingForModel('qwen3-embedding-0.6b')) {
            activeModels.push('qwen3-embedding-0.6b');
        }
        for (const modelId of activeModels) {
            names.add(this.getCollectionNameForModel(codebasePath, modelId));
            // Writable-shared sibling only for the primary (M5: 0.6B has none).
            if (modelId === DEFAULT_PRIMARY_MODEL_ID) {
                const ws = this.getWritableSharedCollectionName();
                if (ws) names.add(ws);
            }
        }
        return [...names];
    }
```

(b) Replace `_clearIndexImpl` (full source). Current (context.ts:685-707):

```typescript
    private async _clearIndexImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        const collectionName = this.getCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        console.log('[Context] ✅ Index data cleaned');
    }
```

Replacement (drop every active model collection; per-drop abort↔recovery: a single drop failure is logged and the sweep continues, then re-throws an aggregate so the caller can surface partial-clear — never a silent half-clear):

```typescript
    private async _clearIndexImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        // Drop EVERY active model collection (primary + secondary + writable-shared
        // siblings) via the one shared enumerator (P3). A single-model config yields
        // exactly the primary collection — byte-identical to the prior behavior.
        const collectionNames = this.getActiveModelCollectionNames(codebasePath);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        const dropFailures: string[] = [];
        for (const collectionName of collectionNames) {
            try {
                const collectionExists = await this.vectorDatabase.hasCollection(collectionName);
                if (collectionExists) {
                    await this.vectorDatabase.dropCollection(collectionName);
                    console.log(`[Context] 🗑️  Dropped collection ${collectionName}`);
                }
            } catch (dropErr) {
                // Pair the abort with recovery: record and keep sweeping the other
                // collections, then re-throw an aggregate so the caller never
                // believes a partial clear fully succeeded.
                console.error(`[Context] ❌ Failed to drop collection ${collectionName}: ${dropErr}`);
                dropFailures.push(collectionName);
            }
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        if (dropFailures.length > 0) {
            throw new Error(`clearIndex partially failed: could not drop ${dropFailures.join(', ')} (re-run clear_index to retry; snapshot was still cleared).`);
        }
        console.log('[Context] ✅ Index data cleaned');
    }
```

> **Snapshot ledger note:** the per-model snapshot ledger (`filesByModel`) is removed at the MCP layer by `removeCodebaseCompletely(absolutePath)` (handlers.ts:728), which deletes the whole `codebaseInfoMap` entry — that already drops both `files` and `filesByModel` together, so no extra MCP change is needed for clear. (Verified: `removeCodebaseCompletely` at snapshot.ts:493 deletes the entry wholesale.)

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck`.** **Step 6 — Commit** `fix(core): clear_index drops every active model collection with partial-failure recovery (P3)`.

---

### Phase 4/5 — Runtime coverage gate (P4 / LD-10 / E2)

LD-10 says: below the coverage threshold the 0.6B collection is **not readable** — search returns an explicit degraded notice, never a silent partial. The runtime gate has had no implementing task. Cluster C owns the **read** side: persist the distinct-PK overlap ratio per `(codebasePath × modelId)` in the snapshot (riding M2's exhaustive carry-forward so it is not dropped), and read it in `_semanticSearchImpl` to decide route-vs-degrade.

**Coordination with Phase 1/M2:** the snapshot v2-additive carry-forward (Cluster A, Phase 1) must spread `...rest` so any new key survives. Cluster C adds a sibling map `coverageByModel?: Record<modelId, number>` to the codebase entry, and accessors `setCoverageRatioForModel` / `getCoverageRatioForModel` on `SnapshotManager`. The **write** of the ratio happens in Phase 5 (backfill measures distinct-PK overlap and calls `setCoverageRatioForModel`); the **read** + degrade-branch is Cluster C here. The Phase-1 exhaustive carry-forward (M2) guarantees `coverageByModel` survives the 2s tick and the terminal transition — Cluster C must add a one-line check to the M2 keystone test asserting `coverageByModel` round-trips (see Risk R-C2).

#### Task 4.6a (P4): snapshot coverage accessors + threshold env

**Files:**
- Modify: `packages/mcp/src/config.ts` — add `coverageByModel?: Record<string, number>` to `CodebaseInfoIndexing` and `CodebaseInfoIndexed` (additive, same shape rule as `filesByModel`).
- Modify: `packages/mcp/src/snapshot.ts` — add `setCoverageRatioForModel` / `getCoverageRatioForModel`; carry `coverageByModel` forward at the three M2 sites (Cluster A's exhaustive `...rest` spread already covers this, but assert it).
- Test: extend `packages/mcp/scripts/snapshot-ledger.test.mjs` with a coverage round-trip scenario (E. below), OR a new `snapshot-coverage.test.mjs`. Author a new runner to keep the keystone test focused.

**Step 1 — Failing gate (full source — new `.mjs` against dist):**

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/snapshot-coverage.test.mjs
// P4: per-(codebase × model) coverage ratio survives the carry-forward + reload.
// Imports the COMPILED dist/snapshot.js. Parsed-object assertions; exit non-zero
// on first failure. Two SnapshotManager runtimes (capture + verify share code).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distSnapshot = path.resolve(__dirname, '..', 'dist', 'snapshot.js');
if (!fs.existsSync(distSnapshot)) { console.error(`MISSING ${distSnapshot} — run pnpm build:mcp`); process.exit(2); }
const { SnapshotManager } = await import(pathToFileURL(distSnapshot).href);

let failures = 0;
const check = (n, c, d) => { if (c) console.log(`  ✓ ${n}`); else { failures++; console.error(`  ✗ ${n}${d ? ` — ${d}` : ''}`); } };

function withTempHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cov-test-'));
  const prev = process.env.CLAUDE_CONTEXT_HOME; process.env.CLAUDE_CONTEXT_HOME = dir;
  try { return fn(dir); } finally { if (prev === undefined) delete process.env.CLAUDE_CONTEXT_HOME; else process.env.CLAUDE_CONTEXT_HOME = prev; try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
const CB = path.resolve(__dirname, '..', '..', '..'); // repo root (must exist)

console.log('snapshot-coverage.test — compiled dist/snapshot.js');
withTempHome(() => {
  const m = new SnapshotManager();
  m.setCodebaseIndexing(CB, 10);
  m.setCoverageRatioForModel(CB, 'qwen3-embedding-0.6b', 0.42);
  // A later 2s progress tick must NOT clobber the coverage (M2 carry-forward).
  m.setCodebaseIndexing(CB, 80);
  m.setCodebaseIndexed(CB, { indexedFiles: 1, totalChunks: 3, status: 'completed' });
  m.saveCodebaseSnapshot();

  // Re-read from disk in a SECOND runtime (capture-and-verify share code).
  const m2 = new SnapshotManager();
  m2.loadCodebaseSnapshot();
  check('coverage ratio survived indexing tick + terminal transition + reload',
    m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b') === 0.42,
    `got ${m2.getCoverageRatioForModel(CB, 'qwen3-embedding-0.6b')}`);
  check('absent model coverage reads as undefined',
    m2.getCoverageRatioForModel(CB, 'qwen3-embedding-8b') === undefined,
    `got ${m2.getCoverageRatioForModel(CB, 'qwen3-embedding-8b')}`);
});

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failed assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
```

Register the script (sibling to `test:ledger`):

```json
        "test:coverage-snap": "pnpm build && node scripts/snapshot-coverage.test.mjs",
```

**Step 2 — Run, expect FAIL** (`setCoverageRatioForModel` not a function): `pnpm --filter @zilliz/claude-context-mcp run test:coverage-snap`

**Step 3 — Implement.**

(a) `config.ts` interfaces — add the field (additive). The current `CodebaseInfoIndexing`/`CodebaseInfoIndexed` already carry `files?` and (after Phase 1) `filesByModel?`. Add `coverageByModel?` to both, e.g. for `CodebaseInfoIndexed`:

```typescript
    /** Per-(model) distinct-PK overlap ratio vs the primary collection (P4/LD-10).
     *  Keyed by canonical model id. Absent ⇒ unknown ⇒ secondary treated degraded. */
    coverageByModel?: Record<string, number>;
```

(Mirror the same line on `CodebaseInfoIndexing`. Quote the current interface block when editing — both already end with `files?: Record<string, FileCompleteness>;` after Phase 1; insert the new field directly after it.)

(b) `snapshot.ts` accessors (full source) — add after `getFileLedger` (snapshot.ts:463):

```typescript
    /**
     * Persist the per-(codebase × model) coverage ratio (P4). Seeds a minimal
     * 'indexing' entry if none exists (callback may race ahead of the first tick),
     * mirroring setFileComplete's seed behavior.
     */
    public setCoverageRatioForModel(codebasePath: string, modelId: string, ratio: number): void {
        let entry = this.codebaseInfoMap.get(codebasePath);
        if (!entry) {
            entry = { status: 'indexing', indexingPercentage: 0, lastUpdated: new Date().toISOString() } as CodebaseInfoIndexing;
            this.codebaseInfoMap.set(codebasePath, entry);
        }
        const e = entry as CodebaseInfoIndexing | CodebaseInfoIndexed;
        if (!e.coverageByModel) e.coverageByModel = {};
        e.coverageByModel[modelId] = ratio;
    }

    /**
     * Read the per-(codebase × model) coverage ratio (P4). Returns undefined when
     * unknown — the search-side coverage gate treats undefined as DEGRADED for
     * secondary models (never silently search a possibly-incomplete collection).
     */
    public getCoverageRatioForModel(codebasePath: string, modelId: string): number | undefined {
        const entry = this.codebaseInfoMap.get(codebasePath);
        const cov = entry && (entry as CodebaseInfoIndexing | CodebaseInfoIndexed).coverageByModel;
        return cov ? cov[modelId] : undefined;
    }
```

(c) Carry-forward at the M2 sites: Cluster A's exhaustive `...rest`/`...prior` spread in `setCodebaseIndexing` (:362-380), `setCodebaseIndexed` (:385-413), and the merge (`mergeAndWriteSnapshot` :560-621) must include `coverageByModel`. If Cluster A used field-by-field enumeration (the RG-5 anti-pattern), Cluster C escalates per Risk R-C2. The coverage gate test above is the binary proof it survives.

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck && pnpm build:mcp`.** **Step 6 — Commit** `feat(mcp): per-model coverage ratio in snapshot + round-trip gate (P4)`.

#### Task 4.6b (P4): the search-side coverage gate (`isCoverageSufficientForModel`)

The search path (Task 4.2) and `isModelReadable` (Task 4.5) both call `Context.isCoverageSufficientForModel(codebasePath, modelId)`. But `Context` (core) must NOT import the mcp `SnapshotManager` (the core→mcp boundary — verified: core never imports mcp). So the coverage ratio is injected the same way `priorLedger` is: a **read callback** passed into `Context`, or a per-call accessor. The cleanest fit matching the existing pattern is a `coverageReader` ctor field on `Context` (a function `(codebasePath, modelId) => number | undefined`) supplied by the MCP layer from `snapshotManager.getCoverageRatioForModel`.

**Files:**
- Modify: `packages/core/src/context.ts` — `ContextConfig` (add `coverageReader?`), private field + ctor capture, add `isCoverageSufficientForModel`.
- Modify: `packages/mcp/src/index.ts` — pass `coverageReader: (p, m) => this.snapshotManager.getCoverageRatioForModel(p, m)` into `new Context({...})` (Cluster D owns ctor wiring; Cluster C specifies the exact closure).
- Test: `packages/core/src/__tests__/coverage-gate.test.ts` (jest, hermetic — degraded < threshold, normal >= threshold, parsed response from `semanticSearch`).

**Step 1 — Failing test (full source):**

```typescript
// packages/core/src/__tests__/coverage-gate.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
  return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: new Array(dim).fill(0.1), dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}
function db() { const calls: string[] = []; return { calls, db: { hasCollection: async () => true, query: async () => [{ id: 'x' }], hybridSearch: async (c: string) => { calls.push(c); return []; }, search: async (c: string) => { calls.push(c); return []; } } }; }
const CB = process.cwd();

describe('coverage gate (P4)', () => {
  it('secondary BELOW threshold → degraded: returns [], no ANN call', async () => {
    process.env.HYBRID_MODE = 'true';
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
    const { calls, db: vdb } = db();
    const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.50 /* < 0.85 */ });
    const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
    expect(res).toEqual([]);
    expect(calls.length).toBe(0);
    delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE;
  });

  it('secondary AT/ABOVE threshold → normal: issues the ANN call on the _0p6b collection', async () => {
    process.env.HYBRID_MODE = 'true';
    process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
    const { calls, db: vdb } = db();
    const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.90 /* >= 0.85 */ });
    await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
    expect(calls).toEqual(['claude_context_own_0p6b']);
    delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE;
  });

  it('secondary with UNKNOWN coverage (reader returns undefined) → degraded', async () => {
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
    const { calls, db: vdb } = db();
    const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => undefined });
    const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
    expect(res).toEqual([]);
    expect(calls.length).toBe(0);
    delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
  });

  it('PRIMARY model is always sufficient regardless of reader', async () => {
    const { calls, db: vdb } = db();
    const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: vdb as any, coverageReader: () => 0.0 });
    await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-8b');
    expect(calls.length).toBeGreaterThan(0); // primary never degraded
  });
});
```

**Step 2 — Run, expect FAIL** (`coverageReader` not accepted / gate not enforced): `pnpm --filter @zilliz/claude-context-core test -- coverage-gate`

**Step 3 — Implement (full source).**

(a) `ContextConfig` — add the reader (after the `secondaryEmbedding` field added in Task 4.1):

```typescript
    /**
     * Optional per-(codebase × model) coverage-ratio reader (P4/LD-10).
     * Supplied by the MCP layer from the snapshot. Returns the distinct-PK
     * overlap ratio for a model's collection, or undefined when unknown. Core
     * must not import the mcp SnapshotManager — this callback is the only bridge
     * (mirrors how priorLedger crosses the boundary).
     */
    coverageReader?: (codebasePath: string, modelId: string) => number | undefined;
```

(b) Private field + ctor capture + threshold. Add the field beside `secondaryEmbedding`:

```typescript
    private secondaryEmbedding?: Embedding;
    private coverageReader?: (codebasePath: string, modelId: string) => number | undefined;
```

In the constructor, after `this.secondaryEmbedding = config.secondaryEmbedding;`:

```typescript
        this.coverageReader = config.coverageReader;
```

(c) The predicate (full source). Add after `hasEmbeddingForModel` / `getSharedCollectionNameForModel`:

```typescript
    /**
     * P4 coverage gate (LD-10). The PRIMARY model is the source of truth and is
     * always sufficient. For a SECONDARY model, the model's collection is readable
     * only when its persisted distinct-PK overlap ratio meets the threshold
     * (COVERAGE_READABLE_THRESHOLD, default 0.85). Unknown ratio (no reader, or
     * reader returns undefined) ⇒ DEGRADED — never silently search a possibly
     * incomplete backfill.
     *
     * Synchronous (reads the in-memory snapshot via the injected reader) so both
     * the search hot-path and isModelReadable can call it without an extra await.
     */
    public isCoverageSufficientForModel(codebasePath: string, modelId: string): boolean {
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) return true;
        const thresholdRaw = envManager.get('COVERAGE_READABLE_THRESHOLD');
        const threshold = thresholdRaw !== undefined && thresholdRaw !== null && thresholdRaw !== ''
            ? parseFloat(thresholdRaw)
            : 0.85;
        const ratio = this.coverageReader?.(codebasePath, modelId);
        if (ratio === undefined || Number.isNaN(ratio)) return false;
        return ratio >= threshold;
    }
```

(d) MCP ctor wiring (Cluster D owns the edit; Cluster C specifies the exact closure). In `packages/mcp/src/index.ts`, the `new Context({...})` at :69-72 becomes (Cluster D also adds `secondaryEmbedding` here):

```typescript
        this.context = new Context({
            embedding,
            // secondaryEmbedding: <built by Cluster D Task 4.1 when configured>,
            vectorDatabase,
            coverageReader: (codebasePath, modelId) => this.snapshotManager.getCoverageRatioForModel(codebasePath, modelId),
        });
```

> **Ordering caveat for Cluster D:** `this.snapshotManager` is constructed at index.ts:75, AFTER `new Context` at :69. The `coverageReader` arrow closes over `this.snapshotManager` and is only INVOKED at search time (long after construction), so the late assignment is fine — but Cluster D must NOT eagerly read `this.snapshotManager` inside the closure body at construction time. Flagged in Risk R-C3.

**Step 4 — Run, expect PASS.** **Step 5 — `pnpm typecheck && pnpm build:core && pnpm build:mcp`.** **Step 6 — Commit** `feat(core): runtime coverage gate for secondary search; degraded notice below threshold (P4)`.

> **Search response wording note:** the degraded path returns `[]`; the user-facing "degraded / not configured" wording is surfaced by the handler's existing no-results branch. For a clearer signal, the handler MAY (optional N-task) detect `resolvedModel !== '8b' && results.length === 0` and append "secondary model degraded or not configured" to `noResultsMessage` (handlers.ts:592-595). Not required for the gate — the gate asserts ZERO ANN calls, which is the load-bearing invariant.

---

### Risks / unresolved coupling with other clusters

- **R-C1 (Cluster D — ctor field name):** Cluster C names the secondary handle `secondaryEmbedding` on both `ContextConfig` and the `Context` field, and `coverageReader` for the P4 bridge. Cluster D (Phase 4.1 ctor wiring) must construct the secondary `RabbitMQEmbedding` and pass it as `secondaryEmbedding`, plus pass the `coverageReader` closure. If Cluster B/D chose a different field name for the index-side secondary instance, reconcile to ONE name — `Context.getEmbeddingForModel` returns `this.secondaryEmbedding`.
- **R-C2 (Cluster A — M2 exhaustive carry-forward must include `coverageByModel`):** Task 4.6a adds `coverageByModel` to the codebase entry. It survives the 2s tick + terminal transition + merge ONLY if Phase 1/M2 used the exhaustive `...rest` spread (RG-5), not field-by-field enumeration. Cluster C's `snapshot-coverage.test.mjs` is the binary proof; if it fails, the M2 sites need the spread. Cluster C also requests one assertion in the M2 keystone test that `coverageByModel` round-trips.
- **R-C3 (Cluster D — coverageReader closure ordering):** `this.snapshotManager` is constructed AFTER `new Context` in index.ts (:69 vs :75). The `coverageReader` arrow must only dereference `this.snapshotManager` at call time (search), never at construction. Verified the closure-at-call pattern is safe.
- **R-C4 (Cluster B — `getCollectionNameForModel` + IndexTarget enumerator):** Cluster C consumes `getCollectionNameForModel` in 4 places (search route, isModelReadable, getActiveModelCollectionNames, coverage-gate path). It must throw on unknown ids and apply the `MILVUS_COLLECTION_PRIVATE_0P6B` override verbatim (Cluster B's Task 2.1 spec). Cluster C's `getActiveModelCollectionNames` is a clear-side enumerator that duplicates the "active models" logic; if Cluster B exposes a shared `getActiveModelIds()` helper, Cluster C should call it instead (Residual risk #1 — one enumerator). Flagged for the confirmation pass.
- **R-C5 (handler env precedence):** the handler resolves `SEARCH_EMBEDDING_MODEL` from `process.env` (user scope) while `_semanticSearchImpl` re-resolves it from `envManager` (project scope) inside `runWithProject`. Because the handler passes an explicit resolved model down, the impl's own fallback only matters if the handler ever passes `undefined`; it does not (it always resolves to at least `'qwen3-embedding-8b'`). The two layers agree for the explicit-arg and absent cases. The only divergence is when a project `.env` sets `SEARCH_EMBEDDING_MODEL` but the user-scope env does not — the handler would pass `8b` and the impl's project-scope value would be ignored. **Decision needed:** to honor project-`.env` `SEARCH_EMBEDDING_MODEL`, the handler should pass `undefined` when no explicit arg AND no `process.env` default, letting the impl's project-scoped `envManager.get('SEARCH_EMBEDDING_MODEL')` win. Recommend: handler passes `embeddingModel` arg if present, else `undefined` (drop the `process.env` read in the handler), so the single project-scoped resolution in the impl is authoritative (matches LD-8 "env default" + the fork's project-`.env`-priority model). This simplifies precedence to one site. Flagged for the confirmation pass; the code above shows the dual-read variant — switch to the single-site variant if the council confirms.

---

## Phase 5 — 0.6B filesystem backfill of `claude_context_own` (priority=1) + dedup prereq

**Goal:** populate the secondary `_0p6b` collection for the MVP project via source-A (filesystem re-chunk), after deduping the 8B source. Operational phase — its artifacts are recorded metrics, not new code (the mechanics are the Phase-2 `IndexTarget` loop with a single 0.6B target).

- **Task 5.1 (LD-11 dedup prereq, gates G3):** run the distinct-PK probe from **Phase 6 (E3)** against `claude_context_own`; if `distinct < total`, `compact()` + wait, re-probe, and commit both JSON outputs (before/after distinct-PK counts). This makes the coverage ratio meaningful.
- **Task 5.2 (backfill):** index `E:\Developer\lufftw\repo\claude-context` with **only the 0.6B `IndexTarget` active** (8B already populated). Empty per-model ledger ⇒ every file appears missing ⇒ full backfill, reusing all Phase-2 Merkle/skip/ledger logic. Embeds at registry `priorityDefault` (=1) so it never starves interactive (=10). Resumable + idempotent (per-target ledger from M8; native upsert).
- **Task 5.3 (coverage, G3 = audit E1):** compute distinct-PK overlap between `claude_context_own` and `claude_context_own_0p6b`; persist it as `coverageByModel['qwen3-embedding-0.6b']` on the snapshot entry (rides the M2 exhaustive carry-forward — RG-5) so the Phase-4 search degrade gate (P4) can read it. Record the ratio as the artifact.
- **(LD-12)** Backfill ledger flush is coarse (≥30s / per-N-files), not the interactive 2s tick — for the MVP small run this is a no-op, but the knob is wired here so any Phase-2 large backfill inherits it (protects the shared snapshot lock).

---

## Phase 6 — Gate Harnesses (M3, P5)

### Audit B3 fix: `pnpm test` for the mcp package resolves to nothing

**Root cause (verified):** `packages/mcp/package.json` has no `"test"` script. The only test-adjacent script is `"test:ledger"`. Running `pnpm test` at the mcp package resolves to nothing (no error, no tests run) — this is a silent gap.

**Fix:** do not add a generic `"test"` script (which would require jest setup). Instead, enumerate **all gate commands** explicitly and document them as the B3 checklist. The plan's audit item B3 is corrected to:

**Corrected B3 — Enumerated MCP gate commands (replace the single `pnpm test` line):**

```
# Build first (required by all .mjs runners):
pnpm --filter @zilliz/claude-context-mcp build
# then exit 0 required from each of:
node packages/mcp/scripts/snapshot-ledger.test.mjs
node packages/mcp/scripts/dual-config-smoke.mjs
node packages/mcp/scripts/jsonrpc-smoke-dual.mjs
node packages/mcp/scripts/probe-0p6b-worker.mjs
node packages/mcp/scripts/milvus-dedup-probe.mjs
node packages/mcp/scripts/plan-sync-sha256.mjs
# Core jest (unchanged):
pnpm --filter @zilliz/claude-context-core test
```

Each script exits non-zero on the first failed assertion. Each is registered as a `package.json` script. No script is gated by another except build.

---

### Gate D6: `packages/mcp/scripts/jsonrpc-smoke-dual.mjs` (FULL SOURCE)

This extends the existing `jsonrpc-smoke.mjs` convention. It spawns the real binary, does the full JSON-RPC initialize+tools/list+tools/call round-trip, and asserts:

1. `search_code` `inputSchema` contains an `embeddingModel` enum with both canonical ids (parsed JSON, no substring).
2. A `tools/call search_code` with `embeddingModel='qwen3-embedding-0.6b'` produces a `content[0].text` or stderr line containing `queue=embedding.qwen3-0.6b` and `dim=1024` — verified by parsing structured JSON log lines from stderr, not substring matching the text response.

**Design note on assertion 2:** the binary writes diagnostic JSON log lines to stderr at the time of embedding. The gate captures the child's stderr, splits on newlines, and parses each line as JSON. Lines that are not valid JSON are ignored (they are human-readable text). A parsed line is accepted if it has `queue === 'embedding.qwen3-0.6b'` and `dim === 1024` as direct fields. If no such line appears and the call returns a clear "not configured" message (because the test env has no `MILVUS_COLLECTION_PRIVATE_0P6B`), the gate accepts that as the "unconfigured secondary" path (D7) instead and marks D6 as "infra-gated" — because D6 requires a live Milvus+RabbitMQ connection, it is marked with `MILVUS_LIVE=1` to be run only in the live infra context.

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/jsonrpc-smoke-dual.mjs
//
// JSON-RPC dual-embedding smoke gate (M3/D6/D7).
// Extends the existing jsonrpc-smoke.mjs with embeddingModel enum + routing assertions.
//
// Asserts (parsed JSON, never substring):
//   1. tools/list: search_code inputSchema.properties.embeddingModel.enum contains
//      both 'qwen3-embedding-8b' and 'qwen3-embedding-0.6b'.
//   2. tools/call search_code with embeddingModel='qwen3-embedding-0.6b':
//      (a) if secondary IS configured (MILVUS_COLLECTION_PRIVATE_0P6B set):
//          stderr contains a parsed JSON log line with queue='embedding.qwen3-0.6b' and dim=1024.
//      (b) if secondary NOT configured:
//          result content text contains 'not configured' or 'secondary' (case-insensitive).
//          This validates D7 (unconfigured → clear notice, not a dim-mismatch error).
//   3. tools/call search_code with no embeddingModel defaults to 8B (queue not 0.6b in log).
//   4. No non-JSON on stdout at any point.
//
// Run (after pnpm build:mcp):
//   CLAUDE_CONTEXT_HOME=/tmp/cc-smoke-$$ node packages/mcp/scripts/jsonrpc-smoke-dual.mjs
// Exits 0 on pass, non-zero on first failed assertion.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// Safety: refuse to run against the production shared snapshot home.
const home = process.env.CLAUDE_CONTEXT_HOME;
if (!home || home.includes('claude-control-center')) {
  process.stderr.write(`[smoke-dual] REFUSING: CLAUDE_CONTEXT_HOME=${home}\n`);
  process.exit(2);
}

const secondaryConfigured = !!process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
process.stderr.write(
  `[smoke-dual] secondary configured: ${secondaryConfigured} (MILVUS_COLLECTION_PRIVATE_0P6B=${process.env.MILVUS_COLLECTION_PRIVATE_0P6B ?? 'unset'})\n`
);

const binaryPath = path.join(repoRoot, 'packages/mcp/dist/index.js');

const child = spawn(process.execPath, [binaryPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stdoutBuf = '';
let stderrBuf = '';
const stdoutMessages = [];
let nonJsonStdout = false;

child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (line.trim().length === 0) continue;
    try { stdoutMessages.push(JSON.parse(line)); }
    catch { process.stderr.write(`[smoke-dual] non-JSON on stdout: ${line.slice(0, 200)}\n`); nonJsonStdout = true; }
  }
});
child.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf8'); });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

const expect = async (id, timeoutMs = 120_000) => {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    while (stdoutMessages.length) {
      const msg = stdoutMessages.shift();
      if (msg.id === id) return msg;
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for id=${id}`);
};

// ── assertion harness ──────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

let exitCode = 0;
try {
  // ── initialize ────────────────────────────────────────────────────────────
  send({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-dual', version: '1.0' } } });
  const initResp = await expect(1);
  if (initResp.error) {
    process.stderr.write(`[smoke-dual] initialize error: ${JSON.stringify(initResp.error)}\n`);
    exitCode = 4; throw new Error('initialize failed');
  }

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  // ── tools/list — assert embeddingModel enum ───────────────────────────────
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tlResp = await expect(2);
  if (tlResp.error) {
    process.stderr.write(`[smoke-dual] tools/list error: ${JSON.stringify(tlResp.error)}\n`);
    exitCode = 4; throw new Error('tools/list failed');
  }

  const tools = tlResp.result?.tools ?? [];
  const searchTool = tools.find(t => t.name === 'search_code');
  check('search_code tool present in tools/list', !!searchTool,
    `tools=${tools.map(t=>t.name).join(',')}`);

  // Parse embeddingModel enum — must be an array of strings, never substring.
  const embModelEnum = searchTool?.inputSchema?.properties?.embeddingModel?.enum;
  check('embeddingModel property exists in search_code inputSchema',
    Array.isArray(embModelEnum),
    `inputSchema.properties.embeddingModel=${JSON.stringify(searchTool?.inputSchema?.properties?.embeddingModel)}`);
  check('embeddingModel enum contains qwen3-embedding-8b',
    Array.isArray(embModelEnum) && embModelEnum.includes('qwen3-embedding-8b'),
    `enum=${JSON.stringify(embModelEnum)}`);
  check('embeddingModel enum contains qwen3-embedding-0.6b',
    Array.isArray(embModelEnum) && embModelEnum.includes('qwen3-embedding-0.6b'),
    `enum=${JSON.stringify(embModelEnum)}`);

  if (nonJsonStdout) {
    process.stderr.write('[smoke-dual] FAIL: non-JSON on stdout detected before tools/call\n');
    exitCode = 3; throw new Error('non-JSON stdout');
  }

  // ── tools/call search_code with embeddingModel=qwen3-embedding-0.6b ───────
  send({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {
      name: 'search_code',
      arguments: {
        query: 'embedding model selection test',
        path: process.env.CLAUDE_CONTEXT_HOME,
        embeddingModel: 'qwen3-embedding-0.6b',
      },
    },
  });
  const callResp = await expect(3, 60_000);
  if (callResp.error) {
    // A JSON-RPC level error (not a tool-level error) means routing is broken.
    process.stderr.write(`[smoke-dual] tools/call error: ${JSON.stringify(callResp.error)}\n`);
    exitCode = 5; throw new Error('tools/call returned JSON-RPC error');
  }

  // The result content is an array of content items; extract the text.
  const resultText = (callResp.result?.content ?? [])
    .map(c => (typeof c === 'object' && c !== null ? (c.text ?? '') : String(c)))
    .join(' ')
    .toLowerCase();

  if (secondaryConfigured) {
    // D6 path: secondary is configured — assert stderr shows the routing.
    // Parse stderr for structured JSON log lines (lines emitted by the binary as JSON objects).
    const stderrLines = stderrBuf.split('\n').filter(l => l.trim().startsWith('{'));
    const routingLine = stderrLines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .find(o => o.queue === 'embedding.qwen3-0.6b' && o.dim === 1024);

    check('D6: stderr shows queue=embedding.qwen3-0.6b + dim=1024 for 0.6b call (parsed JSON)',
      !!routingLine,
      `stderrJSONLines=${JSON.stringify(stderrLines.slice(0, 5))}`);
  } else {
    // D7 path: secondary not configured — assert clear notice in result text.
    check('D7: unconfigured secondary returns clear notice (not a dim-mismatch error)',
      resultText.includes('not configured') || resultText.includes('secondary') || resultText.includes('model'),
      `resultText=${resultText.slice(0, 200)}`);
    // Additionally assert NO dim-mismatch error on stderr.
    const hasDimMismatch = stderrBuf.toLowerCase().includes('dim=4096') &&
      stderrBuf.toLowerCase().includes('expected=1024');
    check('D7: no dim-mismatch ANN call on stderr', !hasDimMismatch,
      'dim-mismatch string found in stderr — 8B instance was used for a 0.6B query');
  }

  if (nonJsonStdout) {
    process.stderr.write('[smoke-dual] FAIL: non-JSON on stdout after tools/call\n');
    exitCode = 3; throw new Error('non-JSON stdout');
  }

  process.stderr.write('[smoke-dual] OK\n');

} catch (e) {
  process.stderr.write(`[smoke-dual] ${e.message}\nstderr tail:\n${stderrBuf.slice(-2000)}\n`);
  if (exitCode === 0) exitCode = 5;
} finally {
  child.kill('SIGTERM');
  await sleep(100);
  process.exit(failures > 0 ? 1 : exitCode);
}
```

**Register in `packages/mcp/package.json`:**
```json
"test:smoke-dual": "pnpm build && CLAUDE_CONTEXT_HOME=%TMP%\\cc-smoke-dual node scripts/jsonrpc-smoke-dual.mjs"
```

(On Windows, the env var expansion uses the wrapper; on CI/Linux, use `CLAUDE_CONTEXT_HOME=/tmp/cc-smoke-dual`.)

---

### Gate E3: `packages/mcp/scripts/milvus-dedup-probe.mjs` (FULL SOURCE)

Paginated-scroll of `id` values for a Milvus collection; prints `{total, distinct, dupCount}` as JSON to stdout; triggers `compact()` + waits if `distinct < total`; then re-measures and prints `{afterTotal, afterDistinct}`. Uses `queryIterator` (the same API as `milvus-vectordb.ts:528`) directly via `@zilliz/milvus2-sdk-node`.

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/milvus-dedup-probe.mjs
//
// Dedup / compaction probe for a Milvus collection (Gate E3 / LD-11).
// Paginated-scrolls all `id` values using queryIterator (keyset pagination;
// v2.6.9 has no COUNT(DISTINCT) — we do it client-side with a Set).
// Prints { collection, total, distinct, dupCount } as a JSON line to stdout.
// If dupCount > 0, triggers compact() + waits for it to finish, then re-measures.
// Prints { afterTotal, afterDistinct, afterDupCount } as a second JSON line to stdout.
//
// Required env:
//   MILVUS_ADDRESS    e.g. 127.0.0.1:19530
//   MILVUS_COLLECTION e.g. claude_context_own
// Optional:
//   MILVUS_TOKEN
//   MILVUS_BATCH_SIZE (default 10000)
//   COMPACT_WAIT_MS   (default 30000 — wait for compaction to seal)
//
// Exits 0 when distinct===total (before or after compaction).
// Exits 1 when dupCount > 0 after compaction (needs investigation).
// Exits 2 on configuration error.
// Exits 3 on Milvus API error.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const address = process.env.MILVUS_ADDRESS;
const collection = process.env.MILVUS_COLLECTION;
const token = process.env.MILVUS_TOKEN;
const batchSize = parseInt(process.env.MILVUS_BATCH_SIZE ?? '10000', 10);
const compactWaitMs = parseInt(process.env.COMPACT_WAIT_MS ?? '30000', 10);

if (!address) { process.stderr.write('[dedup-probe] MILVUS_ADDRESS required\n'); process.exit(2); }
if (!collection) { process.stderr.write('[dedup-probe] MILVUS_COLLECTION required\n'); process.exit(2); }

// Import MilvusClient from the dist that ships with the mcp package's dependency.
// We use the SDK directly (not via our MilvusVectorDatabase wrapper) so we can call
// compact() which is not exposed through the wrapper interface.
const sdkPath = path.resolve(repoRoot, 'node_modules/@zilliz/milvus2-sdk-node/dist/milvus/MilvusClient.js');
let MilvusClient;
try {
  const mod = await import(pathToFileURL(sdkPath).href);
  MilvusClient = mod.MilvusClient ?? mod.default?.MilvusClient;
  if (!MilvusClient) throw new Error('MilvusClient not found in module');
} catch (e) {
  process.stderr.write(`[dedup-probe] FAIL: cannot import MilvusClient from ${sdkPath}: ${e.message}\n`);
  process.exit(3);
}

const client = new MilvusClient({ address, token: token || undefined, ssl: false });

/**
 * Paginated scroll of all `id` values in the collection.
 * Returns { total, distinct, dupCount } with distinct computed via a Set.
 */
async function measureDedup() {
  const ids = new Set();
  let total = 0;

  try {
    const iterator = await client.queryIterator({
      collection_name: collection,
      output_fields: ['id'],
      batchSize,
      expr: '',
    });

    for await (const batch of iterator) {
      for (const row of batch) {
        total++;
        ids.add(row.id);
      }
    }
  } catch (e) {
    process.stderr.write(`[dedup-probe] queryIterator error: ${e.message}\n`);
    process.exit(3);
  }

  return { total, distinct: ids.size, dupCount: total - ids.size };
}

let exitCode = 0;

try {
  process.stderr.write(`[dedup-probe] scrolling collection=${collection} address=${address} batchSize=${batchSize}\n`);

  const before = await measureDedup();
  // Write measurement as JSON to stdout (parseable by callers).
  process.stdout.write(JSON.stringify({ collection, ...before }) + '\n');
  process.stderr.write(`[dedup-probe] before: total=${before.total} distinct=${before.distinct} dupCount=${before.dupCount}\n`);

  if (before.dupCount === 0) {
    process.stderr.write('[dedup-probe] OK — no duplicates detected\n');
    process.exit(0);
  }

  // Duplicates found — trigger compaction.
  process.stderr.write(`[dedup-probe] ${before.dupCount} duplicate PKs — triggering compact()\n`);
  try {
    const compactResp = await client.compact({ collection_name: collection });
    const compactionId = compactResp.compactionID ?? compactResp.compaction_id;
    process.stderr.write(`[dedup-probe] compact() submitted compactionID=${compactionId}, waiting ${compactWaitMs}ms\n`);

    // Wait for compaction — poll getCompactionState
    const deadline = Date.now() + compactWaitMs;
    let state = 'Executing';
    while (Date.now() < deadline && state !== 'Completed') {
      await sleep(2000);
      try {
        const stateResp = await client.getCompactionState({ compactionID: compactionId });
        state = stateResp.state ?? stateResp.compaction_state ?? state;
        process.stderr.write(`[dedup-probe] compaction state=${state}\n`);
      } catch (e) {
        process.stderr.write(`[dedup-probe] getCompactionState error (continuing): ${e.message}\n`);
      }
    }
    if (state !== 'Completed') {
      process.stderr.write(`[dedup-probe] compaction did not complete within ${compactWaitMs}ms (state=${state}) — re-measuring anyway\n`);
    }
  } catch (e) {
    process.stderr.write(`[dedup-probe] compact() error: ${e.message} — re-measuring without compaction\n`);
  }

  // Re-measure after compaction.
  const after = await measureDedup();
  process.stdout.write(JSON.stringify({ collection, afterTotal: after.total, afterDistinct: after.distinct, afterDupCount: after.dupCount }) + '\n');
  process.stderr.write(`[dedup-probe] after: total=${after.total} distinct=${after.distinct} dupCount=${after.dupCount}\n`);

  if (after.dupCount > 0) {
    process.stderr.write(`[dedup-probe] WARN: ${after.dupCount} duplicates remain after compaction — manual investigation needed\n`);
    exitCode = 1;
  } else {
    process.stderr.write('[dedup-probe] OK — dedup complete\n');
  }

} catch (e) {
  process.stderr.write(`[dedup-probe] unexpected error: ${e.stack ?? e.message}\n`);
  exitCode = 3;
} finally {
  try { if (client && typeof client.closeConnection === 'function') await client.closeConnection(); } catch { /* ignore */ }
  process.exit(exitCode);
}
```

**Register in `packages/mcp/package.json`:**
```json
"probe:dedup": "node scripts/milvus-dedup-probe.mjs"
```

---

### Gate G1/D4: `packages/mcp/scripts/probe-0p6b-worker.mjs` (FULL SOURCE)

Live 0.6B worker round-trip on `embedding.qwen3-0.6b` at priority 8 (test, never 10 which is production interactive; never purge the shared queue). Asserts `inner[0].length === 1024` and L2 norm in (0.5, 2.0). Also runs a two-instance reply-isolation smoke (cheap insurance, structurally correct but cheap to verify).

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/probe-0p6b-worker.mjs
//
// Live Qwen3-0.6B worker probe (Gate G1/D4).
// Uses production code path (RabbitMQEmbedding from core dist).
// Priority 8 (test tier) — never purge the shared embedding.qwen3-0.6b queue.
//
// Asserts (parsed JSON, never substring):
//   1. vector length === 1024
//   2. L2 norm in (0.5, 2.0)  [same bounds as rabbitmq-embedding.ts:217]
//   3. Two-instance reply isolation smoke: two concurrent embeds on two separate
//      RabbitMQEmbedding instances with DIFFERENT dimensions (4096 + 1024) do NOT
//      cross-contaminate (each gets back the correct dimension). This is structurally
//      impossible due to private exclusive reply queues (rabbitmq-embedding.ts:154)
//      but is cheap insurance.
//
// Required env:
//   RABBITMQ_INFERENCE_URL
// Optional:
//   RABBITMQ_EMBEDDING_QUEUE_0P6B  (default: embedding.qwen3-0.6b)
//   RABBITMQ_EMBEDDING_QUEUE_8B    (default: embedding.qwen3-8b)  [for isolation smoke only]
//
// Exits 0 on pass, non-zero on first failed assertion.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const url = process.env.RABBITMQ_INFERENCE_URL;
if (!url) { process.stderr.write('[probe-0p6b] RABBITMQ_INFERENCE_URL required\n'); process.exit(2); }
if (url.includes('127.0.0.1:1') || url.includes('noop')) {
  process.stderr.write('[probe-0p6b] REFUSING noop URL\n'); process.exit(3);
}

const queue0p6b = process.env.RABBITMQ_EMBEDDING_QUEUE_0P6B ?? 'embedding.qwen3-0.6b';
const queue8b   = process.env.RABBITMQ_EMBEDDING_QUEUE_8B   ?? 'embedding.qwen3-8b';

// Load RabbitMQEmbedding from core dist (same convention as probe-rabbitmq-worker.mjs).
const rmqPath = path.resolve(repoRoot, 'packages/core/dist/embedding/rabbitmq-embedding.js');
const toFileUrl = (p) => p.startsWith('file:') ? p : pathToFileURL(p).href;
const mod = await import(toFileUrl(rmqPath));
const RabbitMQEmbedding = mod.RabbitMQEmbedding ?? mod.default?.RabbitMQEmbedding;
if (!RabbitMQEmbedding) {
  process.stderr.write(`[probe-0p6b] RabbitMQEmbedding not exported from ${rmqPath}\n`);
  process.exit(4);
}

// ── assertion harness ──────────────────────────────────────────────────────────
let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

/**
 * Construct a RabbitMQEmbedding instance and call embedBatch(['test']).
 * Returns the extracted vector (number[]) or throws.
 * Priority 8 = test tier; never use 10 (production interactive priority).
 */
async function singleEmbed(queue, dim, label) {
  const emb = new RabbitMQEmbedding({
    url,
    queue,
    modelName: queue.includes('0.6b') ? 'qwen3-embedding-0.6b' : 'qwen3-embedding-8b',
    dimension: dim,
    priority: 8, // test tier — never purge, yield to priority-9+ production traffic
    concurrency: 1,
  });
  try {
    let raw;
    if (typeof emb.embedBatch === 'function') {
      raw = await emb.embedBatch(['test']);
    } else if (typeof emb.embed === 'function') {
      const r = await emb.embed('test');
      raw = Array.isArray(r) ? r : [r];
    } else {
      throw new Error(`${label}: no embedBatch or embed method`);
    }

    if (!Array.isArray(raw) || raw.length !== 1) {
      throw new Error(`${label}: result is not a 1-element array: ${JSON.stringify(raw)}`);
    }
    const item = raw[0];
    let vec;
    if (Array.isArray(item)) vec = item;
    else if (item && Array.isArray(item.vector)) vec = item.vector;
    else if (item && typeof item.length === 'number') vec = Array.from(item);
    else throw new Error(`${label}: cannot extract vector from item: ${JSON.stringify(item)}`);

    return vec;
  } finally {
    if (typeof emb.close === 'function') {
      try { await emb.close(); } catch { /* ignore */ }
    }
  }
}

let exitCode = 0;
try {
  // ── G1/D4: 0.6B round-trip ────────────────────────────────────────────────
  process.stderr.write(`[probe-0p6b] probing queue=${queue0p6b} dim=1024 priority=8\n`);
  const vec0p6b = await singleEmbed(queue0p6b, 1024, '0.6b');

  // All assertions on parsed objects, never substring.
  check('G1/D4: vector length === 1024',
    vec0p6b.length === 1024,
    `actual length=${vec0p6b.length}`);

  let sumSq = 0;
  for (let i = 0; i < vec0p6b.length; i++) sumSq += vec0p6b[i] * vec0p6b[i];
  const norm0p6b = Math.sqrt(sumSq);
  check('G1/D4: L2 norm in (0.5, 2.0)',
    norm0p6b > 0.5 && norm0p6b < 2.0,
    `norm=${norm0p6b.toFixed(4)}`);

  // Print result as structured JSON to stdout for audit trail.
  process.stdout.write(JSON.stringify({
    gate: 'G1/D4',
    queue: queue0p6b,
    dim: vec0p6b.length,
    norm: parseFloat(norm0p6b.toFixed(4)),
    pass: vec0p6b.length === 1024 && norm0p6b > 0.5 && norm0p6b < 2.0,
  }) + '\n');

  // ── Two-instance reply isolation smoke ────────────────────────────────────
  // Run 8B and 0.6B concurrently. Each has a private exclusive reply queue
  // (rabbitmq-embedding.ts:154 — `assertQueue('', {exclusive:true,autoDelete:true})`),
  // so cross-contamination is structurally impossible. This smoke confirms it cheaply.
  process.stderr.write(`[probe-0p6b] reply-isolation smoke: concurrent 8B(${queue8b}) + 0.6B(${queue0p6b})\n`);
  const [vec8b, vec0p6b2] = await Promise.all([
    singleEmbed(queue8b, 4096, '8b-isolation'),
    singleEmbed(queue0p6b, 1024, '0.6b-isolation'),
  ]);

  check('isolation: 8B result has dim=4096', vec8b.length === 4096, `actual=${vec8b.length}`);
  check('isolation: 0.6B result has dim=1024', vec0p6b2.length === 1024, `actual=${vec0p6b2.length}`);
  check('isolation: 8B and 0.6B results are different lengths (no cross-contamination)',
    vec8b.length !== vec0p6b2.length, `both=${vec8b.length}`);

  process.stdout.write(JSON.stringify({
    gate: 'isolation-smoke',
    dim8b: vec8b.length,
    dim0p6b: vec0p6b2.length,
    isolated: vec8b.length !== vec0p6b2.length,
  }) + '\n');

  process.stderr.write(`[probe-0p6b] ${failures === 0 ? 'OK' : `FAIL (${failures} assertion(s))`}\n`);

} catch (e) {
  process.stderr.write(`[probe-0p6b] ERROR: ${e.stack ?? e.message}\n`);
  exitCode = 1;
}

process.exit(failures > 0 ? 1 : exitCode);
```

**Register in `packages/mcp/package.json`:**
```json
"probe:0p6b": "node scripts/probe-0p6b-worker.mjs"
```

---

### Gate N3: `packages/mcp/scripts/plan-sync-sha256.mjs` (FULL SOURCE)

Runs the 6-copy sync from source-of-truth then asserts a single SHA256 across all 6 paths. Exit-code gate. This is the audit A1 check.

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/plan-sync-sha256.mjs
//
// Gate N3/A1: assert all 6 plan copies are byte-identical by comparing SHA256.
// Run AFTER the sync command that copies from source-of-truth:
//   node packages/mcp/scripts/plan-sync-sha256.mjs
//
// If copies are missing or have different SHA256, exits non-zero with a diff.
// Does NOT perform the sync itself — call the sync first (see plan section "Sync rule").
//
// Exits 0 when all 6 files exist and share the same SHA256.
// Exits 1 when any file is missing or has a different SHA256.

import fs from 'node:fs';
import { createHash } from 'node:crypto';

const PLAN_FILENAME = '2026-06-14-dual-embedding.md';

const PATHS = [
  // Formal (version-controlled) copies
  String.raw`E:\Developer\lufftw\repo\claude-context\docs\plan\${PLAN_FILENAME}`,
  String.raw`E:\Developer\lufftw\repo\milvus-services\docs\plan\${PLAN_FILENAME}`,
  String.raw`E:\Developer\lufftw\repo\mcp-services\docs\plan\${PLAN_FILENAME}`,
  // Workspace working copies
  String.raw`E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\${PLAN_FILENAME}`,
  String.raw`E:\Developer\lufftw\repo\milvus-services-workspace\docs\plan\${PLAN_FILENAME}`,
  String.raw`E:\Developer\lufftw\repo\mcp-services-workspace\docs\plan\${PLAN_FILENAME}`,
].map(p => p.replace(/\$\{PLAN_FILENAME\}/g, PLAN_FILENAME));

function sha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

let failures = 0;
let referenceHash = null;
const results = [];

for (const p of PATHS) {
  if (!fs.existsSync(p)) {
    process.stderr.write(`  FAIL missing: ${p}\n`);
    failures++;
    results.push({ path: p, hash: null, match: false });
    continue;
  }
  const hash = sha256(p);
  if (referenceHash === null) referenceHash = hash;
  const match = hash === referenceHash;
  if (match) {
    process.stderr.write(`  PASS ${hash.slice(0, 12)}... ${p}\n`);
  } else {
    process.stderr.write(`  FAIL hash mismatch: expected ${referenceHash.slice(0,12)}... got ${hash.slice(0,12)}...\n       ${p}\n`);
    failures++;
  }
  results.push({ path: p, hash, match });
}

// Write JSON summary to stdout for audit artifact.
process.stdout.write(JSON.stringify({
  gate: 'N3/A1',
  planFile: PLAN_FILENAME,
  referenceHash,
  allMatch: failures === 0,
  results,
}) + '\n');

process.stderr.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${PATHS.length} paths, ${failures} mismatch(es)\n`);
process.exit(failures === 0 ? 0 : 1);
```

**Register in `packages/mcp/package.json`:**
```json
"test:plan-sync": "node scripts/plan-sync-sha256.mjs"
```

---

### Gate: `packages/mcp/scripts/dual-config-smoke.mjs` (FULL SOURCE)

Verifies that no-secondary-config leaves single-model resolution byte-identical (B3/C1 config path). Imports `dist/config.js` directly.

```javascript
#!/usr/bin/env node
// packages/mcp/scripts/dual-config-smoke.mjs
//
// Config dual-embedding smoke (Phase 0.2 gate).
// Asserts:
//   1. With NO secondary env vars set: searchEmbeddingModel='qwen3-embedding-8b',
//      milvusCollectionPrivate0p6b=undefined.
//   2. With MILVUS_COLLECTION_PRIVATE_0P6B set: milvusCollectionPrivate0p6b='<value>',
//      rabbitmqSecondaryQueue and rabbitmqSecondaryDimension populated from env or default.
//   3. EMBEDDING_DUAL_WRITE is NOT a field in the config object (key must be absent).
//
// All assertions on parsed objects, never substring.
// Exits 0 on pass, non-zero on first failure.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const configDist = path.resolve(repoRoot, 'packages/mcp/dist/config.js');

import fs from 'node:fs';
if (!fs.existsSync(configDist)) {
  process.stderr.write(`[dual-config-smoke] MISSING: ${configDist}\nRun pnpm build:mcp first.\n`);
  process.exit(2);
}

const { createMcpConfig } = await import(pathToFileURL(configDist).href);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    process.stderr.write(`  PASS ${name}\n`);
  } else {
    failures++;
    process.stderr.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// ── Scenario 1: no secondary env vars ──────────────────────────────────────
{
  const saved = {};
  const clearKeys = [
    'MILVUS_COLLECTION_PRIVATE_0P6B',
    'RABBITMQ_SECONDARY_QUEUE',
    'RABBITMQ_SECONDARY_DIMENSION',
    'RABBITMQ_SECONDARY_MODEL',
    'SEARCH_EMBEDDING_MODEL',
    'EMBEDDING_DUAL_WRITE',
  ];
  for (const k of clearKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  // Also clear provider to avoid OpenAI key errors in config construction
  saved.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER;
  process.env.EMBEDDING_PROVIDER = 'RabbitMQ';
  saved.RABBITMQ_INFERENCE_URL = process.env.RABBITMQ_INFERENCE_URL;
  process.env.RABBITMQ_INFERENCE_URL = 'amqp://test:test@127.0.0.1:1/inference';
  saved.RABBITMQ_EMBEDDING_QUEUE = process.env.RABBITMQ_EMBEDDING_QUEUE;
  process.env.RABBITMQ_EMBEDDING_QUEUE = 'embedding.qwen3-8b';

  let config;
  try { config = createMcpConfig(); }
  catch (e) { process.stderr.write(`[dual-config-smoke] createMcpConfig() threw: ${e.message}\n`); process.exit(3); }

  check('Scenario1: searchEmbeddingModel defaults to qwen3-embedding-8b',
    config.searchEmbeddingModel === 'qwen3-embedding-8b',
    `actual=${JSON.stringify(config.searchEmbeddingModel)}`);
  check('Scenario1: milvusCollectionPrivate0p6b is undefined',
    config.milvusCollectionPrivate0p6b === undefined,
    `actual=${JSON.stringify(config.milvusCollectionPrivate0p6b)}`);
  check('Scenario1: rabbitmqSecondaryQueue is undefined',
    config.rabbitmqSecondaryQueue === undefined,
    `actual=${JSON.stringify(config.rabbitmqSecondaryQueue)}`);
  check('Scenario1: EMBEDDING_DUAL_WRITE key is NOT present in config (P6 deletion)',
    !('embeddingDualWrite' in config) && !('EMBEDDING_DUAL_WRITE' in config),
    `config keys: ${Object.keys(config).join(',')}`);

  for (const k of clearKeys) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  for (const k of ['EMBEDDING_PROVIDER','RABBITMQ_INFERENCE_URL','RABBITMQ_EMBEDDING_QUEUE']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

// ── Scenario 2: secondary activated via MILVUS_COLLECTION_PRIVATE_0P6B ─────
{
  const saved = {};
  const setKeys = {
    MILVUS_COLLECTION_PRIVATE_0P6B: 'claude_context_own_0p6b',
    RABBITMQ_SECONDARY_QUEUE: 'embedding.qwen3-0.6b',
    RABBITMQ_SECONDARY_DIMENSION: '1024',
    RABBITMQ_SECONDARY_MODEL: 'qwen3-embedding-0.6b',
    SEARCH_EMBEDDING_MODEL: 'qwen3-embedding-8b',
    EMBEDDING_PROVIDER: 'RabbitMQ',
    RABBITMQ_INFERENCE_URL: 'amqp://test:test@127.0.0.1:1/inference',
    RABBITMQ_EMBEDDING_QUEUE: 'embedding.qwen3-8b',
  };
  for (const [k,v] of Object.entries(setKeys)) { saved[k] = process.env[k]; process.env[k] = v; }

  let config;
  try { config = createMcpConfig(); }
  catch (e) { process.stderr.write(`[dual-config-smoke] Scenario2 createMcpConfig() threw: ${e.message}\n`); process.exit(3); }

  check('Scenario2: milvusCollectionPrivate0p6b populated',
    config.milvusCollectionPrivate0p6b === 'claude_context_own_0p6b',
    `actual=${JSON.stringify(config.milvusCollectionPrivate0p6b)}`);
  check('Scenario2: rabbitmqSecondaryQueue populated',
    config.rabbitmqSecondaryQueue === 'embedding.qwen3-0.6b',
    `actual=${JSON.stringify(config.rabbitmqSecondaryQueue)}`);
  check('Scenario2: rabbitmqSecondaryDimension is 1024 (number)',
    config.rabbitmqSecondaryDimension === 1024,
    `actual=${JSON.stringify(config.rabbitmqSecondaryDimension)}`);
  check('Scenario2: rabbitmqSecondaryModel populated',
    config.rabbitmqSecondaryModel === 'qwen3-embedding-0.6b',
    `actual=${JSON.stringify(config.rabbitmqSecondaryModel)}`);
  check('Scenario2: searchEmbeddingModel is qwen3-embedding-8b',
    config.searchEmbeddingModel === 'qwen3-embedding-8b',
    `actual=${JSON.stringify(config.searchEmbeddingModel)}`);

  for (const [k] of Object.entries(setKeys)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

process.stderr.write(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
```

**Register in `packages/mcp/package.json`:**
```json
"test:dual-config": "pnpm build && node scripts/dual-config-smoke.mjs"
```

---

### `packages/mcp/package.json` scripts block — full corrected scripts section

The current scripts section (lines 9–20, verified):

```json
"scripts": {
    "build": "pnpm clean && tsc --build --force",
    "dev": "tsx --watch src/index.ts",
    "clean": "rimraf dist",
    "lint": "eslint src --ext .ts",
    "lint:fix": "eslint src --ext .ts --fix",
    "typecheck": "tsc --noEmit",
    "test:ledger": "pnpm build && node scripts/snapshot-ledger.test.mjs",
    "start": "tsx src/index.ts",
    "start:with-env": "OPENAI_API_KEY=${OPENAI_API_KEY:your-api-key-here} MILVUS_ADDRESS=${MILVUS_ADDRESS:localhost:19530} tsx src/index.ts",
    "prepublishOnly": "pnpm build"
},
```

Full replacement with all new scripts added:

```json
"scripts": {
    "build": "pnpm clean && tsc --build --force",
    "dev": "tsx --watch src/index.ts",
    "clean": "rimraf dist",
    "lint": "eslint src --ext .ts",
    "lint:fix": "eslint src --ext .ts --fix",
    "typecheck": "tsc --noEmit",
    "test:ledger": "pnpm build && node scripts/snapshot-ledger.test.mjs",
    "test:dual-config": "pnpm build && node scripts/dual-config-smoke.mjs",
    "test:smoke-dual": "pnpm build && node scripts/jsonrpc-smoke-dual.mjs",
    "probe:0p6b": "node scripts/probe-0p6b-worker.mjs",
    "probe:dedup": "node scripts/milvus-dedup-probe.mjs",
    "test:plan-sync": "node scripts/plan-sync-sha256.mjs",
    "start": "tsx src/index.ts",
    "start:with-env": "OPENAI_API_KEY=${OPENAI_API_KEY:your-api-key-here} MILVUS_ADDRESS=${MILVUS_ADDRESS:localhost:19530} tsx src/index.ts",
    "prepublishOnly": "pnpm build"
},
```

---

## Phase 6 task list (executable checklist)

### Task 6.0 — TDD gate sequence (each step is independently committable)

- [ ] **6.0.1** `pnpm --filter @zilliz/claude-context-core test -- --testPathPattern=model-registry` → exit 0 (Task 0.1 gate)
- [ ] **6.0.2** `pnpm typecheck` → exit 0 (Task 0.2 compile gate)
- [ ] **6.0.3** `pnpm build:mcp && node packages/mcp/scripts/dual-config-smoke.mjs` → exit 0 (Task 0.2 runtime gate)
- [ ] **6.0.4** `pnpm build:mcp && node packages/mcp/scripts/snapshot-ledger.test.mjs` → exit 0 (existing; must stay green)
- [ ] **6.0.5** `CLAUDE_CONTEXT_HOME=%TMP%\cc-smoke-dual pnpm build:mcp && node packages/mcp/scripts/jsonrpc-smoke-dual.mjs` → exit 0 (D6/D7 gate; D7 path when secondary unconfigured)
- [ ] **6.0.6** `RABBITMQ_INFERENCE_URL=<real> node packages/mcp/scripts/probe-0p6b-worker.mjs` → exit 0 (G1/D4 gate; live infra required; priority=8)
- [ ] **6.0.7** `MILVUS_ADDRESS=127.0.0.1:19530 MILVUS_COLLECTION=claude_context_own node packages/mcp/scripts/milvus-dedup-probe.mjs` → exit 0 if no dups, exit 1 if dups remain after compaction (E3 gate; live infra required)
- [ ] **6.0.8** After sync: `node packages/mcp/scripts/plan-sync-sha256.mjs` → exit 0 (A1/N3 gate)

### Task 6.1 — Docs (F1, F2, F3)

- [ ] `milvus-services/docs/claude-context/project-registry.md`: add `claude_context_own_0p6b` row (dim=1024, COSINE, queue=embedding.qwen3-0.6b).
- [ ] `milvus-services/docs/claude-context/env-variable-reference.md`: document `RABBITMQ_SECONDARY_QUEUE`, `RABBITMQ_SECONDARY_DIMENSION`, `RABBITMQ_SECONDARY_MODEL`, `MILVUS_COLLECTION_PRIVATE_0P6B`, `SEARCH_EMBEDDING_MODEL`; explicitly mark `EMBEDDING_DUAL_WRITE` as **deferred, not implemented in v0.1.4-lufftw.4**.
- [ ] `mcp-services/docs/claude-context/usage-guide.md`: enabling secondary, `SEARCH_EMBEDDING_MODEL` per-session selection, LD-0 operator rule.
- [ ] `claude-context/CLAUDE.md` Embedding Provider Matrix: add a "Dual-model (Option B)" row + note that `EMBEDDING_DUAL_WRITE` is deferred.
- [ ] `claude-context/docs/lufftw/design-2026-06-14-dual-embedding.md`: write condensed design note with LD table.

### Task 6.2 — Plan sync + A1 gate

```powershell
$src = "E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-14-dual-embedding.md"
foreach ($dst in @(
  "E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\milvus-services\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\milvus-services-workspace\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\mcp-services\docs\plan\2026-06-14-dual-embedding.md",
  "E:\Developer\lufftw\repo\mcp-services-workspace\docs\plan\2026-06-14-dual-embedding.md"
)) { New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null; Copy-Item -Force $src $dst }
node packages/mcp/scripts/plan-sync-sha256.mjs
```

---

## Cross-phase coupling notes (residual risk, carry into execution)

1. **`console.log` → `console.error` in `config.ts` and `embedding.ts`:** The existing `createMcpConfig` uses `console.log` for all debug output (lines 158–166, verified). These write to stdout and will corrupt the JSON-RPC stream. Phase 0.2 fixes the `createMcpConfig` block. Phase 4.1 fixes `logConfigurationSummary` and `logEmbeddingProviderInfo`. Both changes must land before the jsonrpc-smoke-dual gate runs, as the smoke asserts no non-JSON on stdout.

2. **`EnvManager` caching:** `envManager.get()` is called at `createMcpConfig()` invocation time. The `dual-config-smoke.mjs` gate modifies `process.env` directly before calling `createMcpConfig()`. If `EnvManager` caches values at module import time this will fail. Verify by inspecting `packages/core/src/utils/env-manager.ts` — if it caches, the gate must use subprocess isolation instead of in-process env mutation. The gate is written with save/restore of `process.env` as a pragmatic first attempt; if EnvManager is cached, each scenario must be run in a separate subprocess.

3. **`milvus2-sdk-node` import path for `milvus-dedup-probe.mjs`:** The probe imports `MilvusClient` directly from the SDK's dist. The exact path `node_modules/@zilliz/milvus2-sdk-node/dist/milvus/MilvusClient.js` must be verified against the installed version at execution time — SDK internal paths can change between minor versions. If the path fails, fall back to `node_modules/@zilliz/milvus2-sdk-node/dist/index.js` and access `MilvusClient` from the main export.

---

## Phase 7 — Documentation sync + 6-copy plan sync

**Goal:** synchronize all cross-repo docs to the shipped behavior and enforce the VC-policy invariant.

- **Task 7.1 (milvus-services, audit F1):** in `docs/claude-context/` — `project-registry.md` (add the `claude_context_own_0p6b` row + a "per-model secondary collection" note), `env-variable-reference.md` (add `RABBITMQ_SECONDARY_QUEUE/DIMENSION/MODEL`, `MILVUS_COLLECTION_PRIVATE_0P6B`, `SEARCH_EMBEDDING_MODEL`; **state that `EMBEDDING_DUAL_WRITE` is NOT introduced** — dual-write stays governed by `MILVUS_WRITABLE_SHARED`, per P6), `collection-strategies.md` (Option-B per-model collection strategy), `onboarding-checklist.md` (how to enable 0.6B for a project). Commit.
- **Task 7.2 (mcp-services, audit F2):** `docs/claude-context/usage-guide.md` — enabling the secondary, selecting per query via `embeddingModel`, and the **LD-0** rule that the operator owning the LLM sets `SEARCH_EMBEDDING_MODEL` (no auto-detection). Commit.
- **Task 7.3 (claude-context, audit F3 + N2):** update `CLAUDE.md` (Embedding Provider Matrix / fork deviations → dual-model collections); write `docs/lufftw/design-2026-06-14-dual-embedding.md` (condensed design + the LD-0..LD-12 table + the M1–M8 corrections). Commit.
- **Task 7.4 (N3, audit A1):** run the 6-copy sync FROM the source-of-truth (`claude-context\docs\plan\2026-06-14-dual-embedding.md`), then assert a **single distinct SHA256** across all 6 paths (exit-code gate). Only the `claude-context` formal copy is editable; the other 5 mirror it.
- **Task 7.5:** run the full **Plan Completion Audit Checklist** (A–F), checking every box with its verification artifact. Then `superpowers:finishing-a-development-branch`.

---

## Out of scope (Phase 2 / deferred — explicit YAGNI cuts)

- `event_shared` (9.3GB) 0.6B backfill — gated on measured throughput from the MVP small run.
- **Mirror-from-8B** backfill (source B) — gated on dedup/compaction; client-side PK dedup required.
- **Live `EMBEDDING_DUAL_WRITE`** path — wired-but-OFF; deferred (doubles interactive GPU; use offline priority=1 backfill).
- **GPU auto-detection / timeout-fallback** — cut (contention is LLM-vs-8B, unobservable here; orchestrator sets the model).
- **Cross-model RRF / score-merge** — cut (incoherent across 4096/1024 spaces).
- Registry `storageField` (field is always `vector`) and `rerankByDefault` — cut from v1.
- Shared-collection secondary override env keys, per-call connection pooling — deferred.