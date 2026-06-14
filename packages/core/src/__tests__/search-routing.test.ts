// packages/core/src/__tests__/search-routing.test.ts
import { Context } from '../context';

function fakeEmbedding(provider: string, dim: number): any {
    return {
        getProvider: () => provider, getDimension: () => dim,
        embed: async (_t: string) => ({ vector: new Array(dim).fill(0.1), dimension: dim }),
        embedBatch: async (ts: string[]) => ts.map(() => ({ vector: new Array(dim).fill(0.1), dimension: dim })),
        detectDimension: async () => dim,
    };
}

function spyDb() {
    const hybridCalls: string[] = [];   // collection names passed to hybridSearch
    const searchCalls: string[] = [];   // collection names passed to search
    const db: any = {
        hasCollection: async (_c: string) => true,
        query: async () => [{ id: 'x' }],                 // makes the "has data" probe pass
        hybridSearch: async (collection: string) => { hybridCalls.push(collection); return []; },
        search: async (collection: string) => { searchCalls.push(collection); return []; },
    };
    return { db, hybridCalls, searchCalls };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
    return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } });
}

const CB = process.cwd(); // any existing dir; envManager.runWithProject reads .env from it

describe('search routing (M4 + M5)', () => {
    it('8B default: searches private + shared (hybrid), embeds via primary', async () => {
        const { db, hybridCalls } = spyDb();
        await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: undefined, SEARCH_EMBEDDING_MODEL: undefined }, async () => {
            const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), vectorDatabase: db });
            await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined /* default model = 8B */);
            // Primary collection + shared collection both searched.
            expect(hybridCalls).toEqual(['claude_context_own', 'dev_infra_shared']);
        });
    });

    it('0.6B: searches ONLY the _0p6b private collection — ZERO shared ANN calls (M5)', async () => {
        const { db, hybridCalls } = spyDb();
        const secondary = fakeEmbedding('secondary-0.6b', 1024);
        const embedSpy = jest.spyOn(secondary, 'embed');
        await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: 'claude_context_own_0p6b', SEARCH_EMBEDDING_MODEL: undefined }, async () => {
            const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), secondaryEmbedding: secondary, vectorDatabase: db });
            // Force the coverage gate OPEN for this routing test (P4 gate tested separately).
            jest.spyOn(ctx as any, 'isCoverageSufficientForModel').mockReturnValue(true);
            await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
            expect(hybridCalls).toEqual(['claude_context_own_0p6b']);  // NO shared collection
            expect(hybridCalls).not.toContain('dev_infra_shared');
            expect(embedSpy).toHaveBeenCalledTimes(1);                  // query embedded via the 0.6B instance
        });
    });

    it('0.6B requested but NOT configured: returns [] (clear notice), never a wrong-dim ANN call (D7)', async () => {
        const { db, hybridCalls, searchCalls } = spyDb();
        await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: undefined, SEARCH_EMBEDDING_MODEL: undefined }, async () => {
            const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), vectorDatabase: db });
            const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
            expect(res).toEqual([]);
            expect(hybridCalls.length).toBe(0);   // never embedded/queried with the wrong instance
            expect(searchCalls.length).toBe(0);
        });
    });

    it('R-C5: no explicit arg + project-scope SEARCH_EMBEDDING_MODEL=0.6B resolves to the secondary (project-scope wins)', async () => {
        const { db, hybridCalls } = spyDb();
        const secondary = fakeEmbedding('secondary-0.6b', 1024);
        const embedSpy = jest.spyOn(secondary, 'embed');
        await withEnv({ HYBRID_MODE: 'true', MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared', MILVUS_COLLECTION_PRIVATE: 'claude_context_own', MILVUS_COLLECTION_PRIVATE_0P6B: 'claude_context_own_0p6b', SEARCH_EMBEDDING_MODEL: 'qwen3-embedding-0.6b' }, async () => {
            const ctx = new Context({ embedding: fakeEmbedding('primary-8b', 4096), secondaryEmbedding: secondary, vectorDatabase: db });
            jest.spyOn(ctx as any, 'isCoverageSufficientForModel').mockReturnValue(true);
            // No embeddingModel arg passed (handler would pass undefined under R-C5).
            await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, undefined);
            expect(hybridCalls).toEqual(['claude_context_own_0p6b']);  // resolved to 0.6B via env (project-scope)
            expect(embedSpy).toHaveBeenCalledTimes(1);
        });
    });
});
