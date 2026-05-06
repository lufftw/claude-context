# RabbitMQ Embedding Provider

**Added**: v0.1.4-lufftw.2
**File**: `packages/core/src/embedding/rabbitmq-embedding.ts`
**Factory**: `packages/mcp/src/embedding.ts` (case `'RabbitMQ'`)

## What it does

Routes embedding requests through RabbitMQ RPC instead of calling an HTTP embedding API directly. This lets claude-context share a GPU-hosted embedding worker pool with other services (event-crawler, event-search-service) that already consume the same `inference` vhost.

The provider speaks the same protocol as `event-search-service/backend/src/services/inference-queue/embeddingService.ts` — request goes to a per-model work queue, response comes back via an exclusive auto-delete reply queue with `correlationId` matching.

## Request shape

Published to `embedding.qwen3-8b` (or whatever queue is configured):

```json
{
  "id": "<uuid>",
  "type": "embedding",
  "model": "qwen3-embedding-8b",
  "createdAt": 1712838391000,
  "traceId": "claude-context-1712838391000-a1b2c3d4",
  "source": "claude-context",
  "priority": 8,
  "replyTo": "amq.gen-...",
  "correlationId": "<same uuid>",
  "prompt": "<text>",
  "retryCount": 0,
  "headers": {
    "x-retry-count": 0,
    "x-first-attempt-at": 1712838391000
  },
  "payload": {
    "texts": ["<text>"],
    "normalize": true,
    "truncate": "end"
  }
}
```

AMQP properties set on publish:

```
persistent: true
contentType: application/json
correlationId: <uuid>
replyTo: <exclusive reply queue>
messageId: <uuid>
priority: <configured priority>
```

Published to the **default exchange** (`""`), routed by queue name — matches the convention used by event-search-service and event-crawler so no custom binding is needed.

## Reply shape

The worker publishes back to the client's exclusive queue:

```json
{
  "taskId": "<matching uuid>",
  "success": true,
  "content": "[[0.0401, -0.0141, -0.0256, ...]]",
  "durationMs": 187
}
```

`content` is a JSON-stringified array of arrays (outer length 1 for a single-text request). The provider also accepts a legacy `{taskId, embeddings: [[...]]}` shape for backwards compatibility.

On failure the worker sends `{taskId, success: false, error: "..."}` and the provider rejects the pending `Promise`.

## Lifecycle

```
constructor()      // stores config, no I/O
   │
   ▼
embed() / embedBatch()
   │
   ▼
initialize()       // mutex-protected, idempotent
   │  ├─ amqplib.connect(url, {heartbeat})
   │  ├─ createConfirmChannel() → publishCh  (durable publish)
   │  ├─ createChannel() → replyCh           (consumer isolation)
   │  ├─ assertQueue('', {exclusive:true, autoDelete:true}) → replyQueue
   │  └─ replyCh.consume(replyQueue, routeByTaskId)
   │
   ▼
sendOne(text)       // one RPC per text
   │  ├─ Generate taskId (UUID v4)
   │  ├─ Register pending.set(taskId, {resolve, reject, timer})
   │  └─ publishCh.publish('', queue, body, {correlationId, replyTo})
   │
   ▼
routeByTaskId(msg)
   │  ├─ Parse {taskId, success, content}
   │  ├─ pending.delete(taskId), clearTimeout
   │  └─ resolve(vector) or reject(error)
   │
   ▼
close()            // explicit shutdown
   └─ Closes reply + publish channels, closes connection, resetState()
```

**Connection failure handling**: On any `channel.close` / `connection.close` event the provider calls `resetState(reason)` which immediately rejects all pending requests (callers fail fast instead of waiting for individual timeouts). The next `embed()` call will trigger a fresh `initialize()` — there is no automatic reconnect loop because the MCP server process is typically restarted by its supervisor when things go wrong.

## Concurrency

`embedBatch(texts)` uses a **bounded worker pool** pattern:

```ts
const workers = Math.min(this.config.concurrency, processed.length);
// N parallel consumers of a shared cursor
```

Default `concurrency = 10`. This caps how many RPCs are in flight at once. Raising it beyond the worker's configured `rateLimit` (20/s for qwen3-embedding-8b) will just queue requests — no throughput benefit.

## Configuration

| MCP env var | Field | Default | Notes |
|---|---|---|---|
| `EMBEDDING_PROVIDER=RabbitMQ` | — | — | Required switch |
| `RABBITMQ_INFERENCE_URL` | `url` | — | Full AMQP URL with vhost |
| `RABBITMQ_EMBEDDING_QUEUE` | `queue` | `embedding.qwen3-8b` | Target work queue |
| `EMBEDDING_MODEL` | `modelName` | `qwen3-embedding-8b` | Logical name in task body |
| `RABBITMQ_EMBEDDING_DIMENSION` | `dimension` | `4096` | Fixed by model |
| `RABBITMQ_EMBEDDING_TIMEOUT_MS` | `timeoutMs` | `30000` | Per-RPC timeout |
| `RABBITMQ_EMBEDDING_PRIORITY` | `priority` | `5` | 0-10 |
| `RABBITMQ_EMBEDDING_CONCURRENCY` | `concurrency` | `10` | `embedBatch` parallelism |
| `RABBITMQ_EMBEDDING_SOURCE` | `source` | `claude-context` | Task `source` field |

## Not included (and why)

- **No instruction prefix wrapping**. The `batchDispatcher.ts` in event-crawler passes the `prompt` straight to Ollama `/api/embed` with no preprocessing. claude-context matches that — both sides raw. Adding instruction prefixes would diverge from the rest of the platform and produce embeddings in a different space.
- **No Redis caching / rate limit / circuit breaker**. `EmbeddingService` in event-search-service implements all three because search is latency-critical and needs to protect itself from a flaky worker. claude-context's `index_codebase` is a batch job — it's fine to fail hard and retry. Keeping the provider minimal means fewer moving parts when debugging.
- **No auto-reconnect loop**. MCP servers are supervised by the host (Claude Code, etc.) and restart on crash. Building a reconnect loop inside the provider would mask real issues.
- **No dimension auto-detect**. `detectDimension()` returns the configured value without probing. The cost is that a typo in `RABBITMQ_EMBEDDING_DIMENSION` will only surface when Milvus rejects the insert — but probing would block `getDimension()` behind a network call which breaks claude-context's collection-creation flow.

## Testing

Two smoke tests are kept out of the repo (deleted after validation) — paste them back in if you need to re-verify:

1. **Raw protocol test** — pure `amqplib`, publishes a task directly to `embedding.qwen3-8b` and receives the reply. Validates the worker is alive, queue routing works, dimension is what you expect.

2. **Built-factory test** — imports from `packages/mcp/dist/embedding.js`, calls `createEmbeddingInstance({embeddingProvider: 'RabbitMQ', ...})`, exercises both `embed()` and `embedBatch()`. Validates the env-var plumbing, verifies batch results are distinct (no reply-queue cross-talk).

Both were confirmed passing on 2026-04-11 against the live `event-platform-rabbitmq` container with a Qwen3-Embedding-8B worker running on `server-58-322`. Single-text round-trip: ~2s cold, ~200ms warm. Batch of 8 with concurrency=5: ~2s total.
