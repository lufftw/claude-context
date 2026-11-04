# Fork Configuration Reference

Environment variables added by the `lufftw` fork, on top of the upstream variables documented in
[Environment Variables](../getting-started/environment-variables.md). All of them are optional;
with none set, the fork behaves like upstream Claude Context.

Variables marked 🔒 are credentials. Supply them only through the environment and never commit them
(see [Credential Handling](../security/credential-handling.md)).

## Resolution order

Every variable read through `envManager` resolves in this order (first match wins):

1. The `.env` file at the root of the codebase being indexed or searched (scoped per call with
   `AsyncLocalStorage`, so concurrent requests for different projects do not interfere).
2. `process.env` — the MCP client's `env` block and the OS environment.
3. `~/.context/.env`.

Details: [Project-scoped `.env` loading](../lufftw/project-env-loading.md).

Exceptions: `CLAUDE_CONTEXT_HOME` and `MILVUS_COLLECTION_LIMIT_CHECK_TIMEOUT_MS` are read from
`process.env` only.

## Collections and sharing

| Variable | Default | Description |
|---|---|---|
| `MILVUS_COLLECTION_PRIVATE` | upstream hash name | Fixed name for the codebase's own collection (e.g. `event_crawler_own`). Takes precedence over `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE`. |
| `MILVUS_COLLECTION_SHARED` | — | Collection searched alongside the private one; results are merged by score and de-duplicated. |
| `MILVUS_STRATEGY` | — | `private` disables the shared collection for search even when `MILVUS_COLLECTION_SHARED` is set. |
| `MILVUS_WRITABLE_SHARED` | — | When set, indexing also writes the same chunks (same embeddings, no extra cost) to this collection. |
| `MILVUS_AUTOLOAD_DENY` | — | Comma/space-separated collection names, with leading or trailing `*` wildcards, that may not be loaded *implicitly* by `ensureLoaded` (gRPC and REST). Use it to keep a deliberately released large collection out of Milvus memory. |
| `CLAUDE_CONTEXT_HOME` | `~/.context` | Directory holding `mcp-codebase-snapshot.json`. Point several users or processes at one directory to share index state; writes are serialised with `proper-lockfile`. |

Background: [Private + shared collections](../lufftw/private-shared-collections.md).

## Embedding: RabbitMQ provider

Set `EMBEDDING_PROVIDER=RabbitMQ` to send embedding requests to a self-hosted worker fleet over AMQP
RPC.

| Variable | Default | Description |
|---|---|---|
| 🔒 `RABBITMQ_INFERENCE_URL` | — (required) | Full AMQP URL with credentials and vhost, `amqp://<user>:<password>@<host>:5672/<vhost>`. |
| `RABBITMQ_EMBEDDING_QUEUE` | `embedding.qwen3-8b` | Work queue of the primary model. |
| `EMBEDDING_MODEL` | `qwen3-embedding-8b` | Logical model id sent in each task. |
| `RABBITMQ_EMBEDDING_DIMENSION` | `4096` | Vector dimension of the primary model. |
| `RABBITMQ_EMBEDDING_TIMEOUT_MS` | `30000` | Per-RPC timeout. Keep `timeout × (retries + 1)` below the broker's consumer timeout. |
| `RABBITMQ_EMBEDDING_MAX_RETRIES` | `3` | Retries per RPC. |
| `RABBITMQ_EMBEDDING_PRIORITY` | `5` | Message priority, 0–10. |
| `RABBITMQ_EMBEDDING_CONCURRENCY` | `10` | Parallel RPCs per `embedBatch`. |
| `RABBITMQ_EMBEDDING_SOURCE` | `claude-context` | `source` field written to each task, for attribution on the worker side. |

Background: [RabbitMQ embedding provider](../lufftw/rabbitmq-embedding-provider.md).

## Embedding: dual model (secondary collection)

A secondary, smaller model can be indexed into its own collection so that search keeps working
while the primary model's GPU is busy. It is activated only when **all** of the following hold:
`MILVUS_COLLECTION_PRIVATE_0P6B` is set, `EMBEDDING_PROVIDER=RabbitMQ`, and `RABBITMQ_INFERENCE_URL`
is set.

| Variable | Default | Description |
|---|---|---|
| `MILVUS_COLLECTION_PRIVATE_0P6B` | — | Activation switch and name of the secondary collection. |
| `RABBITMQ_SECONDARY_MODEL` | `qwen3-embedding-0.6b` | Must be a canonical id from `core/src/embedding/model-registry.ts`; anything else disables the secondary. |
| `RABBITMQ_SECONDARY_QUEUE` | `embedding.qwen3-0.6b` | Work queue of the secondary model. |
| `RABBITMQ_SECONDARY_DIMENSION` | `1024` | Vector dimension of the secondary model. |
| `SEARCH_EMBEDDING_MODEL` | `qwen3-embedding-8b` | Default model for `search_code`; the per-call `embeddingModel` argument overrides it. One model per query; private + shared merging applies to the primary only. |
| `COVERAGE_READABLE_THRESHOLD` | `0.85` | Minimum distinct-primary-key overlap between the secondary and primary collections before the secondary is searchable. Below it, or when unknown, search reports a degraded state instead of returning results from an incomplete backfill. |

Background: [Dual-embedding design](../lufftw/design-2026-06-14-dual-embedding.md).

## Indexing resilience

| Variable | Default | Description |
|---|---|---|
| `INDEX_MAX_CONSECUTIVE_ERRORS` | `3` | Consecutive failed embedding batches that abort an indexing run. A successful batch resets the counter, so isolated transient errors are tolerated. |

Interrupted runs keep their snapshot entry in the `indexing` state, together with the per-file
resume ledger, so a restart resumes rather than re-embedding everything. Background:
[CPU-tolerant embedding](../lufftw/design-2026-06-06-cpu-tolerant-embedding.md).

## Example: project `.env`

```dotenv
# <repo>/.env — git-ignored. Identity of this project; credentials may live here or in the MCP env block.
MILVUS_COLLECTION_PRIVATE=my_service_own
MILVUS_COLLECTION_SHARED=team_shared
MILVUS_STRATEGY=hybrid
SEARCH_EMBEDDING_MODEL=qwen3-embedding-8b
```

```dotenv
# ~/.context/.env — user-global fallback. Never inside a repository.
EMBEDDING_PROVIDER=RabbitMQ
RABBITMQ_INFERENCE_URL=amqp://<user>:<password>@<host>:5672/inference
MILVUS_ADDRESS=<host>:19530
MILVUS_TOKEN=<user>:<password>
```
