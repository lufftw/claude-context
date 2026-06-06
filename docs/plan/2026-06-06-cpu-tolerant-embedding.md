# CPU-Tolerant RabbitMQ Embedding (PP-SCL) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-context's RabbitMQ embedding pipeline tolerate slow CPU embedding workers (minutes-to-hours) without orphaning completed work or aborting the index run, while staying correct on crash/resume.

**Architecture:** PP-SCL = **P**atient **P**ublisher + **S**napshot **C**ompleteness **L**edger + native upsert. Keep the synchronous `Embedding` interface and the exclusive+autoDelete reply queue (correct for a single-process stdio MCP). Harden the publisher to be patient and retry-aware, classify wait-vs-real faults, record per-file completeness in the proper-lockfiled JSON snapshot (never a Milvus row), and use native `client.upsert` for idempotent re-writes.

**Tech Stack:** TypeScript (Node 20–23), `amqplib`, `@zilliz/milvus2-sdk-node@2.5.10` (gRPC driver `MilvusVectorDatabase` is the active one), Jest + ts-jest, `proper-lockfile`.

**Design spec:** `docs/lufftw/design-2026-06-06-cpu-tolerant-embedding.md` (authoritative).

**Plan revision:** rev1.2 (ARB³ closed-loop review → `docs/plan/2026-06-06-arb3-review-rev1.1.md`; Round-4 execution-digital-twin → `docs/plan/2026-06-06-round4-digital-twin-rev1.2.md`).

---

## ARB³ Review Status (rev1.1)

A 13-agent, 3-round closed-loop review (domain → meta+simulation+adversarial → chair go/no-go) hardened this plan. Verdict: **NEEDS ROUND 4** (narrow) — Phase-1/2 *code* is gated on a composition trace of the Task 1.4↔1.5↔1.6↔2.3 seam (patches P30/P31/P33). **The Hotfix is independently shippable** after the Tier-0 patches below.

### Gate map
- **Hotfix:** ✅ unblocked. Tier-0 patches **applied inline** (P1, P2, P3, P4, P22, P24, P25, P44, P51).
- **Phase 1/2 code start:** ⛔ blocked until **Round 4** traces P30+P31+P33 composing. Tier-1 patches **pending** (annotated in the relevant tasks).
- **Phase 3:** patches deferred to phase reach (P16, P26, hybrid probe).

### Tier-0 (Hotfix) — APPLIED in rev1.1
| Patch | What | Where applied |
|---|---|---|
| P1/P25 | `queryIterator` is async-iterable-only; probe uses `for await`, pins `127.0.0.1`, hard-fails on no token | Hotfix Step 1 |
| P2 | mock exposes `[Symbol.asyncIterator]`, re-emits last batch on `done`, asserts no dup | Hotfix Step 2 |
| P3 | impl uses `for await` + injects PK `id` into `output_fields` (F1+F2+F3) | Hotfix Step 5 |
| P4/P51/P44 | acceptance gate: no-duplicate-PK primary + require ≥16384 rows (was vacuous) | Hotfix Step 10 |
| P22 | split `test` / `test:int` so unit gate runs offline | Task 0 Step 2 |
| P24 | RESTful `queryAll` documented as best-effort ≤16384 (gRPC is the active driver) | Hotfix Step 6 |

