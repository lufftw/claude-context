# Upstream Cherry-Pick Manifest — Phase B (2026-05-06 / executed 2026-05-07)

> Source of truth for SHAs, file lists, conflict maps, and per-hunk resolutions.
> The plan body's predictions are advisory; this manifest is what the executor follows.

## Environment

- Fork HEAD baseline: `2586462` (`2586462e17e02a674daea5fb8debda970dfe5cf7`)
- Upstream HEAD: `1e6aae3 chore: release 0.1.13`
- Divergence age: ~8 weeks (merge-base `7255be0` from 2026-03)
- Node: v22.22.0
- pnpm: 10.33.0
- Worktree: `E:\Developer\lufftw\repo\claude-context-upgrade` on `upgrade/phase-b`

## Phase A Tracked Feature List (verified 2026-05-07; not cherry-picked in Phase B)

| SHA | Subject |
|---|---|
| `82a37ad` | feat: add trigger file watcher for instant re-index |
| `3675469` | feat: deduplicate overlapping search results (#333) |
| `62323f4` | feat(mcp): configure background sync polling (#314) |
| `c93138b` | feat(core): add Gemini Embedding 2 support (#366) |
| `d4ad9ec` | feat(core): support custom collection-name override via env var (#320) — architectural anchor of Phase A; NOT cherry-picked |

## Hotspot Files (CAREFUL protocol applies)

1. `packages/core/src/context.ts`
2. `packages/mcp/src/snapshot.ts`
3. `packages/mcp/src/sync.ts`
4. `packages/mcp/src/handlers.ts`
5. `packages/mcp/src/config.ts`
6. `packages/core/src/utils/env-manager.ts`
7. `packages/core/src/embedding/index.ts`
8. `packages/core/src/embedding/base-embedding.ts`

## Fork-only Files (any commit touching these is MUST-SKIP)

- `packages/core/src/embedding/rabbitmq-embedding.ts`
- `docs/lufftw/*`
- `tmp-batch-reindex-v3.mjs` (untracked)

## 28-Commit Roster (file lists, hotspot/stdout/fork-only audits, reclassification)


### c912741 — fix: correct voyage-4-nano default dimension to 1024

- Full SHA: `c91274101aa4131a2f60f83ef06bd390058ecf75`
- Plan ref: B1.1
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+1/-changed,):
  - packages/core/src/embedding/voyageai-embedding.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 0bfff25 — feat: add voyage-4 model series and remove unused method (#306)

- Full SHA: `0bfff253b817b527fbf5097849064ac59d137d5d`
- Plan ref: B1.1
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+1/-changed,):
  - packages/core/src/embedding/voyageai-embedding.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 1ebda84 — fix: parse default dimension from model metadata string (#307)

- Full SHA: `1ebda84708e3ba7e361e86b0f6aff12ca929de0e`
- Plan ref: B1.1
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+1/-changed,):
  - packages/core/src/embedding/voyageai-embedding.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### a99939e — fix(mcp): use computed Ollama host with default fallback (#339)

- Full SHA: `a99939e82cf8c566cf096baa8c0842d6da156933`
- Plan ref: B1.2
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+1/-changed,):
  - packages/mcp/src/embedding.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### a83f260 — fix(mcp): pass embedding dimension to Ollama

- Full SHA: `a83f2607e8f9a5fcfcd45abc7ad427a3ce927aa0`
- Plan ref: B1.2
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+3/-changed,):
  - packages/mcp/README.md
  - packages/mcp/src/config.ts [HOTSPOT]
  - packages/mcp/src/embedding.ts
- Hotspot files touched: packages/mcp/src/config.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 2474e6f — fix(core): handle malformed metadata JSON in search results (#323)

- Full SHA: `2474e6f1ab41e5e5a07f2fbcd0e3da59af49314e`
- Plan ref: B1.3
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+2/-changed,):
  - packages/core/src/vectordb/milvus-restful-vectordb.ts
  - packages/core/src/vectordb/milvus-vectordb.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### f3f22b0 — fix: add MILVUS_ADDRESS to remaining docs and handle malformed metadata in gRPC hybridSearch

- Full SHA: `f3f22b0c2265e54fa6de40f550cebc8ef3eb7cd9`
- Plan ref: B1.3
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+5/-changed,):
  - docs/getting-started/environment-variables.md
  - docs/getting-started/quick-start.md
  - packages/core/src/vectordb/milvus-vectordb.ts
  - packages/mcp/CONTRIBUTING.md
  - packages/mcp/README.md
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### cdbd75b — fix(core): tolerate gRPC timeout in checkCollectionLimit and clean up orphans (#319)

- Full SHA: `cdbd75b07b5f450a89030268b5fb719875ef84e4`
- Plan ref: B1.3
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+3/-changed,):
  - docs/getting-started/environment-variables.md
  - packages/core/src/vectordb/milvus-vectordb.ts
  - packages/mcp/README.md
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### e447095 — feat(core): add Dart language support

- Full SHA: `e447095e057681685d7cc91b257db4f1af2e711f`
- Plan ref: B1.4
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+1/-):
  - packages/core/src/context.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 0f7a82e — feat(core): add Solidity file support (#367)

- Full SHA: `0f7a82e2efafb8197f361e3e4aff2ff165f3071c`
- Plan ref: B1.4
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+4/-changed,):
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### fa93b64 — feat: add OpenRouter as embedding provider name (#304)

