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
