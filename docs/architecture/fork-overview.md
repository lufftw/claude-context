# Fork Architecture Overview

`lufftw/claude-context` is a fork of
[`zilliztech/claude-context`](https://github.com/zilliztech/claude-context), currently level with
upstream 0.1.15 (`0.1.15-lufftw.1`). It runs Claude Context as shared infrastructure: one Milvus
instance and one self-hosted embedding fleet serve several repositories, machines and concurrent MCP
processes. This page summarises what the fork changes and why. Each section links to the detailed
design record.

## Component view

```
 MCP client (Claude Code, …)
        │ stdio
        ▼
 packages/mcp ── handlers ── envManager.runWithProject(<codebase>)   ◄── <codebase>/.env
        │            │                                                  process.env
        │            └── snapshot (CLAUDE_CONTEXT_HOME, file lock)      ~/.context/.env
        ▼
 packages/core Context
        ├── Embedding: OpenAI | VoyageAI | Gemini | Ollama | OpenRouter | RabbitMQ (fork)
        │                 primary (e.g. qwen3-embedding-8b, 4096-d)
        │                 secondary (optional, e.g. qwen3-embedding-0.6b, 1024-d)
        ├── Splitter: AST (tree-sitter) | LangChain
        └── VectorDatabase: Milvus gRPC | REST  (+ autoload deny policy)
                 ├── <private>          primary model, this codebase
                 ├── <private>_0p6b     secondary model, this codebase
                 └── <shared>           cross-project knowledge (read; optional write)
```

## What the fork adds

| Area | Upstream | Fork | Record |
|---|---|---|---|
| Collection naming | Hash of the codebase path | Named private collection, optional shared collection merged into search, optional dual-write to the shared collection | [private-shared-collections](../lufftw/private-shared-collections.md) |
| Configuration scope | `process.env`, `~/.context/.env` | Project `.env` first, scoped per call with `AsyncLocalStorage` so concurrent projects never see each other's settings | [project-env-loading](../lufftw/project-env-loading.md), [envmanager concurrency fix](../lufftw/bugfix-2026-05-04-envmanager-concurrency.md) |
| Embedding transport | HTTP providers | RabbitMQ RPC to a GPU worker fleet, with priorities, retries and worker-health safeguards | [rabbitmq-embedding-provider](../lufftw/rabbitmq-embedding-provider.md), [rogue-worker fix](../lufftw/bugfix-2026-05-05-deepinfra-rogue-worker.md) |
| Failure handling | Any embedding error aborts | Partial-tolerant batches, abort after `INDEX_MAX_CONSECUTIVE_ERRORS` in a row, per-file resume ledger; an empty primary index still raises `EmbeddingError` | [cpu-tolerant-embedding](../lufftw/design-2026-06-06-cpu-tolerant-embedding.md) |
| Models | One model per index | Optional secondary model in its own collection, coverage-gated before it becomes searchable | [dual-embedding](../lufftw/design-2026-06-14-dual-embedding.md) |
| Snapshot | Single-process writer | `proper-lockfile` read-merge-write with atomic rename; shared `CLAUDE_CONTEXT_HOME`; interrupted entries preserved for peers and resume | [snapshot race fix](../lufftw/bugfix-2026-03-08-snapshot-race-condition.md) |
| Cloud sync | Re-adds codebases found only in Milvus | Does not, because the Milvus instance is shared across machines | [upstream merge record](../lufftw/upstream-merge-2026-11-04.md) |
| Milvus memory | Collections loaded on demand | `MILVUS_AUTOLOAD_DENY` refuses implicit loads of released collections | [configuration reference](../reference/fork-configuration.md) |
| Sync performance | Re-hashes every file | Skips unchanged files by `stat`; compiles ignore globs once | commit `7b24ca1` |
| Supply-chain hygiene | — | Secret scanner in CI, pre-commit hook and history audit | [credential-handling](../security/credential-handling.md) |

## Invariants

Changes to the fork, including upstream merges, must preserve these:

1. **No cross-project leakage.** Every `envManager.get` during a request resolves against that
   request's codebase. Never read collection or model settings from a module-level cache.
2. **One vector space per query.** A query vector is only searched against collections built with
   the same model and dimension. The shared collection belongs to the primary model.
3. **No silent partial results.** A secondary collection below the coverage threshold is reported as
   degraded, not searched. A run that stored nothing for the primary model fails.
4. **No lost peer state.** Snapshot writes merge field by field under a lock; a process never
   rewrites another process's `indexing` entry.
5. **Idempotent writes.** Chunks are written with `upsert` on deterministic primary keys, so resumes
   and dual writes never create duplicates.
6. **Credentials only from the environment.** See
   [credential-handling](../security/credential-handling.md).

## Upstream relationship

The fork merges `upstream/master` with `git merge` and records every reconciliation. The process,
conflict hotspots and verification steps are in the
[upstream synchronisation runbook](../maintenance/upstream-sync.md).
