# Background sync lost rebuilt rows and crossed repositories (2026-11-07)

## What was seen

A rebuild of `gpu-coordinator` passed its audit at 14:38:23 with 1,674 rows in each model. One minute later `gpu_coordinator_own`
held 1,136 rows. `claude_context_own_0p6b` held 470 rows with no 8B twin, 325 of them for files that do not exist in that
repository. A leaked `dummy_collection_*` also appeared.

## Causes

The background sync of one MCP server walks every repository in the shared snapshot. Four defects compounded there.

1. **A rebuild left the old baseline.** `FileSynchronizer.initialize()` loads the saved merkle state and a full index never
   replaced it. The next sync compared disk with a baseline from before the pull, called every file changed since then
   "modified", and deleted rows the index had just written.
2. **The baseline moved before the work.** `checkForChanges()` saved the new state, then the caller deleted and re-embedded. A
   run stopped between the two lost those rows for good, and every later check reported no changes. This is the most likely
   explanation for the older report of files missing from 8B after a run reported complete. That older case was not
   reproduced directly.
3. **A cached synchronizer ignored other processes.** A long-lived server compared disk with its own in-memory baseline, even
   after another process had rebuilt the repository and moved the saved one.
4. **Project identity fell through to the env block.** A project `.env` naming `MILVUS_COLLECTION_PRIVATE` but not
   `MILVUS_COLLECTION_PRIVATE_0P6B` inherited the 0.6B name from the server's env block, which belongs to whichever project
   started that server. The delete then missed the real rows, and the insert wrote into another project's collection.

Separately, `checkCollectionLimit()` creates a throwaway collection. Once a role may create but not drop, as `devtools_rw` may
since 2026-11-07, each index run leaves one behind.

## The fix

| Defect | Change |
|---|---|
| 1 | The index calls `captureBaseline()` before it walks the tree and `commitChanges()` when it completes. A file edited during the index differs from the capture, so the next sync finds it. |
| 2 | `reindexByChange` uses `checkForChanges({ deferCommit: true })` and commits after the rows are back. A throw or a chunk-limit stop leaves the baseline, so the change is found again. |
| 3 | `reindexByChange` calls `initialize()` on a cached synchronizer first. |
| 4 | `getCollectionNameForModel` takes the 0.6B name from the project scope, or derives it from the project's own collection, once the project names one. The env block applies only when the project names nothing. Sync skips a repository with no identity when the env block belongs to another project. |
| Probe | `checkCollectionLimit()` runs only against Zilliz Cloud, whose plan limit it measures. |

## What the fix does not cover

- **A delete and its re-embed are still two steps.** Search can miss a changed file while it is being re-embedded. A stopped run
  now recovers on the next sync, where before it never did.
- **A file that cannot be read is still skipped per file, and the baseline still moves.** Holding the baseline would re-delete
  and retry that file's whole change set on every cycle.
- **A secondary-model batch failure does not hold the baseline.** That model's coverage gate reports the gap instead.
- **The sync lock has no heartbeat.** A sync longer than `CLAUDE_CONTEXT_SYNC_LOCK_STALE_MS` (10 minutes) can be overtaken by a
  second server. Both then redo the same idempotent work, because the baseline moves only on completion.
- **Live servers keep the old code until they restart.** Rows are safe only once every MCP session has restarted.

## Verification

Unit and integration tests cover each change. The end-to-end test used real Milvus, real embedding queues and a live server
with a 15-second sync interval. It planted a stale baseline, rebuilt a probe repository from a server whose env block named a
different project, watched several sync cycles, then made one real edit.

| Check | Before the fix | After the fix |
|---|---|---|
| Files sync called modified with no edit | 6 | 0 |
| Rows in the probe's own 0.6B collection | 0 | 6 |
| Rows written to the env block's 0.6B collection | 7 | 0 |
| Real edit reached both models | 8B only | both |
| Limit probes leaked | 1 | 0 |