### Round 4 (execution digital-twin) — verdict: NO-GO as scoped → GO against rev1.2
Three twins + an adversary traced P30+P31+P33 against the **real code** + the live duplicate-PK finding. Result: **the trio does NOT compose correctly as three isolated patches** — it must become an **atomic 16-edit unit**. Full resolved design (5 layers, exact signatures, end-to-end data flow) in `docs/plan/2026-06-06-round4-digital-twin-rev1.2.md`. **Phase 1/2 code is unblocked against rev1.2** (build target = the artifact's patch-list); Round 5 would be a confirmation pass, not a re-derivation.

**The blocking trace (hard data loss) — and its fix:** at the `CHUNK_LIMIT` break (`context.ts:984-988`) a file can flush some chunks with `produced===inserted` while later chunks are never produced → P33 mints a false `complete:true` → P30 skips the file *forever* → **chunks lost**, worse than today. **Fix (the headline rev1.2 correctness rule):** completeness gate is `complete = produced === inserted && produced === fileChunkTotals.get(relativePath)` (the splitter's per-file total), and the CHUNK_LIMIT break tags the in-flight file `incompleteByLimit` → `complete:false`.

### Tier-1 atomic unit (rev1.2) — PENDING; gates Phase 1/2 code. NONE may ship without the others.
- **P40 (promoted Tier-3→Tier-1):** dim+norm-band reject **before** `rabbitmq-embedding.ts:197 pending.resolve` (loop-sum norm, never `Math.hypot(...v)`); a 1536-dim `success:true` rogue becomes a REAL `bad-dimension` failure. **Without this, P31 has nothing to classify and the rogue-worker guard is defeated.**
- **P31 (FATAL G2):** three-way abort counter reading a `BatchOutcome` partition (REAL→`++`; clean+productive→`=0`; pure-WAIT→**unchanged**). Cannot be a void+try/catch — `processChunkBatch`/`processChunkBuffer` must return `BatchOutcome{perFile, realFailures, waitFailures, successes}`. Same branch on the final-batch flush (`context.ts:1008-1020`). Rogue regression test routes through the **real** reply consumer.
- **P33 (HIGH G4) + the Attack-1 fix:** thread `relativePath` onto the buffer (`context.ts:951`); record `fileChunkTotals` after `split` (~935); `complete` gated on `=== chunks.length` (above).
- **P30 (FATAL G1) + absent-vs-false:** ledger-gated skip at `context.ts:903`; **absent** ledger entry (snapshot race) ⇒ verify/idempotent re-embed **without** destructive pre-delete; explicit `complete:false` ⇒ delete+re-embed.
- **P7+P34+P6 (promoted to Tier-1):** `files?` on `CodebaseInfoIndexing` (`config.ts:49-52`); `setCodebaseIndexing` carries `files` forward (else the 2s tick clobbers it — killed run leaves no readable ledger → resume degrades to full re-index); field-merge `files` in `mergeAndWriteSnapshot`; retain on interrupted `indexing` reload.
- **P32:** result-check the Milvus `insert` (`milvus-vectordb.ts:365-368` discards `MutationResult`) — non-`Success`/`insert_cnt!==len` ⇒ REAL `insert-error`; never seal `complete` on a partial insert.
- **P5:** cross-layer `onFileComplete` callback (core→handlers→`setFileComplete`); core never imports mcp.

### Phase 3 — duplicate-PK call (definite, from Round 4)
- **Upsert is sufficient for new writes** (deterministic PK collapses to 1 row) — stops manufacturing dups.
- **Retain a per-file `deleteByFilter(relativePath)` sweep even with upsert** — `generateId` is boundary-keyed, so edits that shift chunk lines orphan old PKs (upsert only touches PKs in the write set). Correctness, not hygiene.
- **A one-time per-collection dedup is REQUIRED before the ledger read is trustworthy on existing collections:** duplicate PKs with divergent `fileHash` make `loadExistingFileHashes`'s relativePath-dedup pick a non-deterministic winner → mis-skip/needless-re-embed. This is a **destructive migration on shared collections → owner approval required** (see [[feedback_never_purge_shared_queue]] ethos). Recurring Milvus segment compaction is hygiene only (auto).

### Tier-2/3/4 — PENDING, applied as each phase is reached
Full list (P5–P52) in the review artifact. Headlines: **P5/F4** cross-layer `onFileComplete` callback (core cannot call mcp `SnapshotManager` — wire in `handlers.ts`); **P6/F5** field-level `files` deep-merge in `mergeAndWriteSnapshot`; **P7/F6** `files?` on `CodebaseInfoIndexing` + carry on progress ticks; **P14** `processChunkBuffer`/`processChunkBatch` return `{failedIndices,insertedIds,perFile}`; **P32/G3** result-check the Milvus `insert` (currently discarded); **P8/P38** tagged `resetState(reason, embedClass)`; **P36** clamp indexing priority ≤7; **P43/P20** reconcile `timeoutMs × (maxRetries+1) < 7_200_000` as a tested invariant (provisional `timeoutMs=1_800_000`, `maxRetries=3`).

---

## Plan & Version Control Policy

This plan MUST exist as **two synchronized copies**, kept in lock-step. Any change to one is immediately mirrored to the other (same content, same filename).

### Synchronized plan copies (this plan)

| Copy | Path |
|---|---|
| **Workspace working copy** | `E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-06-cpu-tolerant-embedding.md` |
| **Formal docs copy (version-controlled)** | `E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-06-cpu-tolerant-embedding.md` |

### Repos under version control for this plan

| Repo | Role in this plan | docs/plan obligation |
|---|---|---|
| `E:\Developer\lufftw\repo\claude-context` | **Implementation target** — all code changes land here | MUST keep `docs/plan` aligned with implementation |

### Cross-project note (why only one repo)

The design was synthesized by **studying** three sibling repos as read-only references —
`E:\Developer\lufftw\repo\event-crawler` (mature async fire-and-forget),
`E:\Developer\lufftw\repo\event-search-service` (venue-link async),
`E:\Developer\lufftw\repo\poi-data-layer` (12 stability gaps to avoid).
**No code is modified in those repos**, so per the policy ("keep `docs/plan` aligned with *implementation*") they receive **no** plan copy. If a future phase requires changing any of them (e.g. a worker-side `x-single-active-consumer` argument), that repo is added to the table above and gets its own synchronized plan copy at that time.

### Sync rule (operational)

After editing this plan in either location, run:

```powershell
Copy-Item -Force `
  "E:\Developer\lufftw\repo\claude-context\docs\plan\2026-06-06-cpu-tolerant-embedding.md" `
  "E:\Developer\lufftw\repo\claude-context-workspace\docs\plan\2026-06-06-cpu-tolerant-embedding.md"
```

(or the reverse, depending on which copy was edited). The version-controlled copy is the source of truth; the workspace copy mirrors it.

---

## Plan Completion Audit Checklist

Run this checklist when the plan (or a phase of it) is declared complete. Every item must be **externally verifiable** — a command, an artifact, or a diff — not a subjective assertion. No item passes on "looks done."

### A. Artifact & version-control integrity
- [ ] **A1** Both plan copies exist and are byte-identical. Verify: `Get-FileHash` on both paths returns the same SHA256.
- [ ] **A2** The formal copy is committed in `claude-context` git (not just on disk). Verify: `git log --oneline -- docs/plan/2026-06-06-cpu-tolerant-embedding.md` shows a commit.
- [ ] **A3** The design spec and the plan agree on phase scope and sequencing (Hotfix → P1 → P2 → P3). Verify by diffing the phase lists.
- [ ] **A4** No reference repo (event-crawler / event-search-service / poi-data-layer) has uncommitted changes from this work. Verify: `git status` in each is clean.

### B. Per-phase code completion (repeat per phase)
- [ ] **B1** All tasks in the phase are checked off in the plan.
- [ ] **B2** `pnpm typecheck` passes (exit code 0). Capture the exit code, not just console glance.
- [ ] **B3** `pnpm build:core` (and `build:mcp` if MCP touched) succeeds (exit code 0).
- [ ] **B4** The phase's unit tests pass. Capture: test runner exit code + pass/fail counts.
- [ ] **B5** `node packages\mcp\dist\index.js --help` still loads the binary (smoke test, exit 0, no stdout pollution of JSON-RPC).
- [ ] **B6** Each new/changed file has a single clear responsibility (no unrelated drive-by edits in the diff).

### C. Behavioral acceptance (binary, evidence-based — per the project's acceptance standard)
- [ ] **C1** Every acceptance criterion in the phase was verified by **exit code + captured output (SHA256 / row count / diff shape)** — never substring matching.
- [ ] **C2** Capture tooling and assertion tooling share the same runtime (no serializer mismatch between baseline and check).
- [ ] **C3** Every abort/failure path tested has a paired recovery path tested.
- [ ] **C4** Runtime properties (e.g. "wait-class fault does not increment the abort counter") are verified by **execution**, not by `grep` of the source. Static grep is a hint, not a gate.

### D. Shared-infrastructure etiquette (non-negotiable)
- [ ] **D1** No code path declares, purges, deletes, or redeclares the shared queue `embedding.qwen3-8b`. Verify by `grep` for `purgeQueue`/`deleteQueue`/`assertQueue('embedding` and confirming none target the shared work queue (only the exclusive reply queue may be asserted).
- [ ] **D2** Any live validation that published to the shared queue used **priority 8–9 only** and confirmed the queue's message count was unchanged afterward (publish-then-consume-own-reply).
- [ ] **D3** Indexing-path publishes use priority **≤ 7** and never escalate on retry.
- [ ] **D4** No zero/empty/wrong-dimension vector can reach a Milvus insert/upsert. Verify by the dedicated unit test (Phase 1).

### E. Documentation & memory
- [ ] **E1** `docs/lufftw/rabbitmq-embedding-provider.md` updated to describe patient-publisher semantics + new env knobs (when Phase 1 ships).
- [ ] **E2** The empirically-measured timeout default (§ Cross-Cutting) is recorded in the spec and the env-var docs with the measurement evidence.
- [ ] **E3** Plan copies' checkboxes reflect actual completion state at hand-off.

---

## Architecture: File Structure & Phase Map

| File | Responsibility | Phases |
|---|---|---|
| `packages/core/src/embedding/rabbitmq-embedding.ts` | Patient publisher: retry-via-republish, fault classification, partial-batch, reconnect republish | P1 |
| `packages/core/src/embedding/base-embedding.ts` | Embedding interface — extended with a batch result that carries a per-item success mask | P1 |
| `packages/core/src/context.ts` | Indexer loop: consume success mask, file-aware completeness, fault classification into abort counter, paginated hash readback, upsert wiring | Hotfix, P1, P2, P3 |
| `packages/core/src/vectordb/types.ts` | `VectorDatabase` interface — add `queryAll`, `upsert`, `upsertHybrid` | Hotfix, P3 |
| `packages/core/src/vectordb/milvus-vectordb.ts` | gRPC driver — implement `queryAll` (queryIterator), `upsert`, `upsertHybrid` | Hotfix, P3 |
| `packages/core/src/vectordb/milvus-restful-vectordb.ts` | RESTful driver (unused by MCP, kept interface-complete) — mirror methods | Hotfix, P3 |
| `packages/mcp/src/config.ts` | Parse new env knobs (`MAX_RETRIES`, `PREFLIGHT`) + snapshot file types | P1, P2 |
| `packages/mcp/src/snapshot.ts` | Per-file completeness ledger in the v2 snapshot | P2 |
| `packages/core/jest.config.js` + `packages/core/package.json` | Test infrastructure (does not exist yet) | Task 0 |

**Sequencing:** Task 0 (test infra) → **Hotfix** (pagination) → **Phase 1** (patient embed core) → **Phase 2** (snapshot ledger) → **Phase 3** (native upsert).

---

## Task 0: Test Infrastructure

The repo has Jest + ts-jest installed in `packages/core` but **no `jest.config.js`, no `test` script, and zero test files**. Stand it up first so every later task is TDD.

**Files:**
- Create: `packages/core/jest.config.js`
- Modify: `packages/core/package.json` (add `test` script)
- Create: `packages/core/src/embedding/__tests__/smoke.test.ts` (proves the harness runs)

- [ ] **Step 1: Create the Jest config**

`packages/core/jest.config.js`:
```js
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // amqplib + milvus SDK are heavy; keep tests unit-level (no real network) by default.
  testTimeout: 15000,
};
```

- [ ] **Step 2: Add the test script**

In `packages/core/package.json` `"scripts"`, add (P22 — keep live-Milvus `*.int.test.ts` out of the hermetic unit gate so `pnpm test` works offline):
```json
"test": "jest --testPathIgnorePatterns='\\.int\\.test\\.ts$'",
"test:int": "jest --testMatch='**/__tests__/**/*.int.test.ts'",
"test:watch": "jest --watch --testPathIgnorePatterns='\\.int\\.test\\.ts$'"
```

- [ ] **Step 3: Write a smoke test**

`packages/core/src/embedding/__tests__/smoke.test.ts`:
```ts
describe('jest harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 4: Run it, verify PASS**

Run: `pnpm --filter @zilliz/claude-context-core test` (from repo root) or `cd packages/core && pnpm test`
Expected: `1 passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jest.config.js packages/core/package.json packages/core/src/embedding/__tests__/smoke.test.ts
git commit -m "test: stand up jest harness for core package"
```

---

## HOTFIX: Paginated `loadExistingFileHashes` (full-scan, no 16384 truncation)

**Why first / standalone:** `loadExistingFileHashes` (`context.ts:830-858`) reads at most 16,384 rows and its docstring already (falsely) claims pagination. Milvus caps the `query` window at `offset+limit ≤ 16384`, so resume on any collection larger than that **already skips or re-embeds the wrong files today** — independent of the rest of this work. Fix it via the SDK's `queryIterator` exposed through a new interface method `queryAll`.

**Files:**
- Modify: `packages/core/src/vectordb/types.ts` (add `queryAll` to interface)
- Modify: `packages/core/src/vectordb/milvus-vectordb.ts` (implement via `queryIterator`)
- Modify: `packages/core/src/vectordb/milvus-restful-vectordb.ts` (offset-loop mirror)
- Modify: `packages/core/src/context.ts:830-858` (`loadExistingFileHashes` uses `queryAll`)
- Test: `packages/core/src/vectordb/__tests__/query-all.test.ts`

- [ ] **Step 1: Verify the `queryIterator` runtime shape (introspect, do not assume)**

Before coding, confirm the SDK's iterator contract empirically (the project rule is "introspect runtime APIs, do not assume"). Write a one-off probe `tmp-iter-probe.mjs` (gitignored `tmp-*.mjs`) that connects to the live Milvus (`localhost:19530`, token from `.mcp.json`) and calls `client.queryIterator` on an existing collection (`claude_context_own`), logging the shape of the returned object and one `.next()` result to **stderr**.

> **ARB³ P1/P25 (FATAL-class correction):** the SDK `queryIterator` returns an **async-iterable only** — `{ currentTotal, [Symbol.asyncIterator]() {...} }` with **no top-level `.next()`** (verified `@zilliz/milvus2-sdk-node@2.5.10` `dist/milvus/grpc/Data.js:650-686`). A `.next()` call throws. Drive it with `for await`. Pin `127.0.0.1:19530` and hard-fail on missing token.

```js
// tmp-iter-probe.mjs — verify queryIterator() return contract (gitignored tmp-*.mjs)
import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { readFileSync } from 'node:fs';
const env = Object.values(JSON.parse(readFileSync('./.mcp.json')).mcpServers)[0].env;
const address = (env.MILVUS_ADDRESS || '127.0.0.1:19530').replace(/^localhost/, '127.0.0.1');
const token = env.MILVUS_TOKEN;
if (!token) { console.error('[probe] MILVUS_TOKEN missing'); process.exit(2); }
const client = new MilvusClient({ address, token });
const it = await client.queryIterator({ collection_name: 'claude_context_own', output_fields: ['relativePath','id'], batchSize: 5, expr: '' });
console.error('has .next():', typeof it.next);                       // expect 'undefined'
console.error('has asyncIterator:', typeof it[Symbol.asyncIterator]); // expect 'function'
let pages = 0, rows = 0;
for await (const batch of it) { pages++; rows += batch.length; if (pages >= 3) break; }
console.error('drained', pages, 'pages,', rows, 'rows via for-await');
process.exit(0);
```
Run: `node tmp-iter-probe.mjs`
**Acceptance:** stderr shows `has .next(): undefined` and `has asyncIterator: function`. Paste this output before writing Step 5. Delete the probe after.

- [ ] **Step 2: Write the failing test (mock the iterator)**

`packages/core/src/vectordb/__tests__/query-all.test.ts`:
> **ARB³ P2:** the mock MUST expose `[Symbol.asyncIterator]` and re-emit the **previous** batch on `{done:true}` (SDK `Data.js:658-659` returns the last non-empty batch in `value`, not `[]`). `for await` ignores the value when `done:true`, so the assertion proves no duplicate `'c'`.

```ts
import { MilvusVectorDatabase } from '../milvus-vectordb';

describe('MilvusVectorDatabase.queryAll', () => {
  it('drains all batches via async-iterator without double-counting the final batch', async () => {
    const db = new MilvusVectorDatabase({ address: 'unused' });
    const batches = [
      [{ relativePath: 'a', id: '1' }, { relativePath: 'b', id: '2' }],
      [{ relativePath: 'c', id: '3' }],
    ];
    let capturedFields: string[] = [];
    (db as any).client = {
      queryIterator: async (req: any) => {
        capturedFields = req.output_fields;
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < batches.length) return { done: false, value: batches[i++] };
                // SDK contract: done:true re-emits the LAST batch in value.
                return { done: true, value: batches[batches.length - 1] };
              },
            };
          },
        };
      },
    };
    (db as any).ensureInitialized = async () => {};
    (db as any).ensureLoaded = async () => {};

    const rows = await db.queryAll('c1', ['relativePath']);
    expect(rows.map(r => r.relativePath)).toEqual(['a', 'b', 'c']); // no duplicate 'c'
    expect(capturedFields).toContain('id'); // PK injected (P3) so keyset pagination advances
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `cd packages/core && pnpm test -- query-all`
Expected: FAIL — `db.queryAll is not a function`.

- [ ] **Step 4: Add `queryAll` to the interface**

In `packages/core/src/vectordb/types.ts`, inside `interface VectorDatabase`, after the `query(...)` declaration (line 134):
```ts
    /**
     * Full-scan query that drains ALL matching rows (no 16384 window cap),
     * using server-side iteration. Use for resume/readback over large collections.
     * @param collectionName Collection name
     * @param outputFields Fields to return
     * @param filter Optional filter expression (empty = all rows)
     * @param batchSize Rows per server round-trip (default 10000)
     */
    queryAll(collectionName: string, outputFields: string[], filter?: string, batchSize?: number): Promise<Record<string, any>[]>;
```

- [ ] **Step 5: Implement in the gRPC driver (matching the observed iterator contract)**

In `packages/core/src/vectordb/milvus-vectordb.ts`, add after `query(...)` (after line 479). **P3 (closes F1+F2+F3):** drive the async-iterator with `for await` (correct done-semantics, no double-append), and **always inject the primary key `id`** into `output_fields` — the SDK's keyset pagination (`utils/Function.js:147-168`) re-seeds from the min-PK whenever the last row's PK is absent, so omitting `id` makes every page re-seed page 1 forever:
```ts
    async queryAll(collectionName: string, outputFields: string[], filter?: string, batchSize: number = 10000): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);
        if (!this.client) {
            throw new Error('MilvusClient is not initialized after ensureInitialized().');
        }
        // PK must be present for the SDK's keyset pagination to advance (P3/F3).
        const fields = outputFields.includes('id') ? outputFields : [...outputFields, 'id'];
        const iterator = await this.client.queryIterator({
            collection_name: collectionName,
            output_fields: fields,
            batchSize,
            expr: (filter && filter.trim() !== '') ? filter : '',
        });
        const out: Record<string, any>[] = [];
        // for-await drains all batches and stops on done:true WITHOUT re-yielding
        // the final batch (SDK re-emits it in `value` on done — for-await ignores it).
        for await (const batch of iterator as AsyncIterable<Record<string, any>[]>) {
            out.push(...batch);
        }
        return out;
    }
```

- [ ] **Step 6: Implement the RESTful mirror (offset loop)**

In `packages/core/src/vectordb/milvus-restful-vectordb.ts`, add after `query(...)`. The RESTful API honors `offset`; loop until a short page:
```ts
    async queryAll(collectionName: string, outputFields: string[], filter?: string, batchSize: number = 10000): Promise<Record<string, any>[]> {
        await this.ensureInitialized();
        await this.ensureLoaded(collectionName);
        const restfulConfig = this.config as MilvusRestfulConfig;
        const out: Record<string, any>[] = [];
        let offset = 0;
        // ARB³ P24: Milvus REST caps offset+limit at the 16384 query window, so this loop
        // does NOT "drain ALL rows" past 16384 — it is best-effort for the RESTful driver,
        // which the MCP does NOT use (gRPC MilvusVectorDatabase is the active driver). Kept
        // only for interface completeness. Do not rely on it for >16384-row full scans.
        const pageSize = Math.min(batchSize, 16384);
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const req: Record<string, any> = {
                collectionName, dbName: restfulConfig.database, outputFields, offset, limit: pageSize,
            };
            if (filter && filter.trim() !== '') req.filter = filter;
            const response = await this.makeRequest('/entities/query', 'POST', req);
            if (response.code !== 0) {
                throw new Error(`Failed to queryAll Milvus: ${response.message || 'Unknown error'}`);
            }
            const page = (response.data || []) as Record<string, any>[];
            out.push(...page);
            if (page.length < pageSize) break;
            offset += pageSize;
        }
        return out;
    }
```

- [ ] **Step 7: Run the unit test, verify PASS**

Run: `cd packages/core && pnpm test -- query-all`
Expected: PASS.

- [ ] **Step 8: Switch `loadExistingFileHashes` to `queryAll`**

In `packages/core/src/context.ts`, replace the `query(...)` call at lines 838-843 with:
```ts
            // Full-scan (no 16384 truncation) so resume sees every indexed file.
            const results = await this.vectorDatabase.queryAll(
                collectionName,
                ['relativePath', 'metadata'],
                ''  // all rows
            );
```

- [ ] **Step 9: Typecheck + build**

Run: `pnpm typecheck && pnpm build:core`
Expected: exit code 0.

- [ ] **Step 10: Live scaling gate (binary acceptance) against real Milvus**

> **ARB³ P4/P51/P44 (must-fix — the original gate was vacuous):** a counts-match on a sub-16384 collection is *also* passed by the OLD truncating path, so "counts match" proves nothing. Make **no-duplicate-PK the PRIMARY gate**, and require a collection **at/over the 16384 window** (build a synthetic >20k-chunk corpus per spec §14 if no real collection qualifies). Run against a **quiescent** collection (`queryIterator` issues a separate `count()` RPC that disagrees under concurrent writes).

Milvus is up at `127.0.0.1:19530`. Write `tmp-pagination-gate.mjs` (gitignored) that builds the gRPC driver from `dist` and, against a quiescent collection with **≥16384 rows**:
1. Asserts `query(collection, '', ['id'], 16384).length === 16384` first (proves the collection actually exceeds the window — else the test is meaningless; abort if not).
2. Calls `rows = queryAll(collection, ['relativePath'])` and asserts **`rows.length === new Set(rows.map(r => r.id)).size`** (no duplicate PKs — guards F2's terminal-batch double-push) — PRIMARY gate.
3. Asserts `new Set(rows.map(r => r.relativePath)).size > 16384`-window distinct count from the capped query (proves the full scan beat truncation) — SECONDARY gate.

Assert via captured counts (numbers) + the dedup set sizes, never substrings.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src/vectordb/types.ts packages/core/src/vectordb/milvus-vectordb.ts packages/core/src/vectordb/milvus-restful-vectordb.ts packages/core/src/context.ts packages/core/src/vectordb/__tests__/query-all.test.ts
git commit -m "fix(core): paginate loadExistingFileHashes via queryIterator (no 16384 truncation)"
```

---

## PHASE 1: Patient Embed Core

Fixes the reported failure chain. Five mechanisms; each is a task. The `Embedding` contract changes so a batch can report **per-item success** instead of all-or-nothing.

### Task 1.1: Batch result with a success mask (interface change)

**Files:**
- Modify: `packages/core/src/embedding/base-embedding.ts`
- Test: `packages/core/src/embedding/__tests__/batch-result.test.ts`

The current contract is `embedBatch(texts): Promise<EmbeddingVector[]>` — all-or-nothing. Add a non-breaking parallel method `embedBatchPartial(texts): Promise<EmbedItemResult[]>` where each slot is either a real vector or a typed failure. Keep `embedBatch` for callers that want strict behavior; the indexer switches to the partial form.

- [ ] **Step 1: Write the failing test**

`packages/core/src/embedding/__tests__/batch-result.test.ts`:
```ts
import type { EmbedItemResult } from '../base-embedding';

describe('EmbedItemResult shape', () => {
  it('discriminates ok vs failed', () => {
    const ok: EmbedItemResult = { ok: true, vector: [0.1, 0.2], dimension: 2 };
    const bad: EmbedItemResult = { ok: false, reason: 'timeout', index: 3 };
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('timeout');
  });
});
```

- [ ] **Step 2: Run it, verify it fails** (`Cannot find name 'EmbedItemResult'`).

Run: `cd packages/core && pnpm test -- batch-result`

- [ ] **Step 3: Add the types + abstract method**

In `packages/core/src/embedding/base-embedding.ts`, add near `EmbeddingVector`:
```ts
export type EmbedFailReason = 'timeout' | 'no-consumer' | 'connection-lost' | 'worker-error' | 'bad-dimension' | 'malformed';

export type EmbedItemResult =
  | { ok: true; vector: number[]; dimension: number }
  | { ok: false; reason: EmbedFailReason; index: number; detail?: string };
```
And in `abstract class Embedding`, add a concrete default that wraps `embedBatch` (so existing providers don't break), to be overridden by `RabbitMQEmbedding`:
```ts
    /**
     * Batch embed that reports per-item success instead of all-or-nothing.
     * Default impl delegates to embedBatch and marks every item ok; providers
     * with partial-failure semantics (RabbitMQ) override this.
     */
    async embedBatchPartial(texts: string[]): Promise<EmbedItemResult[]> {
        const vics = await this.embedBatch(texts);
        return vics.map((v) => ({ ok: true as const, vector: v.vector, dimension: v.dimension }));
    }
```

- [ ] **Step 4: Run test, verify PASS.** Run: `cd packages/core && pnpm test -- batch-result`

- [ ] **Step 5: Commit**
```bash
git add packages/core/src/embedding/base-embedding.ts packages/core/src/embedding/__tests__/batch-result.test.ts
git commit -m "feat(core): add EmbedItemResult + embedBatchPartial to embedding interface"
```

### Task 1.2: Patient timeout + fault tagging in `sendOne`

**Files:**
- Modify: `packages/core/src/embedding/rabbitmq-embedding.ts`
- Test: `packages/core/src/embedding/__tests__/rabbitmq-patient.test.ts`

Replace the 30s default with a configurable liveness backstop and tag the rejection reason so the caller can classify wait-vs-real. The constructor already reads `timeoutMs ?? 30000` (line 87); change the default and add `maxRetries`.

- [ ] **Step 1: Write the failing test (injected `connectFn`, no broker)**

`packages/core/src/embedding/__tests__/rabbitmq-patient.test.ts`:
```ts
import { RabbitMQEmbedding } from '../rabbitmq-embedding';

function fakeAmqp(opts: { onPublish: (buf: Buffer) => void }) {
  const replyConsumers: any[] = [];
  const channel = {
    on() {}, async close() {},
    async assertQueue() { return { queue: 'amq.gen-test' }; },
    async consume(_q: string, cb: any) { replyConsumers.push(cb); return { consumerTag: 't' }; },
    publish(_ex: string, _q: string, buf: Buffer, _o: any, cb: any) { opts.onPublish(buf); cb?.(null); return true; },
  };
  const conn = { on() {}, async createConfirmChannel() { return channel; }, async createChannel() { return channel; }, async close() {} };
  return { connect: async () => conn as any, channel, replyConsumers };
}

it('rejects with reason "timeout" after the configured backstop', async () => {
  const amqp = fakeAmqp({ onPublish: () => {} });
  const emb = new RabbitMQEmbedding({
    url: 'amqp://x', queue: 'embedding.qwen3-8b', modelName: 'm', dimension: 2,
    timeoutMs: 50, maxRetries: 0, connectFn: amqp.connect as any,
  });
  await expect(emb.embed('hello')).rejects.toThrow(/timeout/i);
  await emb.close();
});
```

- [ ] **Step 2: Run it, verify it fails** (currently `maxRetries` is not a config field; and the timeout error message/path differs).

Run: `cd packages/core && pnpm test -- rabbitmq-patient`

- [ ] **Step 3: Add `maxRetries` to config + change timeout default**

In `RabbitMQEmbeddingConfig` add `maxRetries?: number;`. In the constructor config block (lines 82-93), change `timeoutMs: config.timeoutMs ?? 30000` to `?? 600000` and add `maxRetries: config.maxRetries ?? 5`. Update the `Required<...>` type accordingly.

- [ ] **Step 4: Tag the timeout rejection** — in `sendOne` (lines 323-329) change the timeout `Error` to carry a machine-readable reason:
```ts
            const timer = setTimeout(() => {
                if (this.pending.delete(taskId)) {
                    const err = new Error(`Embedding timeout after ${this.config.timeoutMs}ms (queue=${this.config.queue})`);
                    (err as any).embedReason = 'timeout';
                    reject(err);
                }
            }, this.config.timeoutMs);
```
(Apply the same `embedReason` tagging to the no-consumer / connection-lost / worker-error / bad-dimension / malformed reject sites in the reply consumer and `resetState`.)

- [ ] **Step 5: Run test, verify PASS.**

- [ ] **Step 6: Commit**
```bash
git add packages/core/src/embedding/rabbitmq-embedding.ts packages/core/src/embedding/__tests__/rabbitmq-patient.test.ts
git commit -m "feat(core): patient timeout backstop (default 10min) + tagged embed fault reasons"
```

### Task 1.3: Retry-via-republish with eager supersede-eviction

**Files:** Modify `packages/core/src/embedding/rabbitmq-embedding.ts`; Test `.../rabbitmq-retry.test.ts`.

Wrap `sendOne` in `sendOneWithRetry`: on a **wait-class** reason (`timeout`/`no-consumer`/`connection-lost`), republish with `retryCount+1`, `x-retry-count` incremented, a **fresh taskId**, up to `maxRetries`, priority held (never escalated). On republish, the superseded taskId is already evicted from `pending` (the timeout deleted it); ensure no leak.

- [ ] **Step 1: Write the failing test** — first attempt times out (no reply), second attempt gets a reply; assert exactly 2 publishes and a resolved vector, and `pending` map empty at the end. (Use a fake amqp whose reply consumer is driven manually; increment `x-retry-count` asserted from the published buffers.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement `sendOneWithRetry`** — loop up to `maxRetries+1`; classify the caught error's `embedReason`; only retry wait-class; on real-class rethrow immediately. Each attempt builds a fresh envelope with `retryCount: attempt`, `headers['x-retry-count']: attempt`. Route `embed`/`embedBatchPartial` through it.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(core): bounded retry-via-republish wiring x-retry-count, no pending leak`.

### Task 1.4: `embedBatchPartial` with `Promise.allSettled` + zero-vector ban

**Files:** Modify `rabbitmq-embedding.ts`; Test `.../rabbitmq-partial.test.ts`.

Override `embedBatchPartial`: run the bounded-concurrency pool over `sendOneWithRetry`, collect with settled semantics, and for each slot return `{ok:true, vector, dimension}` only if `vector.length === this.config.dimension` and all finite; otherwise `{ok:false, reason, index}`. **Never** emit `[]` or zeros.

- [ ] **Step 1: Failing test** — batch of 3 where index 1's worker reply is malformed; assert slots 0 and 2 are `ok:true` with right-dimension vectors and slot 1 is `ok:false, reason:'malformed'`; assert no slot has a zero vector.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the override + the `vector.length === dimension` finite-check guard.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(core): partial-batch embedding via allSettled + hard zero-vector ban`.

### Task 1.5: Indexer consumes the success mask + inserts only succeeded chunks

**Files:** Modify `packages/core/src/context.ts` `processChunkBatch` (lines 1059-1139); Test `.../context-partial-insert.test.ts`.

Change `processChunkBatch` to call `embedBatchPartial`, build `documents` only from `ok:true` indices (preserving positional metadata), and return the set of failed chunk indices to the caller so completeness (P2) and fault classification (Task 1.6) can use it.

- [ ] **Step 1: Failing test** — feed 3 chunks where the embedding returns ok/fail/ok; assert `vectorDatabase.insert` receives exactly 2 documents with the correct ids (via `generateId`) and the failed chunk is reported. (Mock `embedding.embedBatchPartial` and `vectorDatabase.insert`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — map succeeded indices to documents; both hybrid and non-hybrid branches; return `{ insertedIds, failedIndices }`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(core): insert only successfully-embedded chunks (partial-batch tolerant)`.

### Task 1.6: Wait-vs-real fault classification feeding the abort counter

**Files:** Modify `packages/core/src/context.ts` `processFileList` (lines 955-979); Test `.../context-fault-class.test.ts`.

The abort guard (`consecutiveBatchErrors`, lines 958-977) must **only** count real faults. A batch whose only failures are wait-class (timeout/no-consumer/connection-lost) — already retried to exhaustion at the provider — is logged but does **not** increment the counter; a batch with a real fault (worker-error/bad-dimension/malformed/Milvus insert error) does. Preserve the 2026-05-05 rogue-worker guard for real faults.

- [ ] **Step 1: Failing test** — simulate a batch that throws a wait-class aggregate vs one that throws a real-class error; assert `consecutiveBatchErrors` increments only for real, and the run aborts only after `MAX_CONSECUTIVE_BATCH_ERRORS` real faults. (Inject a fake `processChunkBuffer`.)
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** the classification: inspect the thrown error's `embedReason`/aggregated reasons; branch the counter logic.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(core): classify wait-vs-real faults; slow workers no longer trip the abort guard`.

### Task 1.7: Reconnect re-establishes consumer + current-`replyQueue` republish

**Files:** Modify `packages/core/src/embedding/rabbitmq-embedding.ts` (`resetState`/`_doInitialize`/`sendOneWithRetry`); Test `.../rabbitmq-reconnect.test.ts`.

On a channel/connection close, in-flight wait-class tasks must be republished after re-init, reading `this.replyQueue` **at publish time** (never a stale closure). Verify the next `embed*` triggers a fresh `_doInitialize` and the republish uses the new reply queue name.

- [ ] **Step 1: Failing test** — start an embed; fire the connection `close` mid-flight; assert pending rejects with `connection-lost` (wait-class) and a subsequent embed re-initializes (asserts a new `assertQueue` call) and publishes with the new reply queue.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — ensure `sendOneWithRetry` reads `this.replyQueue` per attempt; confirm `resetState` tags rejections `connection-lost`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `fix(core): republish wait-class in-flight on reconnect using current reply queue`.

### Task 1.8: Wire new env knobs + optional preflight probe

**Files:** Modify `packages/mcp/src/config.ts` (parse `RABBITMQ_EMBEDDING_MAX_RETRIES`, `RABBITMQ_EMBEDDING_PREFLIGHT`), `packages/mcp/src/embedding.ts` (pass `maxRetries`); add an optional priority-9 preflight in the provider. Test `.../config-knobs.test.ts`.

- [ ] **Step 1: Failing test** — config parses `RABBITMQ_EMBEDDING_MAX_RETRIES=3` to `rabbitmqMaxRetries: 3`; absent → `undefined`.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — mirror the existing `config.ts:155-185` pattern; add `rabbitmqMaxRetries?: number` and `rabbitmqPreflight?: boolean` to `ContextMcpConfig`; pass `maxRetries: config.rabbitmqMaxRetries` in `embedding.ts:84-93`.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(mcp): wire RABBITMQ_EMBEDDING_MAX_RETRIES + preflight knob`.

### Task 1.9: Update provider docs

- [ ] Update `docs/lufftw/rabbitmq-embedding-provider.md`: patient-timeout-as-backstop semantics, retry-via-republish, partial-batch + zero-vector ban, fault classification, new env knobs. Commit `docs(lufftw): document patient-publisher semantics`.

---

## PHASE 2: Snapshot Completeness Ledger

Closes the partial-file hole. Authoritative completeness lives in the snapshot, written only after a file's chunks all confirm inserted. **Highest-risk phase** (touches the indexer core loop) — its own PR, well tested. Depends on Hotfix (paginated readback) + Task 1.5 (per-chunk success reporting).

### Task 2.1: Extend the snapshot schema (optional, back-compat)

**Files:** Modify `packages/mcp/src/config.ts` (`CodebaseInfoIndexed`); Test `.../snapshot-files-field.test.ts`.

Add an optional per-file map to `CodebaseInfoIndexed` (config.ts:58-64):
```ts
export interface FileCompleteness {
    fileHash: string;
    chunkCount: number;
    complete: boolean;
}
export interface CodebaseInfoIndexed extends CodebaseInfoBase {
    status: 'indexed';
    indexedFiles: number;
    totalChunks: number;
    indexStatus: 'completed' | 'limit_reached';
    files?: Record<string, FileCompleteness>; // NEW — per-file completeness ledger
}
```

- [ ] **Step 1: Failing test** — a `CodebaseInfoIndexed` round-trips through JSON with and without `files`; absent `files` stays valid (back-compat).
- [ ] **Step 2–5:** implement the type, verify, commit `feat(mcp): add optional per-file completeness map to snapshot schema`.

### Task 2.2: Snapshot manager read/merge preserves & exposes `files`

**Files:** Modify `packages/mcp/src/snapshot.ts` (`mergeAndWriteSnapshot` already preserves unknown fields via object spread — add a typed setter `setFileComplete(codebasePath, relativePath, info)` and a getter `getFileCompleteness(codebasePath)`); Test `.../snapshot-ledger.test.ts`.

- [ ] **Step 1: Failing test** — `setFileComplete` then `getFileCompleteness` returns the entry; a second session's merge preserves a prior session's `files` entries (mirrors the existing merge test pattern at snapshot.ts:505-555).
- [ ] **Step 2–5:** implement setter/getter writing under the existing `proper-lockfile` path; **flush per-batch, not per-file** (owner decision); verify; commit `feat(mcp): snapshot per-file completeness setter/getter (per-batch flush)`.

### Task 2.3: File-aware completeness tracking in `processFileList`

**Files:** Modify `packages/core/src/context.ts:860-1035`; Test `.../context-file-complete.test.ts`.

Track, per file, how many chunks were produced vs confirmed-inserted across batch flushes (chunks of one file may span batches — keep cross-file batching). Only when a file's confirmed-inserted count equals its produced count do we (a) `processedFiles++` and (b) record `complete:true` for that file with its `fileHash`. A file with any failed chunk stays `complete:false`. Resume (the hash skip at lines 899-908) is gated on `complete:true` AND matching `fileHash`.

- [ ] **Step 1: Failing test (the core correctness gate)** — a file with 3 chunks where chunk 2 permanently fails: assert the file is recorded `complete:false`, `processedFiles` does NOT count it as done, and a re-run re-embeds it. A file whose 3/3 chunks insert: `complete:true`, skipped on re-run.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — per-file tallies keyed by `relativePath`; reconcile at each batch flush using Task 1.5's `failedIndices`; write ledger entries via Task 2.2's setter at batch-flush boundaries; gate the skip on the ledger.
- [ ] **Step 4: Run, verify PASS.**
- [ ] **Step 5: Commit** `feat(core): file-aware completeness; partial files re-embed on resume`.

### Task 2.4: Crash-recovery binary-acceptance test

**Files:** Test `packages/core/src/__tests__/crash-recovery.int.test.ts` (integration, live Milvus + a noop/fake embedding to avoid the shared queue).

- [ ] Index a synthetic corpus with a fake in-process embedding (no RabbitMQ); kill mid-run (simulate by throwing after N files); re-run; assert via (a) Milvus row count, (b) ledger `complete` flags, (c) diff showing zero already-`complete` files re-embedded and zero chunks missing. Exit-code + counts + diff shape; no substring matching; capture and assert with the same runtime. Commit `test(core): crash-recovery binary acceptance for completeness ledger`.

---

## PHASE 3: Native Upsert (idempotent re-writes)

Re-indexing a new/partial file becomes a safe overwrite — no delete-then-insert kill window. Hybrid path is **probe-first**.

### Task 3.1: Add `upsert`/`upsertHybrid` to the interface

**Files:** Modify `packages/core/src/vectordb/types.ts`; Test `.../upsert-iface.test.ts`.

After `insertHybrid` (line 95):
```ts
    /** Upsert vector documents (insert or overwrite by primary key). */
    upsert(collectionName: string, documents: VectorDocument[]): Promise<void>;
    /** Upsert hybrid vector documents (insert or overwrite by primary key). */
    upsertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void>;
```

- [ ] Steps: failing compile test → implement interface → typecheck → commit `feat(core): add upsert/upsertHybrid to VectorDatabase interface`.

### Task 3.2: Implement in the gRPC driver (the active one)

**Files:** Modify `packages/core/src/vectordb/milvus-vectordb.ts`; Test `.../milvus-upsert.test.ts`.

Mirror `insert`/`insertHybrid` (lines 345-369, 607-630) but call `this.client.upsert({collection_name, data})` (SDK 2.5.10 confirms `upsert(data: InsertReq): Promise<MutationResult>`). Check `result.status.error_code === 'Success'`.

- [ ] **Step 1: Failing unit test** — fake client asserts `upsert` is called with mapped data (id/vector/content/...); error_code !== Success throws.
- [ ] **Step 2–4:** implement, verify.
- [ ] **Step 5: Live idempotency gate** — against real Milvus on a throwaway collection: upsert the same deterministic-id doc twice; assert row count stays 1 (no duplicate). Counts captured, not substrings.
- [ ] **Step 6: Commit** `feat(core): native upsert/upsertHybrid in gRPC driver`.

### Task 3.3: RESTful mirror

**Files:** Modify `packages/core/src/vectordb/milvus-restful-vectordb.ts`. Mirror `insert`/`insertHybrid` (lines 362-392, 678-712) calling `/entities/upsert`. Unit-test with a mocked `makeRequest`. Commit `feat(core): native upsert/upsertHybrid in RESTful driver`.

### Task 3.4: Probe-first hybrid upsert decision

**Files:** Test/probe `tmp-hybrid-upsert-probe.mjs` (gitignored) + decision recorded in the plan.

- [ ] Against a real hybrid collection: upsert a known PK and assert `sparse_vector` (BM25 function-output field) regenerates correctly (query it back). If it succeeds → Task 3.5 uses upsert for hybrid. If the SDK rejects function-field upsert → hybrid keeps `deleteByFilter`-before-insert; record the verdict + evidence here. (priority-9 if any embedding is needed; otherwise pure Milvus.)

### Task 3.5: Wire `processChunkBatch` to upsert

**Files:** Modify `packages/core/src/context.ts:1095-1136`; Test `.../context-upsert.test.ts`.

- [ ] Replace `insert`→`upsert` (and `insertHybrid`→`upsertHybrid` **iff** Task 3.4 passed for hybrid; else keep delete-before-insert for hybrid only). Remove the now-unnecessary `deleteByFilter` for changed files on the non-hybrid path (upsert overwrites). Unit-test that re-processing a file calls upsert (not delete+insert). Commit `feat(core): idempotent chunk writes via native upsert`.

---

## Cross-Cutting: Empirical Timeout Default (owner decision)

The `RABBITMQ_EMBEDDING_TIMEOUT_MS` default is **measured, not guessed** (owner decision; CPU workers can run for hours).

- [ ] **M1** Once a CPU worker is actively processing (the queue was stalled at last check — gate on a live worker), publish ~20 representative code chunks at **priority 9** via the normal publish path (no purge), timing each round-trip. Record p50/p99 per-chunk latency to stderr; confirm the shared queue message count is unchanged afterward.
- [ ] **M2** Set the shipped default to a comfortable multiple of observed p99 (headroom for queue wait), bounded under the 2h broker `consumer_timeout`. Record the number + evidence in the spec (§7) and `rabbitmq-embedding-provider.md`.
- [ ] **M3** Until M1 is possible, ship Phase 1 with a provisional default that satisfies the **broker-ceiling invariant** (ARB³ P43/P20): `timeoutMs × (maxRetries + 1) < 7_200_000` (the 2h `consumer_timeout`). With `maxRetries = 3` (P9, lowered from 5), use `timeoutMs = 1_800_000` (30 min) → `1.8M × 4 = 7.2M`, exactly at the ceiling; pick a hair under (e.g. `1_700_000`) for strict `<`. A naive 10-min default with high retries is fine; a naive 100-min default × 4 retries (24M ms) **violates** the ceiling. Add a unit test asserting the invariant holds for the shipped (`timeoutMs`, `maxRetries`) pair so a future edit can't silently regress it. Record the pair + M1 evidence in spec §7.

---

## Final Acceptance (whole plan)

- [ ] Run the **Plan Completion Audit Checklist** (top of this doc) end-to-end; every box checked with captured evidence.
- [ ] `pnpm typecheck && pnpm build` clean.
- [ ] Full `packages/core` test suite green (capture counts).
- [ ] Live priority-9 round-trip returns a 4096-dim normalized vector; shared queue message count unchanged.
- [ ] Both plan copies byte-identical (A1) and the formal copy committed (A2).
- [ ] Spec + provider doc updated with the empirical timeout (E2).
```
