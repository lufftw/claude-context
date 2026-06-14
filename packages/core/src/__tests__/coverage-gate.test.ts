// packages/core/src/__tests__/coverage-gate.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
    return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: new Array(dim).fill(0.1), dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}
function db() { const calls: string[] = []; return { calls, db: { hasCollection: async () => true, query: async () => [{ id: 'x' }], hybridSearch: async (c: string) => { calls.push(c); return []; }, search: async (c: string) => { calls.push(c); return []; } } }; }
const CB = process.cwd();

describe('coverage gate (P4)', () => {
    it('secondary BELOW threshold → degraded: returns [], no ANN call', async () => {
        process.env.HYBRID_MODE = 'true';
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        const { calls, db: vdb } = db();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.50 /* < 0.85 */ });
        const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
        expect(res).toEqual([]);
        expect(calls.length).toBe(0);
        delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE;
    });

    it('secondary AT/ABOVE threshold → normal: issues the ANN call on the _0p6b collection', async () => {
        process.env.HYBRID_MODE = 'true';
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        const { calls, db: vdb } = db();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.90 /* >= 0.85 */ });
        await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
        expect(calls).toEqual(['claude_context_own_0p6b']);
        delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE;
    });

    it('secondary with UNKNOWN coverage (reader returns undefined) → degraded', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        const { calls, db: vdb } = db();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => undefined });
        const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
        expect(res).toEqual([]);
        expect(calls.length).toBe(0);
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
    });

    it('custom COVERAGE_READABLE_THRESHOLD env is honored', async () => {
        process.env.HYBRID_MODE = 'true';
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        process.env.COVERAGE_READABLE_THRESHOLD = '0.40';
        const { calls, db: vdb } = db();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.50 /* now >= 0.40 */ });
        await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
        expect(calls).toEqual(['claude_context_own_0p6b']);
        delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE; delete process.env.COVERAGE_READABLE_THRESHOLD;
    });

    it('PRIMARY model is always sufficient regardless of reader', async () => {
        const { calls, db: vdb } = db();
        const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: vdb as any, coverageReader: () => 0.0 });
        await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-8b');
        expect(calls.length).toBeGreaterThan(0); // primary never degraded
    });
});
