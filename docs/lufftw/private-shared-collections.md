# Private + Shared Collection Support

> **Status:** feature reference, reviewed 2026-11-04 against `0.1.15-lufftw.2`. Since the original
> version: `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` (upstream 0.1.15) applies only when
> `MILVUS_COLLECTION_PRIVATE` is unset; secondary-model collections (`<private>_0p6b`) exist;
> `MILVUS_AUTOLOAD_DENY` can block implicit loads. All variables are listed in
> [fork configuration](../reference/fork-configuration.md).

**Version**: v0.1.3-lufftw.1 (updated v0.1.4-lufftw.2)
**Based on**: upstream v0.1.3 (zilliztech/claude-context)
**Date**: 2026-03-08 (updated 2026-03-14)

---

## Overview

Adds multi-collection search to claude-context, enabling projects to maintain isolated private indexes while sharing domain knowledge across related projects.

**Upstream behavior**: Each codebase gets an auto-generated collection name (`hybrid_code_chunks_{md5_hash}`). No cross-project search.

**Fork behavior**: Custom collection names via env vars. Search queries both private and shared collections, merging results by score.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MILVUS_COLLECTION_PRIVATE` | auto-generated hash | Custom private collection name (e.g., `event_crawler_own`) |
| `MILVUS_COLLECTION_SHARED` | — | Shared collection to query alongside private |
| `MILVUS_WRITABLE_SHARED` | — | When set, indexing dual-writes to both private AND this collection (one embedding cost) |
| `MILVUS_STRATEGY` | — | `hybrid`: query private + shared. `private`: query private only |
| `CLAUDE_CONTEXT_HOME` | `~/.context` | Snapshot directory override for multi-user sharing |

---

## How It Works

### Indexing (`index_codebase`)

Writes to the private collection. With `MILVUS_WRITABLE_SHARED`, also writes to the shared collection using the same embeddings (no additional API cost).

```
# Basic: private only
MILVUS_COLLECTION_PRIVATE=event_crawler_own
→ index_codebase writes to: event_crawler_own
→ embedding cost: 1x

# Dual-write: private + shared (same embedding cost)
MILVUS_COLLECTION_PRIVATE=event_crawler_own
MILVUS_WRITABLE_SHARED=event_shared
→ index_codebase writes to: event_crawler_own + event_shared
→ embedding cost: 1x (same embeddings inserted into both collections)
```

### Searching (`search_code`)

With `MILVUS_STRATEGY=hybrid`, searches both collections and merges results by score:

```
MILVUS_COLLECTION_PRIVATE=event_crawler_own
MILVUS_COLLECTION_SHARED=event_shared
MILVUS_STRATEGY=hybrid

→ search_code queries: event_crawler_own + event_shared
→ results merged by score, topK returned
→ shared results prefixed with [shared] in relativePath
```

With `MILVUS_STRATEGY=private`, searches only the private collection (same as upstream).

**Unset or any other value:** the shared collection is still searched whenever
`MILVUS_COLLECTION_SHARED` is set. `Context.getSharedCollectionName()` returns `undefined` only for
`private`. To keep a project private, set `MILVUS_STRATEGY=private` explicitly, or leave
`MILVUS_COLLECTION_SHARED` unset.

Search with the secondary embedding model (`embeddingModel=qwen3-embedding-0.6b`) never merges
the shared collection, because it is built at the primary model's dimension. See
[design-2026-06-14-dual-embedding.md](./design-2026-06-14-dual-embedding.md).

### Snapshot (`CLAUDE_CONTEXT_HOME`)

Indexing state stored in `$CLAUDE_CONTEXT_HOME/mcp-codebase-snapshot.json`.

Default: `~/.context/` (per-user, same as upstream).
Override: shared directory for multi-user environments.

---

## Configuration Example

### Per-project `.env`

```bash
# Hybrid: private index + shared domain knowledge
MILVUS_STRATEGY=hybrid
MILVUS_COLLECTION_PRIVATE=event_crawler_own
MILVUS_COLLECTION_SHARED=event_shared
MILVUS_WRITABLE_SHARED=event_shared    # Optional: dual-write to shared on indexing
```

### `~/.claude.json` (user scope)

```json
{
  "claude-context-lufftw-0.1.3.1": {
    "type": "stdio",
    "command": "node",
    "args": ["E:\\Developer\\lufftw\\repo\\claude-context\\packages\\mcp\\dist\\index.js"],
    "env": {
      "MILVUS_ADDRESS": "140.115.54.62:19530",
      "OPENAI_API_KEY": "${OPENAI_API_KEY}",
      "MILVUS_TOKEN": "${MILVUS_TOKEN}",
      "CLAUDE_CONTEXT_HOME": "E:\\Developer\\lufftw\\repo\\claude-control-center\\mcp\\machines\\61server\\share\\claude-context\\.context"
    }
  }
}
```

---

## Changed Files

| File | Change |
|------|--------|
| `packages/core/src/context.ts` | `getCollectionName()`: read `MILVUS_COLLECTION_PRIVATE`. `getSharedCollectionName()`: new method. `getWritableSharedCollectionName()`: read `MILVUS_WRITABLE_SHARED`. `semanticSearch()`: multi-collection search with score merge. `prepareCollection()`: also creates shared collection. `processChunkBatch()`: dual-write to shared collection. |
| `packages/mcp/src/snapshot.ts` | Constructor reads `CLAUDE_CONTEXT_HOME` env. |

---

## Upstream Sync

Check divergence:
```bash
bash E:\Developer\lufftw\repo\claude-control-center\scripts\check-claude-context-upstream.sh
```

Merge upstream:
```bash
git fetch upstream master
git checkout -b sync/upstream-<date> origin/main
git merge --no-ff upstream/master
# resolve conflicts (context.ts, snapshot.ts, handlers.ts, sync.ts), then build and test
```

The full procedure is in [upstream-sync.md](../maintenance/upstream-sync.md). Merge through a pull
request into `main` (the fork has no `master` branch). **Do not push `v*` tags:**
`.github/workflows/release.yml` would try to publish to the `@zilliz` npm scope.

---

## Related Documentation

- [project-env-loading.md](./project-env-loading.md) — Project `.env` loading support (v0.1.4-lufftw.2)
- `milvus-services/docs/claude-context/` — Collection strategies, project registry, env reference
- `mcp-services/docs/claude-context/` — Usage guide, setup guide
- `claude-control-center/scripts/check-claude-context-upstream.sh` — Version check
