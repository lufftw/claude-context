# Private + Shared Collection Support

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

With `MILVUS_STRATEGY=private` (or unset), searches only private (same as upstream).

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
cd E:\Developer\lufftw\repo\claude-context
git fetch upstream --tags
git merge upstream/master
# resolve conflicts in packages/core/src/context.ts, packages/mcp/src/snapshot.ts
pnpm build
git tag v<new_version>-lufftw.1
git push origin master --tags
```

---

## Related Documentation

- [project-env-loading.md](./project-env-loading.md) — Project `.env` loading support (v0.1.4-lufftw.2)
- `milvus-services/docs/claude-context/` — Collection strategies, project registry, env reference
- `mcp-services/docs/claude-context/` — Usage guide, setup guide
- `claude-control-center/scripts/check-claude-context-upstream.sh` — Version check
