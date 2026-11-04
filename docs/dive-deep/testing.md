# Testing Guide

## Test Suites

| Suite | Command | Needs | What it covers |
|---|---|---|---|
| Core unit tests | `pnpm --filter @zilliz/claude-context-core test` | Nothing | Indexing pipeline, partial-failure handling, resume ledger, per-model targets, search routing and de-duplication, ignore rules, abort, synchronizer, embedding providers (mocked), Milvus adapters |
| Core integration tests | `pnpm --filter @zilliz/claude-context-core test:int` | Nothing; set `MILVUS_LIVE=1` and `MILVUS_ADDRESS` to include the live Milvus suite | Multi-target indexing, resume and delete-on-change through `Context` (`*.int.test.ts`); with `MILVUS_LIVE=1`, upsert idempotency against a real Milvus |
| MCP unit tests | `pnpm --filter @zilliz/claude-context-mcp test` | Nothing | Configuration, snapshot request options, status handler |
| MCP offline integration checks | `node packages/mcp/scripts/<name>` | A build | `snapshot-ledger.test.mjs`, `snapshot-additive-roundtrip.test.mjs`, `dual-config-smoke.mjs`, `snapshot-coverage.test.mjs`, `search-model-routing.test.mjs`, `search-degraded-callgate.test.mjs`, `sync-lock-e2e.mjs` |
| MCP stdio smoke | `node packages/mcp/scripts/jsonrpc-smoke.mjs` | A build; `CLAUDE_CONTEXT_HOME` set to a temporary directory | Starts the server, checks `initialize`, `tools/list` and that stdout carries only JSON-RPC |
| Live end-to-end | `node packages/mcp/scripts/e2e-live.mjs` | A build; Milvus 2.5+ (`MILVUS_ADDRESS`) | See below |
| Secret scan | `pnpm check:secrets` | Nothing | Committed credentials |

Build first with `pnpm build` (or `pnpm build:core && pnpm build:mcp`). The MCP checks run the compiled `dist/` output.

## Live End-to-End Test

`packages/mcp/scripts/e2e-live.mjs` starts the built MCP server over stdio with the MCP SDK client, against a real Milvus, and checks:

1. The server lists `index_codebase`, `search_code`, `get_indexing_status` and `clear_index`.
2. A temporary project is indexed and reported as fully indexed.
3. The project's `.env` decides the collection name (`MILVUS_COLLECTION_PRIVATE`).
4. Searches rank the expected file first.
5. `.gitignore` negation (`!path`) re-includes a file; ignored files are absent.
6. `.contextinclude` indexes a listed dot-directory; the `.env` file itself is never indexed.
7. Searching a subdirectory resolves to the indexed root.
8. Touching the trigger file re-indexes a newly added file.
9. `clear_index` removes the index and drops the collection.

Embeddings come from an in-process OpenAI-compatible stub with deterministic bag-of-words vectors, so the test needs no API key or GPU and its rankings are reproducible. With `RABBITMQ_INFERENCE_URL` set, the server instead uses `EMBEDDING_PROVIDER=RabbitMQ` with 4096-dimension vectors against a temporary queue served by an in-process stub worker that speaks the provider's task/reply protocol, and the test additionally asserts that requests went through the broker.

The test isolates itself: a temporary home directory (`HOME` and `USERPROFILE`), a random collection name and queue name, and cleanup of both at the end. It does not read or change `~/.context`.

## Continuous Integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

- `lint_and_build`, on Ubuntu 24.04 and Windows Server 2025 with Node 20, 22 and 24: secret scan, build, core and MCP unit tests, the offline integration checks and the stdio smoke.
- `e2e_live`, on Ubuntu 24.04 with Node 22: starts Milvus 2.5 and RabbitMQ 3.13 containers, runs the core integration tests with `MILVUS_LIVE=1`, and runs `e2e-live.mjs` in both embedding modes.

See [Platform Support](../getting-started/platform-support.md) for what is verified on which operating system.

## Writing Tests

- Tests that touch the state directory must redirect **both** `HOME` and `USERPROFILE`; `os.homedir()` reads `USERPROFILE` on Windows.
- Use `path.join` and compare paths after normalizing separators; result paths use `\` on Windows.
- Core tests use Jest (`src/**/*.test.ts`, `src/**/__tests__/**`); MCP unit tests use `node:test` with `tsx` (`src/**/*.test.ts`, discovered by `scripts/run-unit-tests.mjs`, which also works on Node 20).
- Never put real credentials in tests; use placeholders such as `sk-dummy-…`. The secret scan runs in CI.
