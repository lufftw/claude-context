# Upstream Synchronisation Runbook

How to bring `lufftw/claude-context` up to date with
[`zilliztech/claude-context`](https://github.com/zilliztech/claude-context) without losing fork
behaviour or leaking credentials.

## Current state

| Item | Value |
|---|---|
| Upstream branch tracked | `master` |
| Last merged upstream commit | `6fc318b` — *fix(mcp): derive default version from package metadata* (upstream 0.1.15) |
| Fork merge commit | `3efdbfc` (merged to `main` via `bd48994`, 2026-11-04) |
| Fork package version | `0.1.15-lufftw.2` (`core`, `mcp`); dependency refresh in [dependency-policy.md](dependency-policy.md) |
| Detailed record | [upstream-merge-2026-11-04.md](../lufftw/upstream-merge-2026-11-04.md) |

As of 2026-11-04, `git ls-remote upstream refs/heads/master` still returns `6fc318b`, so the fork is
level with upstream. The other upstream branches (`claude_context`, `opt_des`, `refactor_*`) are
stale July/August 2025 work and are not tracked.

## Strategy

Since 0.1.15 the fork uses a **real `git merge` of `upstream/master`**, replacing the earlier
cherry-pick process ([cherry-pick log](../lufftw/upstream-cherry-pick-log.md)). A merge keeps
`git merge-base` meaningful, so each later sync only replays new upstream commits.

Versioning: `<upstream-version>-lufftw.<n>`. Reset `n` to `1` when the upstream version changes;
increment it for fork-only releases.

## Procedure

### 1. Check whether there is anything to merge

```bash
git remote add upstream https://github.com/zilliztech/claude-context.git
```

```bash
git fetch upstream master
```

```bash
git log --oneline HEAD..upstream/master
```

No output means the fork is current; stop here.

### 2. Merge on a branch

```bash
git checkout -b sync/upstream-$(date +%Y-%m-%d) origin/main
```

```bash
git merge --no-ff upstream/master
```

### 3. Resolve conflicts by intent, not by side

These files carry most fork behaviour and are where conflicts concentrate:

| File | Fork behaviour that must survive |
|---|---|
| `packages/core/src/context.ts` | Multi-collection search (private + shared), dual embedding (primary + secondary per-model collections), partial-tolerant batch embedding with consecutive-failure abort, resume ledgers, upsert write path, `indexCodebase` parameter order |
| `packages/mcp/src/snapshot.ts` | `proper-lockfile` read-merge-write with atomic rename; interrupted `indexing` entries kept as-is on load; `CLAUDE_CONTEXT_HOME` |
| `packages/mcp/src/handlers.ts` | Project-scoped env (`envManager.runWithProject`), model-aware search, coverage gating |
| `packages/mcp/src/sync.ts` | Cloud sync must not re-add cloud-only codebases (Milvus is shared across machines) |
| `packages/mcp/src/config.ts`, `embedding.ts` | RabbitMQ provider and secondary-model configuration |
| `packages/core/src/utils/env-manager.ts` | Precedence: project `.env` > `process.env` > `~/.context/.env` |
| `packages/core/src/vectordb/*` | `MILVUS_AUTOLOAD_DENY` honoured by both gRPC and REST `ensureLoaded` |

Rules of thumb:

- **New upstream parameters are appended** after the fork's parameters so existing call sites keep
  working; adapt upstream tests to that order rather than reordering the fork.
- **Adopt upstream fixes that are orthogonal** (ignore matching, splitters, providers, cancellation).
- **Reconcile, don't drop, overlapping intents.** Example from 0.1.15: upstream's "any embedding
  error aborts" was reconciled with the fork's partial-tolerant embedding by raising
  `EmbeddingError` only when the primary target stored nothing.
- **Document every behaviour you keep in place of upstream's** in the merge record.
- Upstream `CLAUDE.md` is kept as `docs/upstream-repository-guide.md`; the fork's `AGENTS.md` wins.

### 4. Bump versions

Update `version` in `packages/core/package.json` and `packages/mcp/package.json` to
`<upstream-version>-lufftw.1`, then refresh the lockfile:

```bash
pnpm install
```

### 5. Verify

```bash
pnpm install --frozen-lockfile
```

```bash
pnpm build
```

```bash
pnpm --filter @zilliz/claude-context-core test
```

```bash
pnpm --filter @zilliz/claude-context-mcp test
```

```bash
pnpm check:secrets
```

Upstream commits are scanned too: a sync can import a credential just as a fork commit can. Run the
history audit (`pnpm check:secrets:history`) and confirm that it reports no blob that is not
already listed under *Known historical exposure* in
[credential-handling.md](../security/credential-handling.md).

Before merging to `main`, smoke-test the MCP server against a real Milvus instance with credentials
from the environment (`scripts/smoke-env.ps1`, `scripts/run-smoke.ps1`).

### 6. Record and merge

1. Add `docs/lufftw/upstream-merge-<date>.md` with: upstream range, adopted changes, fork behaviour
   kept, signature changes, test adaptations.
2. Update the *Current state* table above.
3. Open a pull request into `main`; never push the merge directly.

## Release caution

`.github/workflows/release.yml` publishes `@zilliz/claude-context-core`,
`@zilliz/claude-context-mcp` and the VS Code extension on any pushed `v*` or `c*` tag, using the
repository's `NPM_TOKEN` and `VSCE_PAT` secrets. The fork does not own the `@zilliz` npm scope, so
pushing a `v*-lufftw.*` tag runs a publish job that fails (or, if those secrets were ever set to
credentials that can write to `@zilliz`, publishes). Do not push release tags from the fork unless
the workflow has been changed to target a fork-owned scope.
