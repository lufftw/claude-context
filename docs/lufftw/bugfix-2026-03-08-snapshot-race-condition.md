# Bugfix: Snapshot Race Condition — Multi-Session Overwrite

**Date**: 2026-03-08
**Version**: v0.1.3-lufftw.2
**Affected files**:
- `packages/mcp/src/snapshot.ts`
- `packages/mcp/package.json` (new dependency: `proper-lockfile`)

---

## Summary

When multiple Claude Code sessions share the same `CLAUDE_CONTEXT_HOME`, their MCP server instances race on writing `mcp-codebase-snapshot.json`. The last writer wins, silently erasing other sessions' codebase records.

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| Indexed codebases disappear from snapshot (e.g., `poi-data-layer` replaced by `event-search-service`) | `saveCodebaseSnapshot()` writes only in-memory state, overwriting the entire file | Read-merge-write with `proper-lockfile` file lock |

---

## Problem

### Scenario

Three projects share `CLAUDE_CONTEXT_HOME`:

```
Session A (poi-data-layer)       → indexes → saves snapshot ✅
Session B (event-search-service) → indexes → saves snapshot ❌ overwrites A's data
Session C (event-chat-service)   → indexes → saves snapshot ❌ overwrites A+B's data
```

After Session C saves, only `event-chat-service` exists in the snapshot. `poi-data-layer` and `event-search-service` records are gone.

### Root Cause

```typescript
// snapshot.ts — saveCodebaseSnapshot() (BEFORE fix)
public saveCodebaseSnapshot(): void {
    const codebases: Record<string, CodebaseInfo> = {};

    // Only writes THIS session's in-memory codebases
    for (const [codebasePath, info] of this.codebaseInfoMap) {
        codebases[codebasePath] = info;
    }

    // Overwrites the ENTIRE file — other sessions' data is lost
    fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));
}
```

Each `SnapshotManager` instance only knows about its own session's codebases. Writing those to the shared file erases everything else.

### Additional Risk: TOCTOU Race

Even if we read-then-write, two sessions can still:

1. Session A reads file (sees: `poi-data-layer`, `event-search-service`)
2. Session B reads file (sees: `poi-data-layer`, `event-search-service`)
3. Session A writes merged result (adds `event-chat-service`)
4. Session B writes merged result (adds `event-crawler`) — **overwrites Session A's addition**

This is a classic TOCTOU (Time-of-check to time-of-use) race that requires a file lock to solve.

---

## Fix

Two-layer defense: **merge semantics** + **file lock**.

### 1. Read-Merge-Write (merge semantics)

Instead of writing only in-memory state, the save operation now:

1. **Reads** the existing file to get all codebases from all sessions
2. **Merges** this session's entries on top (same path → overwrite, different path → preserve)
3. **Removes** codebases explicitly deleted by this session
4. **Writes** the merged result

```typescript
// snapshot.ts — mergeAndWriteSnapshot() (AFTER fix)
private mergeAndWriteSnapshot(): void {
    // 1. Read existing
    let existingCodebases: Record<string, CodebaseInfo> = {};
    const existingData = fs.readFileSync(this.snapshotFilePath, 'utf8');
    const existingSnapshot = JSON.parse(existingData);
    if (existingSnapshot?.formatVersion === 'v2') {
        existingCodebases = existingSnapshot.codebases;
    }

    // 2. Merge: existing as base, this session's entries on top
    const codebases = { ...existingCodebases };
    for (const [codebasePath, info] of this.codebaseInfoMap) {
        codebases[codebasePath] = info;
    }

    // 3. Remove explicitly deleted codebases
    for (const removedPath of this.removedCodebases) {
        delete codebases[removedPath];
    }

    // 4. Write merged result
    fs.writeFileSync(this.snapshotFilePath, JSON.stringify(snapshot, null, 2));
}
```

### 2. File Lock (`proper-lockfile`)

The entire read-merge-write cycle is wrapped in a file lock to prevent TOCTOU races:

```typescript
// snapshot.ts — saveCodebaseSnapshot() (AFTER fix)
public saveCodebaseSnapshot(): void {
    this.ensureSnapshotFileExists();

    let release: (() => void) | undefined;
    try {
        release = lockfile.lockSync(this.snapshotFilePath, {
            retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
            stale: 10000, // Auto-release stale locks from crashed processes
        });

        this.mergeAndWriteSnapshot();
    } finally {
        if (release) release();
    }
}
```

**Lock parameters**:

| Parameter | Value | Reason |
|-----------|-------|--------|
| `retries` | 5 (100ms–1000ms backoff) | Handle short-lived contention from concurrent saves |
| `stale` | 10000ms (10s) | Auto-cleanup locks left by crashed MCP processes |

**Fallback**: If locking fails (e.g., filesystem doesn't support it), falls back to unlocked merge-write. This is still better than the original pure overwrite.

### 3. Removal Tracking (`removedCodebases`)

New field `removedCodebases: Set<string>` tracks codebases explicitly removed by `removeCodebaseCompletely()` (used by `clear_index`). Without this, the merge would resurrect deleted entries from the existing file.

```typescript
public removeCodebaseCompletely(codebasePath: string): void {
    this.codebaseInfoMap.delete(codebasePath);
    this.removedCodebases.add(codebasePath);  // NEW: prevent resurrection on merge
}
```

---

## Changed Files

| File | Change |
|------|--------|
| `packages/mcp/src/snapshot.ts` | Import `proper-lockfile`. Add `removedCodebases` field. Add `ensureSnapshotFileExists()` helper. Extract `mergeAndWriteSnapshot()` with read-merge-write logic. Rewrite `saveCodebaseSnapshot()` with file lock + fallback. Update `removeCodebaseCompletely()` to track removals. |
| `packages/mcp/package.json` | Add `proper-lockfile` dependency, `@types/proper-lockfile` devDependency |

---

## Build & Deploy

```bash
cd E:\Developer\lufftw\repo\claude-context

# Install new dependency
pnpm install

# Build (core + mcp)
pnpm build

# Or just mcp
pnpm build:mcp
```

All projects pointing to the same `dist/index.js` in their MCP config will use the fix on next Claude Code session restart. No config changes needed.

---

## Verification

### Before fix

```
Session A indexes poi-data-layer      → snapshot: { poi-data-layer: indexed }
Session B indexes event-search-service → snapshot: { event-search-service: indexed }
                                         ❌ poi-data-layer is gone
```

### After fix

```
Session A indexes poi-data-layer      → snapshot: { poi-data-layer: indexed }
Session B indexes event-search-service → snapshot: { poi-data-layer: indexed, event-search-service: indexed }
                                         ✅ both preserved
```

### Lock behavior under contention

```
Session A acquires lock → reads → merges → writes → releases
Session B waits (retry 1, 100ms) → acquires lock → reads (sees A's data) → merges → writes → releases
                                   ✅ no data loss
```

### Stale lock recovery

```
Session A acquires lock → crashes (lock file remains)
Session B waits → lock age > 10s → considers stale → acquires lock → proceeds
                 ✅ no permanent deadlock
```

---

## Lessons Learned

1. **Shared files need merge, not overwrite** — When multiple processes write to the same file, each writer must preserve entries it doesn't own. A pure overwrite from in-memory state is always wrong in a shared context.
2. **Merge alone is not enough without a lock** — Read-merge-write has a TOCTOU window. File locks close the gap. Use `stale` timeout to prevent deadlock from crashed processes.
3. **Explicit deletion must be tracked separately** — In a merge model, deleting from in-memory state isn't enough. The merge will re-read the deleted entry from disk. Track deletions explicitly so they survive the merge.
