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

    // M2: a NON-FINITE COVERAGE_READABLE_THRESHOLD ('abc' → parseFloat NaN) must NOT
    // make `ratio >= NaN` permanently false (which would silently degrade EVERY
    // secondary). The guard falls back to the 0.85 default, so a healthy 0.90 ratio
    // STILL issues the ANN call; and it warns ONCE (console.warn, not console.log).
    it('M2: garbage COVERAGE_READABLE_THRESHOLD falls back to 0.85 default and warns once', async () => {
        process.env.HYBRID_MODE = 'true';
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        process.env.COVERAGE_READABLE_THRESHOLD = 'abc'; // parseFloat → NaN
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const { calls, db: vdb } = db();
            const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.90 /* >= default 0.85 */ });
            // Two searches: behavior must be correct on BOTH, and the warn fires ONCE.
            await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
            await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
            // 0.90 >= 0.85 default → ANN call issued on the _0p6b collection BOTH times.
            expect(calls).toEqual(['claude_context_own_0p6b', 'claude_context_own_0p6b']);
            const thresholdWarns = warnSpy.mock.calls
                .map(c => String(c[0]))
                .filter(m => m.includes('COVERAGE_READABLE_THRESHOLD'));
            expect(thresholdWarns.length).toBe(1); // warn-once latch
        } finally {
            warnSpy.mockRestore();
            delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.HYBRID_MODE; delete process.env.COVERAGE_READABLE_THRESHOLD;
        }
    });

    it('M2: garbage threshold still degrades a BELOW-default ratio (default 0.85 enforced)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        process.env.COVERAGE_READABLE_THRESHOLD = 'not-a-number';
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => { });
        try {
            const { calls, db: vdb } = db();
            const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: vdb as any, coverageReader: () => 0.50 /* < default 0.85 */ });
            const res = await ctx.semanticSearch(CB, 'q', 5, 0.3, undefined, 'qwen3-embedding-0.6b');
            expect(res).toEqual([]);          // degraded
            expect(calls.length).toBe(0);     // no ANN call
        } finally {
            warnSpy.mockRestore();
            delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B; delete process.env.COVERAGE_READABLE_THRESHOLD;
        }
    });
});