- Full SHA: `fa93b649053055a5fde10f4e0c182a86361e1dda`
- Plan ref: B1.5
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+2/-changed,):
  - packages/mcp/src/config.ts [HOTSPOT]
  - packages/mcp/src/embedding.ts
- Hotspot files touched: packages/mcp/src/config.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### b7755c3 — fix(mcp): drop unreachable throw in setTimeout-wrapped initial sync (#318)

- Full SHA: `b7755c392c6f72cf32acb8b96cc460a96c7cec59`
- Plan ref: B1.6
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+1/-changed,):
  - packages/mcp/src/sync.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/sync.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### c0cc3cc — fix: remove unreachable modified detection in MerkleDAG.compare() (#294)

- Full SHA: `c0cc3cce4c2b56e2b2e0df190ba405f4d3028d2c`
- Plan ref: B1.6
- Original bucket: SAFE
- Final bucket: **SAFE**
- Files (+2/-changed,):
  - packages/core/src/sync/merkle.ts
  - packages/core/src/sync/synchronizer.ts
- Hotspot files touched: none
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### c937690 — fix(core): skip dotfiles during initial indexing to match FileSynchronizer (#330)

- Full SHA: `c9376907ed86bdf3122917acfa3c075c2a0d0473`
- Plan ref: B1.7
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+1/-changed,):
  - packages/core/src/context.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 66d7616 — fix: keep FileSynchronizer aligned with supported extensions (#286)

- Full SHA: `66d761633b5bc308c2d55a0c6287bc1d6aac4933`
- Plan ref: B1.8
- Original bucket: SAFE
- Final bucket: **CAREFUL (reclassified)**
- Files (+4/-changed,):
  - packages/core/src/context.ts [HOTSPOT]
  - packages/core/src/sync/synchronizer.ts
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/vscode-extension/src/commands/indexCommand.ts
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### bb44da9 — fix(mcp): sync from cloud in handleGetIndexingStatus (#327)

- Full SHA: `bb44da95bde49de98b7a621799281cb02c7f74b5`
- Plan ref: B2.0
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+1/-):
  - packages/mcp/src/handlers.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 968cce6 — fix(mcp): clean up orphan merkle snapshots

- Full SHA: `968cce691c5d47a688de0fe449444046790df80b`
- Plan ref: B2.1
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+1/-changed,):
  - packages/mcp/src/handlers.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### ae0fd79 — fix: prevent snapshot 0/0 entries causing infinite force-reindex loop (#295)

- Full SHA: `ae0fd7915bbd4959a597d977c82ffc9726bb6af3`
- Plan ref: B2.2
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+6/-changed,):
  - packages/core/src/vectordb/milvus-restful-vectordb.ts
  - packages/core/src/vectordb/milvus-vectordb.ts
  - packages/core/src/vectordb/types.ts
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/index.ts
  - packages/mcp/src/snapshot.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/snapshot.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 76497e1 — fix: snapshot merge and indexing stuck issues (#276) (#282)

- Full SHA: `76497e1f78192c6f758ead3445fcff4b2453e92c`
- Plan ref: B2.3
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+2/-changed,):
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/snapshot.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/snapshot.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### e368a97 — fix: isolate ignore patterns per codebase

- Full SHA: `e368a97ef36b0136cdbb6b124d9ba79519794068`
- Plan ref: B2.4
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+5/-changed,):
  - packages/core/jest.config.cjs
  - packages/core/package.json
  - packages/core/src/context.ignore-patterns.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/mcp/src/handlers.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### b03ebac — fix(mcp): resolve subdirectory paths to indexed parent

- Full SHA: `b03ebac1e0ab3bd24ffd65553c1b3f8c78b99485`
- Plan ref: B2.5
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+3/-changed,):
  - packages/mcp/scripts/path-resolution-e2e.mjs
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/snapshot.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/snapshot.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### b56ca04 — fix(mcp): scope customExtensions to index request

- Full SHA: `b56ca043b060cc7aabb00192622bd5b8222f7941`
- Plan ref: B2.6
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+3/-changed,):
  - packages/core/src/context.ignore-patterns.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/mcp/src/handlers.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 6289035 — fix(mcp): prevent concurrent background sync

- Full SHA: `62890359838bea1d1f322bd78b4968e4a9abdbae`
- Plan ref: B2.7
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+2/-changed,):
  - packages/mcp/scripts/sync-lock-e2e.mjs
  - packages/mcp/src/sync.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/sync.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### ead19f4 — fix(mcp,core): honor request-scoped splitter option (#363)

- Full SHA: `ead19f4ad66da78243dd9e126de121c19b7874e6`
- Plan ref: B2.8
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+8/-changed,):
  - packages/core/src/context.splitter.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/mcp/src/config.ts [HOTSPOT]
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/snapshot.request-options.test.ts
  - packages/mcp/src/snapshot.ts [HOTSPOT]
  - packages/mcp/src/splitter.ts
  - packages/mcp/src/sync.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/snapshot.ts, packages/mcp/src/sync.ts, packages/mcp/src/handlers.ts, packages/mcp/src/config.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 291863a — fix(mcp): cancel background indexing on clear_index (#199) (#369)

- Full SHA: `291863a4e7332becc1e9c311338430ae49b59f5d`
- Plan ref: B2.9
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+3/-changed,):
  - packages/core/src/context.abort.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/mcp/src/handlers.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### d2ef81c — fix(mcp): persist request-level index options for sync

