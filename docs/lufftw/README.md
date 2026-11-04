# lufftw Fork of Claude Context

This repository is a fork of [zilliztech/claude-context](https://github.com/zilliztech/claude-context), currently based on upstream **0.1.15** and published as `0.1.15-lufftw.1`. It stays compatible with upstream configuration: with none of the variables below set, it behaves like upstream.

## What the Fork Adds

| Feature | What it does | Docs |
|---|---|---|
| **RabbitMQ embedding provider** | `EMBEDDING_PROVIDER=RabbitMQ` sends embedding requests over RPC to self-hosted GPU/CPU workers (e.g. Qwen3-Embedding-8B), with rejection of wrong-dimension replies | [rabbitmq-embedding-provider.md](rabbitmq-embedding-provider.md) |
| **Fault-tolerant indexing** | Per-chunk partial results, transient (WAIT) vs. hard (REAL) failure classes, abort after `INDEX_MAX_CONSECUTIVE_ERRORS`, idempotent `upsert` writes | [design-2026-06-06-cpu-tolerant-embedding.md](design-2026-06-06-cpu-tolerant-embedding.md) |
| **Resumable indexing** | A per-file completeness ledger in the snapshot lets an interrupted run skip files already fully stored | [design-2026-06-06-cpu-tolerant-embedding.md](design-2026-06-06-cpu-tolerant-embedding.md) |
| **Dual embedding** | Optional secondary model (Qwen3-Embedding-0.6B) in its own collection; `search_code` takes an `embeddingModel` argument and degrades explicitly when the secondary is not ready | [design-2026-06-14-dual-embedding.md](design-2026-06-14-dual-embedding.md) |
| **Private + shared collections** | Fixed collection names, a shared collection searched alongside the private one, optional dual-write into it | [private-shared-collections.md](private-shared-collections.md) |
| **Project-scoped `.env`** | Each codebase's own `.env` configures calls that target it, safely under parallel jobs | [project-env-loading.md](project-env-loading.md) |
| **Shared snapshot** | `CLAUDE_CONTEXT_HOME` lets several users or machines share one index snapshot; writes are file-locked and field-merged | [bugfix-2026-03-08-snapshot-race-condition.md](bugfix-2026-03-08-snapshot-race-condition.md) |
| **Collection auto-load guard** | `MILVUS_AUTOLOAD_DENY` keeps released large collections from being reloaded by searches | [environment variables](../getting-started/environment-variables.md#collections-and-shared-state) |
| **`.contextinclude`** | Index selected hidden directories such as `.github` | [file-inclusion-rules.md](../dive-deep/file-inclusion-rules.md#including-dot-directories-contextinclude-lufftw-fork) |
| **Credential scanning** | CI and a pre-commit hook block committed secrets | [security-credentials.md](security-credentials.md) |

Every variable is listed in [Environment Variables](../getting-started/environment-variables.md#-lufftw-fork-configuration).

## Example: RabbitMQ with a Shared Collection

Global settings in the MCP client's `env` block (or `~/.context/.env`), never in git:

```bash
EMBEDDING_PROVIDER=RabbitMQ
RABBITMQ_INFERENCE_URL=amqp://<user>:<password>@<host>:5672/inference
MILVUS_ADDRESS=<host>:19530
MILVUS_TOKEN=<user>:<password>
```

Per-project settings in `<codebase>/.env` (make sure `.env` is in that project's `.gitignore`):

```bash
MILVUS_COLLECTION_PRIVATE=my_project_own
MILVUS_COLLECTION_SHARED=dev_infra_shared
MILVUS_STRATEGY=hybrid
# Optional secondary model:
# MILVUS_COLLECTION_PRIVATE_0P6B=my_project_own_0p6b
```

## Differences from Upstream Behaviour

These upstream behaviours were intentionally not adopted (see [upstream-merge-2026-11-04.md](upstream-merge-2026-11-04.md)):

- An interrupted `indexing` entry stays `indexing` when the snapshot is reloaded (upstream marks it `indexfailed`), because it carries the resume ledger and may belong to a live peer process.
- Cloud sync does not add codebases that exist only in Milvus, because a shared Milvus holds other machines' codebases.
- `Context.indexCodebase(path, progress, onFileComplete, forceReindex, priorLedgersByModel, ignorePatterns, extensions, splitter, signal)` keeps the fork's parameter order; upstream's newer parameters follow it.

## Updating from Upstream

Merge (do not cherry-pick or squash) `upstream/master`, so later updates only bring new commits:

```bash
git remote add upstream https://github.com/zilliztech/claude-context.git
git fetch upstream master
git merge upstream/master
```

Record conflict decisions in a new `upstream-merge-<date>.md`, then run `pnpm build`, `pnpm --filter @zilliz/claude-context-core test`, `pnpm --filter @zilliz/claude-context-mcp test` and `pnpm check:secrets`.

## History

Bug reports and design notes: [bugfix-2026-03-08-indexing-failures.md](bugfix-2026-03-08-indexing-failures.md), [bugfix-2026-05-04-envmanager-concurrency.md](bugfix-2026-05-04-envmanager-concurrency.md), [bugfix-2026-05-05-deepinfra-rogue-worker.md](bugfix-2026-05-05-deepinfra-rogue-worker.md), [upstream-cherry-pick-log.md](upstream-cherry-pick-log.md) (superseded by the 2026-11-04 merge).
