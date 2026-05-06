# 2026-05-05 — DeepInfra Rogue Embedding Worker Incident

## TL;DR

A second consumer (`embedding-deepinfra` PM2 process on `192.168.0.12`) attached itself to the `inference / embedding.qwen3-8b` RabbitMQ queue alongside the legitimate Qwen3-Embedding-8B GPU worker on server `58:322`. Because RabbitMQ defaults to round-robin dispatch among consumers on the same queue, ~50% of all embedding requests during the 44-minute window went to a worker whose `EMBEDDING_OPENAI_URL` was unset, causing it to silently fall back to the **DeepInfra cloud service** with a *different* embedding model. The result: a different vector space was mixed into the same Milvus collections — semantically incompatible vectors stored under the same primary key namespace.

| Field | Value |
|---|---|
| Window start | 2026-05-05 09:17:33 UTC (PM2 `pm_uptime` confirmed by RMQ `connected_at` 09:17:33.138) |
| Window end | 2026-05-05 ~10:01 UTC (operator-stopped via `pm2 stop embedding-deepinfra`) |
| Duration | ~44 minutes |
| Rogue host | `192.168.0.12` |
| Rogue PM2 process | `embedding-deepinfra` (id 22, PID 3267832→3267976) |
| Rogue consumer tag | `mw-embedding-qwen3-embed-322-1313117` (note: misleadingly named with `-322`; tag inherited because `WORKER_NAME=None` fell back to the queue name string) |
| Tasks processed by rogue | 4063 (errors=0) |
| Affected pipeline | `claude-context` MCP code-search index → Milvus collections |
| Events ES (`events_current`) | **NOT affected** — verified 14,836 / 14,836 documents have valid `embedding` field; that pipeline runs through a different reply queue and was not the target of the rogue. |

## Root cause

1. **Misleading consumer tag.** Both the legitimate worker on `58:322` and the rogue worker on `192.168.0.12` register under the `mw-embedding-qwen3-embed-322-` prefix. The rogue worker's tag was identical-looking enough that surface-level `pm2 list` checks did not distinguish it. Only by cross-referencing PM2 `pm_uptime` against RMQ `connected_at` was the rogue host identified.
2. **Silent fallback in worker code.** `event-model-worker/src/worker.ts` checks `EMBEDDING_OPENAI_URL`; when unset and `DEEPINFRA_API_KEY` is present, the worker dispatches to DeepInfra cloud for embedding, *without* verifying that the configured model matches the queue's expected model (Qwen3-Embedding-8B Q8\_0). This was a known regression flagged in the `embedding_worker_openai_url_injection` memory entry (2026-05-01) but was not yet hardened.
3. **`pm2 resurrect` brought the rogue back.** The `embedding-deepinfra` PM2 process is meant to exist as an *emergency fallback only* and should have been removed from the persisted `~/.pm2/dump.pm2` after the 2026-04-21 Jina cutover. The dump was never cleaned up; a routine reboot of `192.168.0.12` (~09:11 UTC) re-instantiated all PM2 apps, including this one. `restart_time=0` in `pm2 jlist` confirms it was a fresh start, not a crash-restart.

## Detection

| Signal | Value |
|---|---|
| `consumer_count` on queue | 2 (expected 1) |
| `consumer_capacity` | 1.0 (saturated) |
| Operator confirmed via `gh-actions` style audit: `pm2 jlist` on `192.168.0.12` showed `embedding-deepinfra` `online`, `pm_uptime=1777943853279` (= 09:17 UTC), `restart_time=0`, `EMBEDDING_OPENAI_URL` absent. |

## Impact assessment

The rogue consumed `replyTo` queues belonging primarily to the `claude-context` MCP `RabbitMQEmbedding` publisher (Node.js v22.22.0). Round-robin → ~50% of chunks during window went to DeepInfra. Collections affected (in descending severity):

| Collection | Status during window | Estimated contamination | Recovery |
|---|---|---|---|
| `event_crawler_own` | Active indexing (in flight when rogue stopped) | ~50% of 1,402 rows written during window | **Drop + force re-index** |
| `event_shared` | event-crawler dual-writes accumulating | <0.5% of 402K rows (~1,500 contaminated) | Tolerated as residual; would require re-indexing all writers to fully clean |
| `poi_data_layer_own` | Periodic-sync re-embedding 710 changed chunks during 9 hr window, ~30 of those landed in 44-min rogue window | ~1.5% (~30 rows) | **Drop + force re-index** |
| `event_search_service_own` | Periodic-sync gained 43 rows over 9 hr, ~2 in window | ~0.01% (~2 rows) | **Drop + force re-index** (cheap) |
| Tier 1–3 own collections | Only contaminated if files in those repos were modified during the 44-min window | Repo-by-repo audit needed | **Defer**; spot-check via Phase D |

The Events ES `events_current` index was confirmed **not** contaminated — a separate publisher pipeline. The only pollution is in the `claude-context` Milvus collections.

## Recovery actions taken

Phase A — Tier 4 force re-index (executed serially after rogue stop):

