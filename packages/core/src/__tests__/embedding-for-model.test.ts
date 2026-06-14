// packages/core/src/__tests__/embedding-for-model.test.ts
import { Context } from '../context';

// Two distinguishable fake embeddings (no network). Only the methods the
// resolver/ctor touch are implemented.
function fakeEmbedding(provider: string, dim: number): any {
    return {
        getProvider: () => provider,
        getDimension: () => dim,
        embed: async (_t: string) => ({ vector: new Array(dim).fill(0.1), dimension: dim }),
        embedBatch: async (ts: string[]) => ts.map(() => ({ vector: new Array(dim).fill(0.1), dimension: dim })),
        detectDimension: async () => dim,
    };
}
const dbStub: any = { hasCollection: async () => true };

describe('getEmbeddingForModel (M4)', () => {
    it('returns the primary instance for the primary id', () => {
        const primary = fakeEmbedding('primary-8b', 4096);
        const ctx = new Context({ embedding: primary, vectorDatabase: dbStub });
        expect(ctx.getEmbeddingForModel('qwen3-embedding-8b')).toBe(primary);
    });

    it('returns the secondary instance for the secondary id when configured', () => {
        const primary = fakeEmbedding('primary-8b', 4096);
        const secondary = fakeEmbedding('secondary-0.6b', 1024);
        const ctx = new Context({ embedding: primary, secondaryEmbedding: secondary, vectorDatabase: dbStub });
        expect(ctx.getEmbeddingForModel('qwen3-embedding-0.6b')).toBe(secondary);
        expect(ctx.getEmbeddingForModel('qwen3-embedding-0.6b').getDimension()).toBe(1024);
    });

    it('throws a configuration error for the secondary id when NOT configured (never wrong-dim)', () => {
        const primary = fakeEmbedding('primary-8b', 4096);
        const ctx = new Context({ embedding: primary, vectorDatabase: dbStub });
        expect(() => ctx.getEmbeddingForModel('qwen3-embedding-0.6b'))
            .toThrow(/not configured/i);
    });

    it('throws on an unknown model id', () => {
        const ctx = new Context({ embedding: fakeEmbedding('p', 4096), vectorDatabase: dbStub });
        expect(() => ctx.getEmbeddingForModel('gpt')).toThrow(/unknown embedding model/i);
    });

    it('exposes hasEmbeddingForModel predicate', () => {
        const ctx = new Context({ embedding: fakeEmbedding('p', 4096), vectorDatabase: dbStub });
        expect(ctx.hasEmbeddingForModel('qwen3-embedding-8b')).toBe(true);
        expect(ctx.hasEmbeddingForModel('qwen3-embedding-0.6b')).toBe(false);
    });
});
