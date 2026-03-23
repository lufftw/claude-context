# Project-Scoped `.env` Loading (EnvManager v2)

**Version**: v0.1.4-lufftw.2
**Date**: 2026-03-14
**Depends on**: [private-shared-collections.md](./private-shared-collections.md)

---

## Problem

In v0.1.4-lufftw.1, `EnvManager` resolved variables from two sources:

1. `process.env` (MCP `env` block in `~/.claude.json` or `.mcp.json`)
2. `~/.context/.env` (global fallback)

This meant project-scoped variables (`MILVUS_STRATEGY`, `MILVUS_COLLECTION_PRIVATE`, etc.) could only be set via the MCP env block — not from a project's `.env` file.  The [layered configuration architecture](../../../milvus-services/docs/claude-context/layered-configuration.md) documented a "project `.env`" layer, but the code never implemented it.

**Consequence**: Every project needed to either:
- Duplicate collection variables into `.mcp.json` (project-scope approach), or
- Set them in `~/.claude.json` (user-scope approach — all projects share the same collection config)

Neither approach supported true per-project `.env` resolution.

---

## Solution

### EnvManager Changes (`packages/core/src/utils/env-manager.ts`)

Added project path awareness to the singleton `envManager`:

```typescript
// New methods
envManager.setProjectPath(projectPath: string): void
envManager.clearProjectPath(): void
envManager.getProjectEnvPath(): string | undefined
```

**New resolution order** (highest priority wins):

```
1. Project .env file        ← NEW (set via setProjectPath)
2. process.env              (MCP env block + OS env)
3. ~/.context/.env          (global fallback)
```

**Implementation details**:
- `setProjectPath()` checks if `<projectPath>/.env` exists; if so, enables project-level resolution
- Project `.env` is parsed once into a `Map<string, string>` cache (invalidated when path changes)
- Comments (`#`) and blank lines are skipped during parsing
- If the project `.env` does not exist, resolution falls through to `process.env` as before (backward compatible)

### Context.ts Hook Points (`packages/core/src/context.ts`)

Added `envManager.setProjectPath(codebasePath)` at the entry of four public methods:

| Method | Purpose |
|--------|---------|
| `indexCodebase()` | Ensures correct collection names during indexing |
| `semanticSearch()` | Ensures correct collection routing during search |
| `clearIndex()` | Ensures correct collection is dropped |
| `hasIndex()` | Ensures correct collection is checked |

These are the four methods that receive a `codebasePath` parameter from MCP tool handlers (`index_codebase`, `search_code`, `clear_index`, `get_indexing_status`).

---

## How It Works

### Flow Diagram

```
MCP tool call: search_code({ path: "E:\repo\my-project", query: "..." })
    │
    ▼
context.semanticSearch("E:\repo\my-project", ...)
    │
    ├── envManager.setProjectPath("E:\repo\my-project")
    │       │
    │       └── Checks: E:\repo\my-project\.env exists?
    │               YES → parse and cache as Map
    │               NO  → project env disabled (fallback to process.env)
    │
    ├── getCollectionName()
    │       └── envManager.get("MILVUS_COLLECTION_PRIVATE")
    │           → checks project .env first → "my_project_own"
    │
    ├── getSharedCollectionName()
    │       └── envManager.get("MILVUS_STRATEGY") → "hybrid"
    │           envManager.get("MILVUS_COLLECTION_SHARED") → "event_shared"
    │
    └── searches: my_project_own + event_shared
```

### Cross-Project Search

When switching between projects in the same MCP session, `setProjectPath()` automatically loads the correct `.env`:

```
search_code({ path: "E:\repo\event-crawler", query: "..." })
    → loads E:\repo\event-crawler\.env
    → MILVUS_COLLECTION_PRIVATE=event_crawler_own
    → searches: event_crawler_own + event_shared

search_code({ path: "E:\repo\event-search-service", query: "..." })
    → loads E:\repo\event-search-service\.env
    → MILVUS_COLLECTION_PRIVATE=event_search_service_own
    → searches: event_search_service_own + event_shared
```

---

## Backward Compatibility

| Configuration Method | Before (v0.1.4-lufftw.1) | After (v0.1.4-lufftw.2) |
|---------------------|--------------------------|-------------------------|
| `.mcp.json` with env block | Works | Works (process.env, priority 2) |
| `~/.claude.json` with env block | Works | Works (process.env, priority 2) |
| Project `.env` file | **Not loaded** | Loaded (priority 1) |
| `~/.context/.env` | Works | Works (priority 3) |

No breaking changes. Existing `.mcp.json` configurations continue to work. Project `.env` takes priority only when it exists and contains the requested variable.

---

## Changed Files

| File | Change |
|------|--------|
| `packages/core/src/utils/env-manager.ts` | Added `setProjectPath()`, `clearProjectPath()`, `getProjectEnvPath()`. Changed `get()` to check project `.env` first. Added `parseEnvFile()` with caching. Extracted `getFromFile()` helper. |
| `packages/core/src/context.ts` | Added `envManager.setProjectPath(codebasePath)` to `indexCodebase()`, `semanticSearch()`, `clearIndex()`, `hasIndex()`. |

---

## Related Documentation

- [private-shared-collections.md](./private-shared-collections.md) — Multi-collection support (v0.1.3-lufftw.1)
- `milvus-services/docs/claude-context/layered-configuration.md` — Architecture spec this implements
- `milvus-services/docs/claude-context/env-variable-reference.md` — Variable reference
