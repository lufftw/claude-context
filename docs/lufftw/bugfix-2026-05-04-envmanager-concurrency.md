# Bugfix: EnvManager Global-State Concurrency Bug

**Date**: 2026-05-04
**Version**: 0.1.4-lufftw.3
**Affected files**:
- `packages/core/src/utils/env-manager.ts`
- `packages/core/src/context.ts`

---

## Symptom

Running `index_codebase()` against multiple repos in parallel from the same MCP process produced **cross-collection contamination**: a sample of 30 entries from `poi_data_layer_crawler_worker_own` (which should hold only that repo's chunks) yielded:

| Source repo            | Sample count | Expected |
|------------------------|--------------|----------|
| poi-data-layer-crawler-worker | 20 | 30 |
| harness-research       | 8            | 0        |
| dev-machine-setup      | 2            | 0        |

Sibling collections (`dev_machine_setup_own`, `harness_research_own`, `finetune_datasets_own`, `event_chat_repo_own`) were left **empty** despite the snapshot reporting 27, 508, 20, 317 chunks respectively. `agent_shared` (the dual-write target for harness-research and finetune-datasets) likewise had zero rows.

## Root cause

`EnvManager` is a singleton with `projectEnvPath` as instance-level mutable state. `Context.indexCodebase()` mutated it imperatively at the start of each call:

```ts
async indexCodebase(codebasePath: string, ...) {
    envManager.setProjectPath(codebasePath);  // mutates singleton
    ...
    await this.prepareCollection(codebasePath, forceReindex);  // reads MILVUS_COLLECTION_PRIVATE
    ...
    // many awaits — every await hands the event loop back, allowing a
    // sibling indexCodebase() to overwrite projectEnvPath
}
```

When several `indexCodebase()` invocations were in flight, each `setProjectPath` call clobbered the previous one. By the time chunk inserts happened, `envManager.get('MILVUS_COLLECTION_PRIVATE')` returned **whichever path was set last**, and all five concurrent indexings wrote into that one collection.

The same pattern existed in `semanticSearch`, `hasIndex`, `clearIndex`, and `reindexByChange`.

## Fix

Replace the mutable global with an `AsyncLocalStorage`-scoped context:

```ts
// env-manager.ts
import { AsyncLocalStorage } from 'async_hooks';

interface ProjectContext {
    projectEnvPath: string | undefined;
    cache: Map<string, string> | undefined;
}

export class EnvManager {
    private als = new AsyncLocalStorage<ProjectContext>();

    async runWithProject<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
        const envFile = path.join(path.resolve(projectPath), '.env');
        const ctx: ProjectContext = {
            projectEnvPath: fs.existsSync(envFile) ? envFile : undefined,
            cache: undefined,
        };
        return this.als.run(ctx, fn);
    }

    get(name: string): string | undefined {
        const alsCtx = this.als.getStore();
        if (alsCtx?.projectEnvPath) {
            if (!alsCtx.cache) alsCtx.cache = this.parseEnvFile(alsCtx.projectEnvPath);
            const v = alsCtx.cache.get(name);
            if (v !== undefined) return v;
        }
        // fall through to legacy global, then process.env, then ~/.context/.env
        ...
    }
}
```

`AsyncLocalStorage` propagates the project context through every `await` chain Node 16+ supports, so concurrent `runWithProject(repoA, ...)` and `runWithProject(repoB, ...)` calls each see their own `projectEnvPath` and never observe the other's.

`Context` switched all five entry points (`indexCodebase`, `reindexByChange`, `semanticSearch`, `hasIndex`, `clearIndex`) to wrap their work in `envManager.runWithProject(codebasePath, () => ...)`. The legacy `setProjectPath()` is retained for backwards compatibility with any caller that hasn't migrated, but new code MUST use `runWithProject`.

## Backward compatibility

- `setProjectPath` / `clearProjectPath` / `getProjectEnvPath` still work for non-async callers and sequential workflows.
- The resolution order in `get()` consults the ALS context first, then falls back to the legacy global path, then to `process.env`, then to `~/.context/.env`. So a caller using only `setProjectPath` continues to work as before.

## Verification

A repeat of the original failing scenario (5 parallel `index_codebase` calls, each to a different repo, on a fresh build) now produces the correct distribution: each `*_own` collection contains content **only** from its corresponding repo, and `agent_shared` (dual-write target) accumulates entries from both `harness-research` and `finetune-datasets`. See the 2026-05-04 incident summary in the developer's working notes for the contamination data table that originally surfaced the bug.

## Lessons

1. **Singleton-with-mutable-state is async-unsafe by default.** A "set X, then await stuff that reads X" pattern works only in a strictly serial caller. The first concurrent caller of the same code path will silently corrupt routing.
2. **AsyncLocalStorage is the right tool when you cannot rethread state through a deep call chain.** Threading `projectPath` through every method that reads `MILVUS_COLLECTION_*` would have meant changing dozens of signatures in `Context`, `MilvusVectorDatabase`, `MilvusRestfulVectorDatabase`, etc. ALS scopes the value invisibly without touching any of those.
3. **The bug was undetectable in single-process tests.** Like the snapshot lock regression on 2026-03-08, this one only surfaces with concurrent callers. The repo now has a single-process smoke test (`scripts/diagnostics/smoke-test-mcp.sh`) and a snapshot-lock E2E (`scripts/diagnostics/test-snapshot-fix.sh`), but **no concurrent-indexing test**. Adding one is filed as future work.