1. `clear_index` on event-crawler, ESS, poi → snapshot entries removed.
2. `drop_collection` on `event_crawler_own`, `event_search_service_own`, `poi_data_layer_own`.
3. Sequential `index_codebase(force=true)` for: poi → ESS → event-crawler.
4. Drain monitored via `wait-drain-hourly.cjs`; verified `consumer_count == 1` (only `mw-embedding-qwen3-embed-322-` legitimate tag) before each new index call.

Phase B — `event_shared` deliberately **not** rebuilt. Rebuild cost (re-indexing all 13 event_platform writers) far exceeds the search-quality impact of <0.5% mismatched vectors. Future natural file changes will progressively overwrite contaminated rows via merkle-driven incremental sync.

Phase D — Tier 1–3 spot audit deferred; can be triggered if specific search-quality complaints arise.

## Prevention

Status as of 2026-05-06: **3 of 4 items implemented.**

1. **`x-single-active-consumer=true` on `inference / embedding.qwen3-8b`.** ⚠ **Deferred — cross-repo coordination required.**

   RabbitMQ 4.2.5 rejects `single-active-consumer` as a policy definition (validation: *"are not recognised policy settings"*). It must be set as a queue x-argument at declaration time. Setting it from this repo would require redeclaring the queue AND updating `LLM_QUEUE_OPTIONS` in `event-model-worker/src/rabbitmq.ts:13` — but `LLM_QUEUE_OPTIONS` is shared across embedding/reranker/llm queues, and rerankers intentionally use round-robin for load balancing across multiple host workers. A unilateral change would break reranker dispatch.

   The proper fix is a per-queue arguments override in `event-model-worker`. Tracked as a follow-up there.

   Reference command (when applied via queue x-argument):
   ```bash
   # From within the worker repo, after updating per-queue options:
   #   { 'x-single-active-consumer': true } added to embedding.qwen3-8b only
   # Worker assertQueue must match — otherwise PRECONDITION_FAILED on next connect.
   ```

2. **Decommission the `embedding-deepinfra` PM2 entry on `192.168.0.12`.** ✅ **Done 2026-05-06.**

   Verified via `ssh 192.168.0.12 'grep -l embedding-deepinfra ~/.pm2/dump.pm2'` → `NO_MATCH`. `pm2 jlist` on `192.168.0.12` shows no `WORKER_TYPE=embedding` process; only enrichment, reranker, and llm workers remain. Reboot will not resurrect the rogue.

3. **Worker-side guard.** ✅ **Done in `event-model-worker/src/worker.ts:196-270`.**

   `WORKER_TYPE=embedding` now requires `EMBEDDING_BACKEND` to be set explicitly to one of `['llamacpp', 'deepinfra', 'ollama']`. The `deepinfra` backend additionally requires a second-key gate `EMBEDDING_DEEPINFRA_ALLOW=1` (worker.ts:245-258). Implicit fallback chain (`openaiUrl > deepinfraApiKey > ollama`) was removed in this commit. Worker-name validation (worker.ts:132-153) requires every embedding/reranker process to declare its host suffix (`-012`, `-322`, etc.), preventing the misleading consumer-tag inheritance that masked the rogue's location.

4. **Consumer tag sanity check.** ⚠ **Partial — host-suffix invariant covers the known regression class.**

   The worker.ts:132-153 invariant (item 3) means a future regression cannot accidentally inherit the wrong host name. A full mgmt-API startup probe (query `/api/queues/<vhost>/<queue>/consumers` and abort on duplicate-prefix detection) is not yet implemented; deferred as defense-in-depth, lower priority once item 3 is in place.

5. **`claude-context` indexer fail-loud on consecutive batch failures.** ✅ **Done in this repo, `packages/core/src/context.ts:865-1000` (commit pending).**

   The original incident showed a secondary failure mode: when the rogue caused dimension-mismatched inserts to fail, the indexer's `try/catch` at `processFileList` silently absorbed every batch failure, letting a zombie indexer continue firing ~50K embeddings after its target collection was already dropped. The patch:

   - Tracks `consecutiveBatchErrors` across batches; resets on success.
   - After `INDEX_MAX_CONSECUTIVE_ERRORS` consecutive failures (default 3, env-overridable), throws to abort the run.
   - Final-batch failure now always re-throws — silent absorption would leave the snapshot reporting `completed` while the last batch's chunks were lost.
   - The thrown error propagates to `handlers.ts startBackgroundIndexing` which already records `indexfailed` status with the error message in the snapshot — visible to the operator on next status check.

## References

- Memory: `embedding_worker_openai_url_injection` (2026-05-01) — known silent-fallback risk, prior warning.
- `event-model-worker/src/worker.ts:43-50` — worker-type branching.
- `event-model-worker/src/worker.ts:155-200` — Ollama / OpenAI / DeepInfra dispatch logic.
- CLAUDE.md (this repo) — embedding provider matrix, dimension lock-in note.
- `mcp-services/docs/claude-context/env-variable-reference.md` — RabbitMQ provider section.
