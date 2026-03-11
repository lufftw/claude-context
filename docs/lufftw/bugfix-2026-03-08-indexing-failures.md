# Bugfix: Indexing Failures on Windows with Custom Collections

**Date**: 2026-03-08
**Version**: v0.1.3-lufftw.1
**Affected files**:
- `packages/core/src/context.ts`
- `packages/mcp/src/handlers.ts`

---

## Summary

Three bugs caused `event-chat-service` to consistently index **0 files** or have its index immediately deleted after completion. All three were discovered and fixed in a single debugging session.

| # | Symptom | Root Cause | Fix |
|---|---------|-----------|-----|
| 1 | 0 files indexed | `.dockerignore` wildcard `*` treated as code ignore | Skip `.dockerignore` in `findIgnoreFiles()` |
| 2 | Index deleted after completion | Path separator mismatch in `syncWithCloud` | Normalize `\` → `/` before comparison |
| 3 | Index deleted after completion | Custom collection names skipped by sync | Include env-configured collections in sync check |

---

## Bug 1: `.dockerignore` Causes 0 Files Indexed

### Problem

`event-chat-service` has a `.dockerignore` containing just `*` (ignore everything for Docker build context). The `findIgnoreFiles()` method in `context.ts` reads **all** `.*ignore` files and merges their patterns into the code indexing ignore list.

Result: every file matched the `*` pattern → 0 files indexed.

### Root Cause

```typescript
// context.ts — findIgnoreFiles()
// Picks up ANY file matching .*ignore, including .dockerignore
for (const entry of entries) {
    if (entry.isFile() &&
        entry.name.startsWith('.') &&
        entry.name.endsWith('ignore')) {
        ignoreFiles.push(path.join(codebasePath, entry.name));
    }
}
```

`.dockerignore` is Docker-specific and not relevant to code indexing. Its `*` pattern is valid for Docker but catastrophic for file discovery.

### Fix

```typescript
// context.ts — findIgnoreFiles()
const SKIP_IGNORE_FILES = new Set(['.dockerignore']);

for (const entry of entries) {
    if (entry.isFile() &&
        entry.name.startsWith('.') &&
        entry.name.endsWith('ignore') &&
        !SKIP_IGNORE_FILES.has(entry.name)) {
        ignoreFiles.push(path.join(codebasePath, entry.name));
    }
}
```

### How to detect

If `get_indexing_status` reports `0 files, 0 chunks` but the project clearly has source files, check for a `.dockerignore` with broad patterns like `*` or `**`.

---

## Bug 2: Path Separator Mismatch in `syncWithCloud`

### Problem

After successful indexing (1593 files, 10487 chunks), `event-chat-service` disappeared from the snapshot within seconds. The `syncIndexedCodebasesFromCloud()` method removed it.

### Root Cause

`syncWithCloud` compares local snapshot paths with cloud collection metadata paths using `Set.has()` (strict string equality):

```typescript
// handlers.ts — syncIndexedCodebasesFromCloud()
for (const localCodebase of localCodebases) {
    if (!cloudCodebases.has(localCodebase)) {  // STRICT comparison
        this.snapshotManager.removeIndexedCodebase(localCodebase);
    }
}
```

On Windows, the local snapshot stores paths with backslashes (`E:\\Developer\\...`) while cloud metadata may store forward slashes (`E:/Developer/...`). The `Set.has()` comparison fails → local entry deleted.

### Fix

```typescript
// handlers.ts — syncIndexedCodebasesFromCloud()
const normalizePath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

const normalizedCloudPaths = new Set<string>();
for (const cp of cloudCodebases) {
    normalizedCloudPaths.add(normalizePath(cp));
}