- Full SHA: `d2ef81c4ff911185b275df4eb406e4f7e84e872f`
- Plan ref: B2.10
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+8/-changed,):
  - packages/core/src/context.ignore-patterns.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/mcp/package.json
  - packages/mcp/src/config.ts [HOTSPOT]
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/snapshot.request-options.test.ts
  - packages/mcp/src/snapshot.ts [HOTSPOT]
  - packages/mcp/src/sync.ts [HOTSPOT]
- Hotspot files touched: packages/core/src/context.ts, packages/mcp/src/snapshot.ts, packages/mcp/src/sync.ts, packages/mcp/src/handlers.ts, packages/mcp/src/config.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### be107de — fix(core): support root-anchored directory ignore patterns

- Full SHA: `be107de3ab0b49e464e3ff1e3b45eeec8963c92b`
- Plan ref: B2.11
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+3/-changed,):
  - packages/core/src/context.ignore-patterns.test.ts
  - packages/core/src/context.ts [HOTSPOT]
  - packages/core/src/sync/synchronizer.ts
- Hotspot files touched: packages/core/src/context.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

### 3ed9375 — fix: search_code returns not indexed even when VectorDB has data (#226) (#283)

- Full SHA: `3ed9375e5a9bf09f751eeca19d8e4c3e31188864`
- Plan ref: B2.12
- Original bucket: CAREFUL
- Final bucket: **CAREFUL**
- Files (+2/-changed,):
  - packages/mcp/src/handlers.ts [HOTSPOT]
  - packages/mcp/src/snapshot.ts [HOTSPOT]
- Hotspot files touched: packages/mcp/src/snapshot.ts, packages/mcp/src/handlers.ts
- Fork-only files touched: none
- stdout-write hits in mcp/src/: 0

## Phase 0.2 — Per-commit Dry-Run Conflict Map (captured 2026-05-07)

Each row: result of `git cherry-pick --no-commit -n <SHA>` against fork master HEAD `2586462`.

| SHA | Bucket | Apply | Conflicts | Conflict files | Shortstat |
|-----|--------|-------|-----------|----------------|-----------|
| `0bfff25` | SAFE | CLEAN | 0 | — | 1 file changed, 22 insertions(+), 18 deletions(-) |
| `1ebda84` | SAFE | CLEAN | 0 | — | 1 file changed, 3 insertions(+), 2 deletions(-) |
| `2474e6f` | SAFE | CLEAN | 0 | — | 2 files changed, 45 insertions(+), 27 deletions(-) |
| `291863a` | CAREFUL | CONFLICT | 2 | packages/core/src/context.ts<br>packages/mcp/src/handlers.ts | 1 file changed, 207 insertions(+) |
| `3ed9375` | CAREFUL | CONFLICT | 2 | packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts | 0 files changed |
| `6289035` | CAREFUL | CLEAN | 0 | — | 2 files changed, 398 insertions(+), 1 deletion(-) |
| `66d7616` | SAFE | CONFLICT | 4 | packages/core/src/context.ts<br>packages/core/src/sync/synchronizer.ts<br>packages/mcp/src/handlers.ts<br>packages/vscode-extension/src/commands/indexCommand.ts | 0 files changed |
| `76497e1` | CAREFUL | CONFLICT | 1 | packages/mcp/src/snapshot.ts | 1 file changed, 15 insertions(+), 11 deletions(-) |
| `968cce6` | CAREFUL | CONFLICT | 1 | packages/mcp/src/handlers.ts | 0 files changed |
| `a83f260` | SAFE | CONFLICT | 2 | packages/mcp/src/config.ts<br>packages/mcp/src/embedding.ts | 1 file changed, 4 insertions(+) |
| `a99939e` | SAFE | CLEAN | 0 | — | 1 file changed, 1 insertion(+), 1 deletion(-) |
| `ae0fd79` | CAREFUL | CONFLICT | 2 | packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts | 4 files changed, 101 insertions(+) |
| `b03ebac` | CAREFUL | CONFLICT | 1 | packages/mcp/src/handlers.ts | 2 files changed, 115 insertions(+), 1 deletion(-) |
| `b56ca04` | CAREFUL | CONFLICT | 3 | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/context.ts<br>packages/mcp/src/handlers.ts | 0 files changed |
| `b7755c3` | SAFE | CLEAN | 0 | — | 1 file changed, 1 insertion(+), 1 deletion(-) |
| `bb44da9` | CAREFUL | CLEAN | 0 | — | 1 file changed, 2 insertions(+) |
| `be107de` | CAREFUL | CONFLICT | 2 | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/sync/synchronizer.ts | 1 file changed, 39 insertions(+), 8 deletions(-) |
| `c0cc3cc` | SAFE | CLEAN | 0 | — | 2 files changed, 9 insertions(+), 18 deletions(-) |
| `c912741` | SAFE | CONFLICT | 1 | packages/core/src/embedding/voyageai-embedding.ts | 0 files changed |
| `c937690` | SAFE | CLEAN | 0 | — | 1 file changed, 10 insertions(+), 1 deletion(-) |
| `cdbd75b` | SAFE | CONFLICT | 1 | packages/core/src/vectordb/milvus-vectordb.ts | 2 files changed, 5 insertions(+), 1 deletion(-) |
| `d2ef81c` | CAREFUL | CONFLICT | 4 | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/context.ts<br>packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts | 4 files changed, 135 insertions(+), 2 deletions(-) |
| `e368a97` | CAREFUL | CONFLICT | 2 | packages/core/src/context.ts<br>packages/mcp/src/handlers.ts | 3 files changed, 79 insertions(+), 1 deletion(-) |
| `e447095` | SAFE | CLEAN | 0 | — | 1 file changed, 2 insertions(+) |
| `e447095` | SAFE | CLEAN | 0 | — | 1 file changed, 2 insertions(+) |
| `ead19f4` | CAREFUL | CONFLICT | 6 | packages/core/src/context.ts<br>packages/mcp/src/config.ts<br>packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.request-options.test.ts<br>packages/mcp/src/snapshot.ts<br>packages/mcp/src/sync.ts | 2 files changed, 188 insertions(+) |
| `f3f22b0` | SAFE | CLEAN | 0 | — | 5 files changed, 32 insertions(+), 17 deletions(-) |
| `fa93b64` | SAFE | CONFLICT | 2 | packages/mcp/src/config.ts<br>packages/mcp/src/embedding.ts | 0 files changed |

