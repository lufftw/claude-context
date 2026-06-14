// packages/core/src/__tests__/clear-per-model.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
    return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: [], dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}

function spyDb(existing: Set<string>) {
    const dropped: string[] = [];
    const db: any = {
        hasCollection: async (c: string) => existing.has(c),
        dropCollection: async (c: string) => { dropped.push(c); existing.delete(c); },
        query: async () => [],
    };
    return { db, dropped };
}

const CB = process.cwd();

describe('_clearIndexImpl per-model drop (P3)', () => {
    it('single-model: drops only the primary collection (byte-identical)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
        const { db, dropped } = spyDb(new Set(['claude_context_own']));
        const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: db });
        await ctx.clearIndex(CB);
        expect(dropped).toEqual(['claude_context_own']);
        delete process.env.MILVUS_COLLECTION_PRIVATE;
    });

    it('dual-model: drops BOTH the primary and the _0p6b collection', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        const { db, dropped } = spyDb(new Set(['claude_context_own', 'claude_context_own_0p6b']));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await ctx.clearIndex(CB);
        expect(dropped.sort()).toEqual(['claude_context_own', 'claude_context_own_0p6b']);
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
    });

    it('dual-model + writable-shared: drops primary, _0p6b, and the writable-shared sibling', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'claude_context_own_0p6b';
        process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
        const { db, dropped } = spyDb(new Set(['claude_context_own', 'claude_context_own_0p6b', 'dev_infra_shared']));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await ctx.clearIndex(CB);
        expect(dropped.sort()).toEqual(['claude_context_own', 'claude_context_own_0p6b', 'dev_infra_shared']);
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });
});