for (const localCodebase of localCodebases) {
    if (!normalizedCloudPaths.has(normalizePath(localCodebase))) {
        this.snapshotManager.removeIndexedCodebase(localCodebase);
    }
}
```

### Impact

This bug affects **any Windows user** where the path stored in Milvus metadata differs in separator style from the local snapshot. It is silent — indexing appears to succeed, but the snapshot is cleaned up immediately.

---

## Bug 3: Custom Collection Names Skipped by Cloud Sync

### Problem

Even after fixing Bug 2, `event-chat-service` was still deleted by `syncWithCloud`. The custom collection name `event_chat_service_own` (set via `MILVUS_COLLECTION_PRIVATE`) was not recognized as a code collection.

### Root Cause

`syncWithCloud` only checks collections matching the `code_chunks_*` or `hybrid_code_chunks_*` naming pattern:

```typescript
// handlers.ts — syncIndexedCodebasesFromCloud()
if (!collectionName.startsWith('code_chunks_') &&
    !collectionName.startsWith('hybrid_code_chunks_')) {
    console.log(`Skipping non-code collection: ${collectionName}`);
    continue;  // event_chat_service_own is SKIPPED
}
```

Since `event_chat_service_own` doesn't match either prefix, it was never added to `cloudCodebases`. The sync then saw it as "local only, not in cloud" → deleted.

### Fix

Also include collections that match the env-configured custom names:

```typescript
// handlers.ts — syncIndexedCodebasesFromCloud()
const knownCustomCollections = new Set<string>();
const privateCol = this.context.getCollectionName('');
if (privateCol) knownCustomCollections.add(privateCol);
const sharedCol = this.context.getWritableSharedCollectionName();
if (sharedCol) knownCustomCollections.add(sharedCol);
const readSharedCol = this.context.getSharedCollectionName();
if (readSharedCol) knownCustomCollections.add(readSharedCol);

for (const collectionName of collections) {
    const isCodeChunks = collectionName.startsWith('code_chunks_') ||
                         collectionName.startsWith('hybrid_code_chunks_');
    const isKnownCustom = knownCustomCollections.has(collectionName);
    if (!isCodeChunks && !isKnownCustom) {
        continue;  // Skip truly unrelated collections
    }
    // ... query metadata for codebasePath
}
```

### Impact

This bug affects **any user using `MILVUS_COLLECTION_PRIVATE`** with a custom name. Without this fix, every index is deleted by the next sync cycle.

---

## Additional Fix: `.contextinclude` for Dot-Prefixed Directories

### Problem

`event-chat-service` stores all source code under `.opencode/` (dot-prefixed directory). The `FileSynchronizer` skips dot-prefixed directories by default (to avoid `.git/`, `.vscode/`, etc.), resulting in 0 files even after fixing Bug 1.

### Solution

Added `.contextinclude` file support. A file at the project root lists dot-prefixed directories that should be included in indexing:

```
# .contextinclude
.opencode
```

**Implementation**:
- `context.ts`: `loadIncludeDotDirs()` reads `.contextinclude` and populates `this.includeDotDirs`
- `synchronizer.ts`: `shouldSkipFile()` checks `includeDotDirs` before skipping dot directories

This was implemented prior to this bugfix session and was already working correctly.

---

## Verification

After all three fixes, the indexing pipeline works end-to-end:

```
$ # Index event-chat-service
$ # Result: 1593 files, 10487 chunks
$ # Dual-write: event_chat_service_own + event_shared
$ # Snapshot persists after sync — not deleted
```

Cross-project search returns results from both private and `[shared]` collections:

```
Query: "MCP tool for searching events"

event-chat-service:
  Rank 1: docs/capabilities/event-search-service.md          (private)
  Rank 2: [shared] docs/capabilities/event-search-service.md (shared)

event-search-service:
  Rank 1: docs/capabilities/event-search-service.md          (private)
  Rank 2: [shared] docs/capabilities/event-search-service.md (shared)

event-crawler:
  Rank 1: docs/capabilities/event-search-service.md          (private)
  Rank 2: [shared] docs/capabilities/event-search-service.md (shared)
```

---

## Lessons Learned

1. **Never blindly load all `.*ignore` files** — `.dockerignore`, `.npmignore`, `.slugignore` have different semantics than `.gitignore`. Filter by relevance.
2. **Always normalize paths before comparison on Windows** — `\` vs `/` and case sensitivity cause silent failures.
3. **Custom naming must be reflected in all subsystems** — if indexing supports custom collection names, sync/cleanup must also recognize them. Otherwise the right hand deletes what the left hand created.