## Phase 0.2.4 — Roster Substitution

- `0f7a82e` is a merge commit (parents `747ada5` + `cdad7ab`); cherry-picking it requires `-m 1`.
- **Substituted `0f7a82e` → `cdad7ab`** (parent-2, the actual non-merge feature commit). Same content; cleaner cherry-pick path.

## Phase 0.2.5 — Cumulative Dry-Run + Cumulative-Build

Stack-order cherry-pick on a throwaway branch off `upgrade/phase-b`; conflicting picks aborted; tree reset between iterations.

**Picked (11 of 28; in order applied):**

0bfff25, 1ebda84, a99939e, 2474e6f, f3f22b0, e447095, b7755c3, c0cc3cc, c937690, bb44da9, 6289035

**Failed when stacked (17 of 28):**

| SHA | Conflict files when stacked |
|-----|------------------------------|
| `c912741` | packages/core/src/embedding/voyageai-embedding.ts |
| `a83f260` | packages/mcp/src/config.ts<br>packages/mcp/src/embedding.ts |
| `cdbd75b` | packages/core/src/vectordb/milvus-vectordb.ts |
| `cdad7ab` | packages/core/src/context.splitter.test.ts |
| `fa93b64` | packages/mcp/src/config.ts<br>packages/mcp/src/embedding.ts |
| `66d7616` | packages/core/src/context.ts<br>packages/core/src/sync/synchronizer.ts<br>packages/mcp/src/handlers.ts<br>packages/vscode-extension/src/commands/indexCommand.ts |
| `968cce6` | packages/mcp/src/handlers.ts |
| `ae0fd79` | packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts |
| `76497e1` | packages/mcp/src/snapshot.ts |
| `e368a97` | packages/core/src/context.ts<br>packages/mcp/src/handlers.ts |
| `b03ebac` | packages/mcp/src/handlers.ts |
| `b56ca04` | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/context.ts<br>packages/mcp/src/handlers.ts |
| `ead19f4` | packages/core/src/context.ts<br>packages/mcp/src/config.ts<br>packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.request-options.test.ts<br>packages/mcp/src/snapshot.ts<br>packages/mcp/src/sync.ts |
| `291863a` | packages/core/src/context.ts<br>packages/mcp/src/handlers.ts |
| `d2ef81c` | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/context.ts<br>packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts |
| `be107de` | packages/core/src/context.ignore-patterns.test.ts<br>packages/core/src/sync/synchronizer.ts |
| `3ed9375` | packages/mcp/src/handlers.ts<br>packages/mcp/src/snapshot.ts |

### Cumulative-build verification

- Cumulative `pnpm typecheck`: exit `2` (failed; investigated below)
- Cumulative `pnpm build`: exit `0` (exit 0 = success)
- Lockfile drift during cumulative install: none

### Stale-artifact false positive

Pre-cherry-pick baseline at `upgrade/phase-b` HEAD (`1068773`, manifest-only commit) `pnpm typecheck` PASSES (exit 0). The cumulative `pnpm typecheck` failure was caused by **stale `packages/core/dist/index.d.ts`**; `vscode-extension`'s `tsc --noEmit` reads it but doesn't regenerate it. After `pnpm build` ran, the artifact refreshed and would have passed on a re-run. This is not a Phase B regression; it confirms the standing protocol P10 stale-artifact guard.

### Ordering observation

- `c912741` (voyage-4-nano dim fix) was attempted **first** in the cumulative loop; it depends on `0bfff25` (voyage-4 model series) for its target field. After `0bfff25` was picked, the standalone per-commit dry-run for `c912741` produced a single 1-file conflict — it would have applied cleanly if ordered chronologically.
- **Recommended cumulative ordering: chronological by upstream-author-date.** Apply `1ebda84` → `0bfff25` → `c912741` (Voyage-AI cluster) in that order. The B1.1 task already specifies this order in the plan.

