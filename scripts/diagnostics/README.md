# Diagnostics Scripts

Reusable troubleshooting tooling for the lufftw fork of claude-context. These scripts were extracted from the 2026-05-04 incident response when two regressions in the snapshot race-condition fix caused stale-path resurrection across seven concurrent MCP processes.

## Scripts

| Script | What it does | When to run |
|---|---|---|
| [`check-snapshot.ps1`](./check-snapshot.ps1) | Lists every entry in the shared codebase snapshot, marks ghosts (paths that no longer exist on disk), prints summary. Read-only. | Any time you suspect snapshot pollution, or after running `clear_index` to confirm propagation. |
| [`remove-snapshot-ghost.ps1`](./remove-snapshot-ghost.ps1) | Manually drops one ghost entry from the snapshot. Refuses to remove paths that actually exist. | Stop-gap when stale MCPs (running pre-fix code) keep resurrecting a ghost. After all sessions are restarted with the fix, ghosts auto-clean and this script is rarely needed. |
| [`smoke-test-mcp.sh`](./smoke-test-mcp.sh) | Spawns the built `dist/index.js`, sends `initialize` + `tools/list` over stdio, asserts JSON-RPC responses + lock health + provider init. | After `pnpm build:mcp`, before claiming the binary works. |
| [`test-snapshot-fix.sh`](./test-snapshot-fix.sh) | Injects a synthetic ghost into the shared snapshot, spawns a fresh MCP, confirms the ghost is detected on load AND purged on next save. Verifies both the lock fix and the `removedCodebases` enrollment fix. | Regression test before publishing a new snapshot.ts change. |

A sibling script lives in [`event-crawler/scripts/diagnostics/probe-home-lan-routing.ps1`](../../../event-crawler/scripts/diagnostics/probe-home-lan-routing.ps1) for testing the broader Milvus / RabbitMQ / Postgres / Redis endpoint matrix from any consumer subnet.

## Background

These scripts exist because the 2026-03-08 file-lock fix shipped without a multi-process integration test:

- The sync flavour of `proper-lockfile@4` rejects `retries` (`ESYNC`); the fix called `lockSync` with `retries: { retries: 5, ... }` so every save threw and silently fell through to an **unlocked** `mergeAndWriteSnapshot`. The lock had never engaged in production.
- `loadV2Format()` filtered ghost entries out of in-memory `codebaseInfoMap` but did not enroll them in `removedCodebases`. The merge step on the next save read the ghost back from disk and re-emitted it. The original ghost (`E:\Developer\luff-ai-core\repo\event-crawler`, 25,289 chunks) survived weeks of MCP restarts this way.

Both bugs are silent unless you have multiple processes contending for the same file. `smoke-test-mcp.sh` would have caught regression 1; `test-snapshot-fix.sh` would have caught regression 2. Both are now part of the maintenance contract for this file.

Full incident write-up: [`docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md`](../../docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md), section "Two Regressions Fixed on 2026-05-04".
