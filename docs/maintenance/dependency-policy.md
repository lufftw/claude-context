# Dependency Policy and Version Matrix

How the `lufftw/claude-context` fork chooses dependency versions. The table records the last
review (`0.1.15-lufftw.2`, 2026-11-04).

## Principles

1. **Stay mergeable with upstream.** `zilliztech/claude-context` is merged regularly
   ([upstream sync](upstream-sync.md)). Avoid migrations that rewrite large parts of upstream
   code (new SDK major versions with API changes) until upstream makes them, unless a fork
   feature requires it.
2. **Client SDKs follow the server.** The Milvus SDK minor line must match the deployed Milvus
   server line (2.5.x today). A 3.x SDK requires a Milvus 3 server.
3. **Evidence before merge:** `pnpm build`, the core (Jest) and mcp (node:test) suites,
   `pnpm check:secrets`, and the CI matrix (Ubuntu and Windows, Node 20/22/24).

## Version matrix

| Package | Range | Locked | Latest seen | Decision |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | `^1.32.2` | 1.32.2 | 1.32.2 (v1), 2.4.0 (v2) | **Adopted 1.32.2**: maintained v1 line, MCP spec up to 2025-11-25. **v2 deferred**: it targets MCP 2026-07-28 but splits the package (`@modelcontextprotocol/server`/`client`/`core`), removes `.tool()`, and needs zod 4. Upstream is still on v1. Revisit when upstream migrates or before v1 maintenance ends (not before 2027-01) |
| `@zilliz/milvus2-sdk-node` | `~2.5.13` | 2.5.13 | 3.0.6 | **2.5 patch adopted; 3.x deferred.** The 3.x line pairs with Milvus 3.0 and enables client telemetry by default (3.0.5). Kept on the 2.5 line to match the server |
| `amqplib` | `^2.2.1` | 2.2.1 | 2.2.1 | **Adopted.** Ships its own types (`@types/amqplib` removed). Exposed the ignored-heartbeat bug ([record](../lufftw/bugfix-2026-11-04-amqp-heartbeat.md)) |
| `@google/genai` | `^2.32.0` | 2.32.0 | 2.32.0 | **Adopted.** 2.0 breaking changes are limited to the Interactions API; `models.embedContent` unchanged (Gemini tests pass) |
| `ignore`, `fs-extra` | patch/minor | 7.0.14, 11.4.1 | — | Adopted |
| `zod` | `^3.25.76` + override | 3.25.76 | 4.x | Override forces ≥ 3.25.76: 3.25.55's bundled `v4` typings fail `tsc` without `skipLibCheck` once genai 2 types are in the graph. zod 4 comes with the SDK v2 migration |
| `jest`, `ts-jest`, `tsx` (dev) | minor | 30.5.2, 29.4.15, 4.23.15 | — | Adopted |
| ESLint 10, `@types/node` 26, webpack plugins, `@vscode/vsce` 4 (dev) | — | unchanged | — | Deferred: tooling majors with no runtime benefit, and conflicts in upstream merges |

## SDK v2 migration plan (when triggered)

1. Run `npx @modelcontextprotocol/codemod v1-to-v2` on `packages/mcp`.
2. Replace the imports with `@modelcontextprotocol/server` and `@modelcontextprotocol/server/stdio`,
   then move zod to ^4.2.
3. Re-run the handlers tests and a stdio round-trip (initialize/discover, `tools/list`,
   `tools/call`) with both a 2025-11-25 and a 2026-07-28 client.
4. Record the change in the upstream-merge notes, because it will conflict with every upstream
   change to `packages/mcp/src/index.ts`.

## Review procedure

```bash
pnpm outdated -r
```

Classify each entry as adopt, adopt-with-changes or defer. Upgrade on a branch, run the evidence
listed under Principles, and update this table.
