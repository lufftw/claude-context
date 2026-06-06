# Milvus Duplicate-PK Dedup — Migration Plan (PLAN ONLY — NO EXECUTION)

> **Status:** DRAFT for owner review. **Nothing in this document is to be executed** until the owner
> approves, and every destructive step has a per-collection confirmation gate. This is a Phase-3
> correctness prerequisite surfaced by the Round-4 execution digital-twin.

**Goal:** Collapse the accumulated duplicate-primary-key rows in the claude-context Milvus collections to one
row per PK, so the resume ledger read (`loadExistingFileHashes`) is deterministic — **without re-embedding** and
**without data loss**.

**Related:** design `docs/lufftw/design-2026-06-06-cpu-tolerant-embedding.md`; main plan
`docs/plan/2026-06-06-cpu-tolerant-embedding.md` (Phase 3); memory `project_milvus_duplicate_pk_contamination`.

---

## Plan & Version Control Policy

Synchronized copies (same as the main plan's policy):

| Copy | Path |
|---|---|
| Workspace working copy | `E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-06-milvus-pk-dedup-migration.md` |
| Formal docs copy (VC) | `E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-06-milvus-pk-dedup-migration.md` |

Affected repo (implementation/migration scripts, when authorized): `claude-context` only. The migration
operates on Milvus collections shared across the lufftw ecosystem (see `milvus-services/docs/claude-context/project-registry.md`),
but the *code* (a standalone migration script) lives in `claude-context`.

---

## 1. Problem (why this migration exists)

The Milvus collections' primary key `id` is a **non-autoID VarChar** (`chunk_<sha256(relativePath:startLine:endLine:content)>`).
Milvus does **not enforce VarChar-PK uniqueness on `insert`**, and the indexer has historically used plain `insert`
(not `upsert`) and did not always delete-before-insert on re-index. Result: collections accumulated **many physical
rows sharing the same PK**.

Live evidence (2026-06-06, via raw `queryIterator` drain vs `count(*)`):

| Collection | Physical rows | Distinct PKs | Duplication |
|---|---|---|---|
| `claude_context_own` | 2,176 | 800 | ~2.7× |
| `event_shared` | 585,312 | 162,703 | ~3.6× |

**Why it is a correctness bug (not just storage waste):** `loadExistingFileHashes` (`context.ts:825-858`) reads all
rows via `queryAll` and dedups by `relativePath`, keeping **whichever row arrives first** in iterator order. When
duplicate PK rows carry **divergent `metadata.fileHash`** (an old chunk from index run A and a re-inserted chunk
from run B both physically present), the kept `fileHash` is **non-deterministic**. The Phase-3 resume ledger read
(rev1.2 Layer-5) compares `existingHash === fileHash`; a non-deterministic `existingHash` ⇒ a genuinely-changed file
may be mis-skipped, or an unchanged file needlessly re-embedded. **The ledger cannot be trusted on existing
dup-laden collections until they are deduped.**

**Scope boundary — what this migration is NOT:**
- It does **not** fix *future* duplication — that is Phase 3 (switch `insert`→`upsert` + retain the per-file
  `deleteByFilter(relativePath)` orphan-on-shrink sweep). This migration is a **one-time** cleanup of historical debt.
- It does **not** address orphan-on-shrink (boundary-shifted PKs from edited files) — those are evicted going
  forward by Phase 3's retained delete sweep, and incidentally by the next incremental index of each file.

---

## 2. Method options

### Option A — Upsert-collapse (RECOMMENDED): rewrite one representative row per PK, reusing the stored vector
For each distinct PK, `upsert` a single representative row (its existing `vector` + `content` + `relativePath` +
`metadata`, read back from Milvus). `upsert` = atomic delete-by-PK + insert; delete-by-PK removes **all** rows with
that PK, so the result is exactly one row per PK. **No re-embedding** (reuses stored vectors → zero embedding-worker
load, zero RabbitMQ traffic). Self-contained per collection — no need for other writer projects to participate.

> ⚠ **MUST-VERIFY before relying on this (introspect, do not assume):** that Milvus `upsert` on a PK with **N
> pre-existing duplicate rows** deletes **all N** and leaves exactly one. This is the load-bearing assumption.
> Verification = a probe on a THROWAWAY collection (Task M0 below), never on a real collection. If `upsert` only
> removes one of N duplicates, fall back to Option B for that case (explicit `delete(ids=[pk])` removes all rows
> with the PK, then `insert` one).

### Option B — Delete-then-insert per PK
`delete(collection, ids=[pk])` (removes all rows with that PK), then `insert` one representative. Two RPCs per PK
instead of one; needed only if M0 shows `upsert` does not collapse all duplicates. Same "reuse stored vector, no
re-embed" property.

### Option C — Drop + full re-index per collection (NOT recommended for shared)
Drop the collection and re-index from source. Cleanest possible state, but: (a) requires the embedding worker (CPU
is slow / GPU intermittent — the whole reason for PP-SCL); (b) for **shared** collections (`event_shared`,
`dev_infra_shared`, `agent_shared`) it requires **every writer project** to re-index, a large cross-project
coordination. Reserve only for a collection so corrupted that representative-row selection is untrustworthy.

**Recommendation:** Option A (fallback B per-PK if M0 disproves the collapse assumption). Option C only as a last
resort for a specific collection, with separate owner sign-off.

---

## 3. Representative-row selection (which dup wins)

Duplicate rows share the same PK ⇒ same `relativePath:startLine:endLine:content` (that is what the PK hashes), so
their **`content` is identical** and their **`vector` should be identical** (deterministic embedding of identical
text, modulo provider non-determinism). The only meaningful divergence is `metadata.fileHash` (file-level hash).

- Because content is identical, **any** representative is content-correct; collapsing loses no chunk content.
- The `fileHash` ambiguity is *resolved by removal of duplicates* (one row ⇒ deterministic read) and **self-heals**
  on the next incremental index of that file (which re-stamps `fileHash`). So winner selection is **not** safety-
  critical: pick the first row per PK. (Optional refinement: if any row's `fileHash` matches the current on-disk
  file, prefer it — but this requires reading source files and is unnecessary for correctness.)

This is why the migration is **low-risk**: it deletes only redundant copies of identical content; it does not
choose between semantically different data.

---

## 4. Migration tasks (DRAFT — execute only on approval)

### Task M0 — Verify the upsert-collapse assumption (throwaway collection only)
- [ ] Create a throwaway collection `__dedup_probe_tmp` with the same schema (VarChar PK, FloatVector dim 4096, the
      hybrid fields if testing the hybrid path). Insert 3 rows with the **same** PK and distinct metadata.
- [ ] `upsert` one row with that PK. `queryAll` the collection. **Assert exactly 1 row remains** for that PK.
- [ ] Repeat for a **hybrid** (BM25 `sparse_vector` function-field) collection schema — confirm `upsert` is accepted
      and `sparse_vector` regenerates (ties to the main plan's Phase-3 hybrid probe, Task 3.4).
- [ ] Drop `__dedup_probe_tmp`. Record the verdict here: collapse confirmed → Option A; else → Option B.
- **No shared/real collection is touched in M0.**

### Task M1 — Discovery: which collections need dedup, and how badly
- [ ] Standalone read-only script: for each collection in the registry, compute `count(*)` (via the SDK count RPC)
      and distinct-PK count (via `queryAll` of `['id']` + Set). Emit a table (collection, physical, distinct, ratio).
- [ ] Cross-reference `milvus-services/docs/claude-context/project-registry.md` to mark each as **private** (owned by
      one project) or **shared** (`event_shared` / `dev_infra_shared` / `agent_shared`). Shared collections get the
      stricter gate (Task M3).
- [ ] Output a prioritized work-list (highest ratio first). No writes.

### Task M2 — Dedup a PRIVATE collection (per-collection, gated)
For each private collection flagged by M1, in its own run:
- [ ] **Pre-snapshot:** record `count(*)`, distinct-PK count, and a sample of 20 dup-PK groups (id + fileHash set) to
      a side-channel log (evidence baseline; same-runtime capture).
- [ ] **Quiescence:** confirm no `index_codebase` is running against this collection (check the snapshot status; for
      a private collection this is fully under our control).
- [ ] **Collapse:** stream `queryAll(collection, ['id','vector','content','relativePath','startLine','endLine','fileExtension','metadata'])`;
      group by `id`; for each distinct id, `upsert` (Option A) or `delete+insert` (Option B per M0) one representative,
      in batches (e.g. 1,000 ids/batch). Reuse the stored vector — **no embedding call**.
- [ ] **Post-validation (binary acceptance):** re-run discovery on this collection; **assert `count(*) == distinct-PK
      count`** (captured numbers, not substrings). Assert the total distinct-PK count is unchanged from the pre-snapshot
      (no PKs lost — we collapsed dups, we did not drop distinct chunks).
- [ ] **Rollback note:** Option A/B only remove redundant identical-content copies; there is no content rollback need.
      If a batch errors mid-run, the collection is left partially deduped (still correct — fewer dups) and the script
      is idempotent on re-run (re-collapsing an already-single PK is a no-op upsert).

### Task M3 — Dedup a SHARED collection (stricter gate — DESTRUCTIVE on shared infra)
Shared collections (`event_shared`, `dev_infra_shared`, `agent_shared`) are written by many projects. Same mechanism
as M2 **plus:**
- [ ] **Explicit per-collection owner approval** before this step runs (the owner's standing rule: no destructive op
      on shared infrastructure without sign-off).
- [ ] **Live-write awareness:** shared collections may receive writes during the collapse (e.g. event-crawler
      dual-write). The collapse is per-PK and idempotent, so a row written *after* its PK was collapsed simply
      re-introduces that one PK's duplication — acceptable residual; a final discovery pass quantifies it. Prefer a
      low-write window if one exists.
- [ ] **Do not** `drop`/`purge` the collection. Collapse only.
- [ ] Post-validation as M2, plus note any residual dup ratio from concurrent writes.

### Task M4 — Documentation
- [ ] Record the before/after table per collection in this doc (and in `milvus-services` if the registry tracks row
      health). Update `project_milvus_duplicate_pk_contamination` memory with the remediation date + results.

---

## 5. Sequencing relative to Phase 3

- **M0 + M1** (probe + discovery, both **non-destructive**) can run any time — they inform Phase 3.
- **M2/M3** (the destructive collapse) should run **after** Phase 3 ships `upsert` + the retained delete sweep, so the
  collections do not immediately re-accumulate duplicates from a still-`insert`-based indexer. Order:
  **Phase 3 (upsert) → M0/M1 → M2 (private) → M3 (shared, approval-gated).**
- The main plan's Phase-3 ledger logic (rev1.2 Layer-5) must not be **relied upon on a given collection** until that
  collection has passed M2/M3 post-validation (`count == distinct`).

---

## 6. Risks & mitigations

- **Upsert-collapse assumption wrong (M0 fails):** fall back to Option B (delete-by-PK then insert). Covered.
- **Hybrid `sparse_vector` upsert rejected:** M0 tests it; if rejected, that collection uses Option B (delete+insert)
  or defers to Option C. Ties to main-plan Task 3.4.
- **Concurrent writes on shared collections re-introduce dups:** accepted residual; quantified by a final discovery
  pass; self-heals as writers move to upsert (Phase 3 rollout across writers).
- **Representative-row vector drift:** vectors of identical content are identical modulo provider non-determinism;
  reusing the stored vector avoids any drift (we do not re-embed). No risk.
- **Mid-run failure:** script is idempotent (re-collapsing a single-row PK is a no-op); safe to re-run.

---

## 7. Open question for the owner

- **event_shared scope:** at ~585K rows / ~163K distinct it is the largest and is shared by 13 projects. Confirm
  whether to (a) collapse it in place (Option A, recommended, ~163K upserts, no re-embed), or (b) leave it as
  accepted residual debt (the rev1.2 ledger would then remain untrusted *for event_shared specifically* — acceptable
  if claude-context's own resume relies on the private `claude_context_own`, which IS deduped). Your call drives M3.
