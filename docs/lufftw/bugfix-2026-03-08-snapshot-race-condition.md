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

---

## Follow-up: Two Regressions Fixed on 2026-05-04

The 2026-03-08 fix passed unit tests but failed to actually engage in production. A diagnostic pass triggered by a comprehensive MCP test on 2026-05-04 (running against 7 concurrent MCP processes sharing one snapshot) uncovered the original fix had two latent defects:

### Regression 1 — `lockSync` rejects `retries`

The fix wrapped the read-merge-write in `lockfile.lockSync(file, { retries: { retries: 5, ... }, stale: 10000 })`. `proper-lockfile@4.x`'s sync adapter (`adapter.js:71-76`) explicitly throws `Error: Cannot use retries with the sync api` (`code: 'ESYNC'`) for any non-zero retries on the sync API:

```js
if ((typeof options.retries === 'number' && options.retries > 0) ||
    (options.retries && typeof options.retries.retries === 'number' && options.retries.retries > 0)) {
    throw Object.assign(new Error('Cannot use retries with the sync api'), { code: 'ESYNC' });
}
```

Every save threw immediately and fell through to the catch block, which logged `[WARN] File lock failed, falling back to unlocked save: Cannot use retries with the sync api` and proceeded with an **unlocked** merge. **The lock has never engaged since v0.1.3-lufftw.2.**

#### Fix

Replace the broken call with a hand-rolled retry loop that uses `Atomics.wait` for synchronous backoff (Node's only main-thread sync sleep primitive). The 5-retry, 100 ms → 1 s exponential intent of the original is preserved:

```ts
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const MAX_ATTEMPTS = 6; // 1 initial + 5 retries
for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
        release = lockfile.lockSync(this.snapshotFilePath, { stale: 10000 });
        break;
    } catch (err: any) {
        if (err?.code !== 'ELOCKED') throw err;
        if (attempt === MAX_ATTEMPTS - 1) throw err;
        Atomics.wait(SLEEP_BUF, 0, 0, Math.min(100 * (1 << attempt), 1000));
    }
}
```

### Regression 2 — `loadV2Format` skips missing paths but does not track them as removed

`loadV2Format()` and `loadV1Format()` validate that every codebase path still exists on disk. Missing paths are skipped during load (filtered out of `codebaseInfoMap`), but the ghost is **not** added to `this.removedCodebases`. Consequence: on the next `mergeAndWriteSnapshot()`:

1. Read existing-on-disk → ghost entry is read back into `existingCodebases`
2. Apply this session's `codebaseInfoMap` → ghost is not present, but also not deleted
3. Apply `removedCodebases` → empty, ghost is not deleted
4. Write merged result → **ghost re-emitted unchanged**

The 2026-03-08 fix protected only the path that goes through `removeCodebaseCompletely()` (called by `clear_index`). The much more common load-time invalidation never engaged the same protection.

This pattern caused at least one observed real-world ghost: `E:\Developer\luff-ai-core\repo\event-crawler` (25,289 chunks) survived in the shared snapshot for weeks across many MCP restarts. The path predates a directory layout change to `E:\Developer\lufftw\repo\` and has not existed for some time.

#### Fix

In both `loadV2Format` and `loadV1Format`, when the validator decides a path no longer exists, also mark it for deletion so the next save propagates the removal to disk:

```ts
if (!fs.existsSync(codebasePath)) {
    console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
    this.removedCodebases.add(codebasePath);  // NEW: ensure merge actually deletes it
    continue;
}
```

### Why the original test passed but the fix failed in production

The original verification (lines 198-211 of this document) was conceptual — narrative rather than executed. There was no end-to-end test against `proper-lockfile`'s actual API constraints, and no test that exercised the load-time path invalidation against the merge step. Both regressions are silent: the unlocked fallback produces correct output in the absence of contention, and the ghost only re-emerges on a save. Two MCP processes hammering the snapshot are needed to make the lock failure observable, and a stale path on disk is needed to make the ghost observable. The local dev environment of the original fix likely had neither.

### Lessons added

4. **Match the API you're actually using** — `lockSync` and `lock` have different option semantics in `proper-lockfile@4`. Read the adapter source if the API surface is unclear; do not assume the sync flavor accepts every option the async flavor does.
5. **Validation that filters is not validation that propagates** — silently dropping invalid entries from in-memory state is a half-measure when those entries persist on disk. If a load-time check decides "this should not be here," the same code must record the decision so it survives serialization.
6. **Multi-process concurrency tests must use multiple actual processes** — single-process tests cannot exercise a file lock. Spawn two real Node child processes that contend for the same snapshot file before claiming a lock-based fix works.

### Hardening: atomic write

The same diagnostic pass also noticed that `mergeAndWriteSnapshot()` writes the final JSON with a single `fs.writeFileSync()` to the canonical path. The lock prevents concurrent writers, but does not protect a reader from seeing a half-written file if a writer crashes between `open()` and final flush. Switched to a temp-file-then-`renameSync` pattern so the canonical path is only ever updated atomically:

```ts
const tmp = `${this.snapshotFilePath}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
fs.renameSync(tmp, this.snapshotFilePath);
```

POSIX `rename` and Windows `MoveFileEx` both guarantee atomicity within a single filesystem (the temp file lives next to the target so this holds). A crash during `writeFileSync` of the temp leaves the canonical file untouched; a crash between `writeFileSync` and `renameSync` leaves a leftover `.tmp.<pid>` file (cleaned up on next save). Either way, no reader ever observes a partially-written canonical file.

### Observed real-world impact

The reconciliation pass that followed the fix discovered the bugs had silently dropped tracking for **8 codebases out of 13** in the shared snapshot. Their Milvus collections still held the data (Milvus has independent persistence), but the snapshot's view of the world had been corrupted by repeated TOCTOU-clobbered saves over weeks of operation. The reconciliation script (`scripts/diagnostics/reconcile-snapshot.ps1`) walks every `*_own` Milvus collection that has rows but is not in the snapshot, maps it back to a real repo on disk, and re-registers it. Use `-WhatIf` first.

### Test coverage added

Two scripts in `scripts/diagnostics/` are now part of the maintenance contract for `snapshot.ts`:

- `smoke-test-mcp.sh` — spawns the built `dist/index.js`, exercises `initialize` + `tools/list`, and asserts no `[WARN] File lock failed` in stderr. Catches Regression 1.
- `test-snapshot-fix.sh` — injects a synthetic ghost into the shared snapshot, spawns a fresh MCP, confirms the ghost is detected on load AND purged on next save. Catches Regression 2.

Run both after any change to `snapshot.ts` before publishing.