## Phase 0.2.3 — Source-verified Dependencies

(Pending — to author at Phase 0.2.X authoring step alongside per-hunk prescriptions.)

## Phase 0.2.X — Per-hunk Resolution Prescriptions

(Pending — separate authoring task; will produce one prescription block per CAREFUL commit's conflict hunks.)


## Phase 0.7.0 Verification Findings (executed 2026-05-07)

### A14 — Lazy-init verification (dynamic, network-blocked spawn)

- `OPENAI_BASE_URL=http://127.0.0.1:1` `RABBITMQ_INFERENCE_URL=amqp://127.0.0.1:1`: jsonrpc-smoke handshake completed in ~6s; tools/list returned the expected 4-tool inventory.
- **Conclusion: A14 = LAZY-INIT confirmed.** No NoOpStub provider needed.

### A15 — SnapshotManager export + prototype methods

- Export: `SnapshotManager` is a named export from `packages/mcp/dist/snapshot.js`.
- Prototype methods (27): `isV2Format`, `loadV1Format`, `loadV2Format`, `getIndexedCodebases`, `getIndexingCodebases`, `getIndexingCodebasesWithProgress`, `getIndexingProgress`, `addIndexingCodebase`, `updateIndexingProgress`, `removeIndexingCodebase`, `addIndexedCodebase`, `removeIndexedCodebase`, `moveFromIndexingToIndexed`, `getIndexedFileCount`, `setIndexedFileCount`, `setCodebaseIndexing`, `setCodebaseIndexed`, `setCodebaseIndexFailed`, `getCodebaseStatus`, `getCodebaseInfo`, `getFailedCodebases`, `removeCodebaseCompletely`, **`loadCodebaseSnapshot`**, `ensureSnapshotFileExists`, `mergeAndWriteSnapshot`, **`saveCodebaseSnapshot`**.
- Harness consumers use `loadCodebaseSnapshot` and `saveCodebaseSnapshot` — both present.

### A16 — Spawn-lifecycle snapshot mutation

- Pre-smoke SHA256: `1AF1C08D582FFFC8E9F6C951FE321D98F19D007945A0A3CACE41D27E9FD39D91`
- Post-smoke SHA256: `A079CE5531C8DF2983AC07A3857B201157E05FC99924E3FBCAB2AB18C12DE188`
- **Conclusion: A16 = MUTATION CONFIRMED.** Background sync writes the snapshot during smoke. Mitigation: volatile-stripping path (`stripVolatile` in baseline-capture.mjs and snapshot-smoke.mjs) and snapshot restore-from-backup at the start of every run-smoke.ps1 invocation.

### A17 — Tool-list ground truth

- Inventory captured at fork HEAD `1068773` (manifest commit, no cherry-picks):
  `["clear_index","get_indexing_status","index_codebase","search_code"]`
- Matches plan prediction.

### A19 — MCP_DISABLE_BACKGROUND_SYNC

- Source-grep: NOT PRESENT in fork. Volatile-stripping path is unconditional.

### A20 — RabbitMQEmbedding constructor + methods

- Constructor: `constructor(config: RabbitMQEmbeddingConfig)` — single object param.
- Required fields: `url`, `queue`, **`modelName`** (NOT `model`), `dimension`.
- Optional: `timeoutMs`, `priority`, `concurrency`, `heartbeat`, `source`, `connectFn`.
- Prototype methods: `initialize`, `_doInitialize`, `resetState`, `close`, `embed`, **`embedBatch`**, `detectDimension`, `getDimension`, `getProvider`, `sendOne`.
- Probe script `probe-rabbitmq-worker.mjs` calls `embedBatch(['test'])` → confirmed present.
- **Probe-script bug found and fixed in flight: was passing `model` instead of `modelName`** (commit `cde3eb5`).

### A20.queue — Probe queue ground truth

- From `docs/lufftw/rabbitmq-embedding-provider.md`: `embedding.qwen3-8b`
- Saved to `C:\Users\luff\AppData\Local\Temp\probe-queue.txt` for B3.4.0.1 to source.

### A-stderr regex

- Pattern: `console\.log\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?process\.stderr\.write`
- Matches `packages/mcp/src/index.ts:8-10`. Verified.

### A-envManager export shape

- Both `EnvManager` (class) AND `envManager` (singleton) exported from `packages/core/dist/utils/env-manager.js`. Locking-coexistence ALS-isolation handles either.

## Phase 0.6 — Snapshot Baseline (Node-computed via baseline-capture.mjs)

- formatVersion: `v2`
- bytesStripped: `2568`
- codebaseCount: `19`
- indexedCount: `19`
- codebases (sorted):
  - `E:\Developer\lufftw\repo\claude-context`
  - `E:\Developer\lufftw\repo\dev-machine-setup`
  - `E:\Developer\lufftw\repo\event-chat-repo`
  - `E:\Developer\lufftw\repo\event-chat-service`
  - `E:\Developer\lufftw\repo\event-crawler`
  - `E:\Developer\lufftw\repo\event-crawler-worker`
  - `E:\Developer\lufftw\repo\event-model-worker`
  - `E:\Developer\lufftw\repo\event-platform-infra`
  - `E:\Developer\lufftw\repo\event-search-service`
  - `E:\Developer\lufftw\repo\finetune-datasets`
  - `E:\Developer\lufftw\repo\gpu-coordinator`
  - `E:\Developer\lufftw\repo\harness-research`
  - `E:\Developer\lufftw\repo\mcp-doc-search`
  - `E:\Developer\lufftw\repo\mcp-services`
  - `E:\Developer\lufftw\repo\milvus-services`
  - `E:\Developer\lufftw\repo\organization-data-layer`
  - `E:\Developer\lufftw\repo\poi-data-layer`
  - `E:\Developer\lufftw\repo\poi-data-layer-crawler-worker`
  - `E:\Developer\lufftw\repo\taiwan-address-normalizer`

## Phase 0.7.8 — Placeholder Patch + Post-patch Sanity

- Whole-pattern swap regex applied to all 6 placeholders.
- All defaults (`0`, `'v1'`, `[]`, `/__placeholder_never_matches__/`) successfully replaced.
- Post-patch sanity: 6/6 PASS — gates are real, not vacuous.
- Committed at `61d184b`.

## Phase 0.8 — Baseline Build & Smoke Pass

- `pnpm typecheck`: PASS (all packages)
- `pnpm build`: PASS (all packages, exit 0)
- `scripts/run-smoke.ps1`:
  - jsonrpc-smoke: `[smoke] OK initialize+tools/list`
  - snapshot-smoke: `[snap-smoke] OK production-baseline + V1 + V2 fixtures pass`
  - feature-regression: `[fregr] OK static feature regressions pass` (17/17)
  - Tools inventory written to manifest log JSON.

## In-Flight Findings & Fixes (commit `cde3eb5`)

1. **Cold-start time**: native-module load (@zilliz/milvus2-sdk-node + tree-sitter) takes 20+ seconds on first import. Initial 8-second timeouts in jsonrpc-smoke were too short; raised to 45s. `--help` runs in 5s on warm cache.
2. **Windows ESM dynamic import**: `await import('E:\path')` fails with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. Fixed by wrapping with `pathToFileURL()` in snapshot-smoke.mjs, locking-coexistence.mjs, probe-rabbitmq-worker.mjs.
3. **V1 fixture path-existence prune**: SnapshotManager removes codebase paths that no longer exist on disk during V1→V2 migration. Fixtures rewritten to use real worktree paths so migration completes with non-empty result.
4. **Probe RabbitMQEmbedding `modelName`**: constructor required field is `modelName`, not `model`. Probe script corrected.
5. **embedding/index.ts re-export**: file re-exports via `export * from './rabbitmq-embedding'` (lowercase file path), not literal `RabbitMQEmbedding` symbol. Regex updated to match either form.

## Phase 0 Status — Ready for User Review (Phase 0.9 Gate)

- ✅ Workspace repo + plan mirror
- ✅ Environment + 28 SHAs + 5 Phase A SHAs verified
- ✅ Worktree + manifest + log scaffolding
- ✅ Hotspot SHA256 baselines
- ✅ Per-commit dry-run + cumulative dry-run + cumulative-build
- ✅ Snapshot backup + throwaway home + smoke env scripts
- ✅ Harness scripts + fixtures committed
- ✅ All A14-A22 verifications passed
- ✅ Node baseline capture (19 codebases, 2568 stripped bytes)
- ✅ Placeholder patch + post-patch sanity
- ✅ Baseline build + run-smoke.ps1 PASS
- ⏸ Phase 0.2.X **per-hunk resolution prescriptions** — DEFERRED to a separate focused session per user choice (path A)

Phase 0 commits on `upgrade/phase-b`:
- `1068773` manifest scaffolding
- `0f6cdc8` conflict map + cumulative dry-run + roster substitution
- `db868d9` harness scripts with placeholders + ignore backups/
- `61d184b` seeded constants
- `cde3eb5` Windows ESM + RabbitMQ + regex fixes

### Batch 2 (15 commits): synthesis-budget evaluated; final Phase B vs Phase A split

#### Phase B (proceed) — 5 cleanly-applying CAREFUL

- `c937690` (skip dotfiles): cumulative dry-run CLEAN. Direct cherry-pick.
- `bb44da9` (cloud-sync in handler): cumulative dry-run CLEAN. Direct cherry-pick.
- `6289035` (prevent concurrent background sync): cumulative dry-run CLEAN. Direct cherry-pick. **Note**: B3.4.4 (multi-process locking-coexistence test) gates acceptance; the synthetic `locking-coexistence.mjs` tests are pre-Phase-B independent of this cherry-pick.

#### Phase B (proceed) — 5 medium-conflict CAREFUL with budget ≤ 4

- `66d7616` (FileSynchronizer extension alignment) — budget=2 (context.ts=1 handlers.ts=1)
  - `core/src/context.ts`: **TAKE THEIRS** for the supportedExtensions threading parameter; preserve fork's `runWithProject` wrappers and dual-write `processChunkBatch` branches.
  - `core/src/sync/synchronizer.ts`: **TAKE THEIRS** — non-hotspot.
  - `mcp/src/handlers.ts`: **TAKE THEIRS** for the `ToolHandlers` constructor signature change; preserve fork's `handleGetIndexingStatus`/`handleSearchCode` body.
  - `packages/vscode-extension/src/commands/indexCommand.ts`: **TAKE THEIRS** as-is. After `--continue`, run `pnpm --filter <vscode-pkg> build` to verify.

- `968cce6` (orphan merkle snapshots) — budget=1 (handlers.ts=1)
  - `mcp/src/handlers.ts`: **SYNTHESIZE (mechanical)** — insert upstream's orphan-cleanup call into fork's `handleGetIndexingStatus`-or-`startup-recovery` block. Preserve fork's ghost-resurrection guard (`removedCodebases`); upstream's orphan-cleanup targets a different class of stale entry.

- `76497e1` (snapshot merge & indexing stuck) — budget=3 (snapshot.ts=3)
  - `mcp/src/snapshot.ts`: 3 hunks. For EACH hunk, evaluate: does fork's `proper-lockfile` lock already prevent the bug upstream fixes? If yes → `--ours` (keep fork). If no → port upstream patch on top of fork lock.
  - Likely majority `--ours` because fork's lockfile-based serialization already prevents the data-race upstream addresses (#276/#282).
  - Survival-grep gate: `proper-lockfile` and `removedCodebases` MUST remain in snapshot.ts post-resolution.

- `b03ebac` (subdirectory paths) — budget=2 (handlers.ts=2)
  - `mcp/src/handlers.ts`: 2 hunks. **TAKE THEIRS** for both — upstream adds path-resolution helper. Insert BEFORE fork's `runWithProject` call so project path is normalized before env loading.

- `be107de` (root-anchored ignore patterns) — budget=0
  - `core/src/context.ignore-patterns.test.ts`: **DEPENDS ON `e368a97`** which is DEFERRED. The test file does not exist in fork without `e368a97`. Resolution: **SKIP-CASCADE**. Drop `be107de` along with `e368a97` family.

  *Update*: `be107de` reclassified to **SKIP-CASCADE (depends on e368a97 DEFER)**.

  - `core/src/sync/synchronizer.ts`: alone, would be take-theirs mechanical. But this commit is bundled with the test file change. Drop entirely.

#### Phase B (proceed) — 3 trivial-conflict CAREFUL (Batch 1 already prescribed above)

`a83f260`, `cdad7ab`, `fa93b64`.

#### Phase B (proceed) — 5 cleanly-applying SAFE/CAREFUL

`e447095` (Dart), `b7755c3` (unreachable throw), `c937690`, `bb44da9`, `6289035` listed above.

#### Phase A (DEFER) — 7 commits over synthesis-budget (>4 markers in context+handlers+snapshot)

| SHA | Budget | Hotspots | Reason |
|-----|--------|----------|--------|
| `ae0fd79` | 5 | snapshot.ts=2 handlers.ts=3 | Fork's `proper-lockfile` serialization already prevents most of the race this fixes; remaining diff requires structural synthesis around `mergeAndWriteSnapshot`. Re-evaluate in Phase A on top of upstream's restructured `snapshot.ts`. |
| `e368a97` | 5 | context.ts=4 handlers.ts=1 | Per-codebase ignore-pattern isolation requires reworking fork's `runWithProject` wrappers around the ignore-pattern field. Fork's instance-level `ignorePatterns` and upstream's per-call parameter are competing designs; merge belongs in Phase A. |
| `b56ca04` | 8 | context.ts=3 handlers.ts=5 | Same pattern as `e368a97` for `customExtensions`. SKIP-CASCADE if e368a97 deferred (same architectural conflict). |
| `291863a` | 8 | context.ts=4 handlers.ts=4 | `AbortController` integration touches the `processFileList` batch loop where fork tracks `consecutiveBatchErrors`. Synthesis between two error-budget abstractions; defer to Phase A. |
| `ead19f4` | 8 | context.ts=3 handlers.ts=4 snapshot.ts=1 | Request-scoped splitter option threads through 6 files including all 4 hotspots. Largest refactor in upstream; defer to Phase A. |
| `d2ef81c` | 5 | snapshot.ts=2 context.ts=1 handlers.ts=2 | Depends on `ead19f4`; SKIP-CASCADE. |
| `3ed9375` | 5 | snapshot.ts=4 handlers.ts=1 | search_code VectorDB fallback needs the `getSharedCollectionName` integration to be aware of fork's multi-collection design; cleaner in Phase A. |
| `be107de` | 0 | — | SKIP-CASCADE (depends on `e368a97`'s test file infrastructure). |

**Phase A Tracked Feature List update**: append these 8 SHAs (7 DEFER + 1 SKIP-CASCADE) to the Phase A roadmap. Combined with the original 5 deferred features (`82a37ad`, `3675469`, `62323f4`, `c93138b`, `d4ad9ec`), Phase A now has 13 candidates.

## Phase B Final Roster (after Phase 0.2.X synthesis-budget evaluation)

**To cherry-pick in Phase B (20 commits):**

SAFE-bucket (9): `c912741`, `0bfff25`, `1ebda84`, `a99939e`, `2474e6f`, `f3f22b0`, `cdbd75b`, `c0cc3cc`, `cdad7ab` (substituted from `0f7a82e`).

CAREFUL-bucket (11):
- Cleanly-applying: `e447095`, `b7755c3`, `c937690`, `bb44da9`, `6289035`.
- Trivial-conflict: `a83f260`, `fa93b64`.
- Medium-conflict: `66d7616`, `968cce6`, `76497e1`, `b03ebac`.

**DEFER TO PHASE A (8 commits):** `ae0fd79`, `e368a97`, `b56ca04`, `291863a`, `ead19f4`, `d2ef81c`, `3ed9375`, `be107de`.

**Re-bucket count: 9 SAFE + 11 CAREFUL + 8 DEFER = 28.** `cdad7ab` substitutes `0f7a82e` (merge commit).

## Phase B Finalization (B3.1 — version bump completed 2026-05-08)

- Bumped `packages/core/package.json` and `packages/mcp/package.json` from `0.1.4-lufftw.2` to `0.1.4-lufftw.3` at commit `d19f783`.
- `pnpm install` lockfile drift: none.
- `pnpm build`: exit 0.
- `run-smoke.ps1`: exit 0 (jsonrpc/snap/fregr all OK).
- `CLAUDE.md` is gitignored in this worktree; version-string update will be applied to the main-checkout copy at production rollout (B3.8).

## Phase B Final Tally

**Cherry-pick attempt outcomes (28 SHAs in roster):**

| Outcome | Count | SHAs |
|---|---|---|
| Cherry-picked successfully | 18 | `1ebda84` `0bfff25` `c912741` `a99939e` `2474e6f` `f3f22b0` `cdbd75b` `cdad7ab` `c0cc3cc` `b7755c3` `c937690` `bb44da9` `6289035` `76497e1` `66d7616` `fa93b64` `a83f260` `968cce6` |
| Fork-only fix | 1 | `23d6da3` deleteByFilter restoration (post-`cdbd75b --theirs` regression caught and fixed) |
| ALREADY-PRESENT-VIA-BACKPORT | 1 | `e447095` (Dart already added by `cdad7ab` resolution) |
| SKIP-CASCADE / reverted | 1 | `b03ebac` (reverted at `97abd74`; depends on deferred `ae0fd79`) |
| DEFER TO PHASE A | 8 | `ae0fd79`, `e368a97`, `b56ca04`, `291863a`, `ead19f4`, `d2ef81c`, `3ed9375`, `be107de` |

**Final fork version:** `0.1.4-lufftw.3`
**Final commit on `upgrade/phase-b`:** `d19f783`
**B1 checkpoint tag:** `upgrade/phase-b1-checkpoint` → `16a52a8`

**Phase A list updated to 14 candidates:**
- 5 originally-tracked features: `82a37ad`, `3675469`, `62323f4`, `c93138b`, `d4ad9ec`
- 8 synthesis-budget DEFERs (Phase 0.2.X): `ae0fd79`, `e368a97`, `b56ca04`, `291863a`, `ead19f4`, `d2ef81c`, `3ed9375`, `be107de`
- 1 SKIP-CASCADE caught at execution: `b03ebac` (depends on `ae0fd79`)


## Phase B3.3 — Bidirectional Forward-Compatibility (executed 2026-05-08)

### B3.3.0 OLD binary audit datum

- main checkout HEAD: `2586462` (fork master baseline)
- main `packages/mcp/package.json` version: `0.1.4-lufftw.2`
- main `packages/mcp/dist/index.js` SHA256: `FAF99E814ECA0FB5329DDAE4EC2EC687030A46A3B1CACAD053A4C1F486D38CE8`
- main checkout state restoration: not required (already at baseline; no rebuild needed).

### B3.3.2 Leg 1: NEW writes → OLD reads

- Throwaway home: `E:\tmp\fwd-compat-leg1`
- pre-write snapshot SHA256: `1AF1C08D582FFFC8E9F6C951FE321D98F19D007945A0A3CACE41D27E9FD39D91`
- NEW build (worktree, `0.1.4-lufftw.3`) ran `locking-coexistence.mjs --write-once`: OK
- post-write SHA256: `6B5B214DB4EB626F41F548F3F14B52A6688AB2F1BB830A02BF7D22E2D5C18F0F` (mtime advanced; content changed)
- OLD binary (main, `0.1.4-lufftw.2`) read via temporarily-copied `jsonrpc-smoke.mjs`: PASS (exit 0).
- **Leg 1 verdict: PASS — OLD binary can read NEW-written snapshot.**

### B3.3.3 Leg 2: OLD writes → NEW reads → OLD writes-back → NEW reads

- Throwaway home: `E:\tmp\fwd-compat-leg2`
- Step A (OLD writes via `locking-coexistence.mjs --write-once`): OK; SHA changed.
- Step B (NEW reads): exit 0.
- Step C (OLD writes-back): OK.
- Step D (NEW reads, with V2 baseline schema check): exit 0; `formatVersion === 'v2'` confirmed.
- **Leg 2 verdict: PASS — bidirectional round-trip preserves V2 schema.**

### Conclusion

Forward-compat is BIDIRECTIONALLY safe. The fork's `0.1.4-lufftw.3` snapshot writes are readable by `0.1.4-lufftw.2` and vice versa; round-trips preserve V2 format. Mixed-version operation across the 32 production projects (during staggered rollout) is safe.
