// packages/core/src/__tests__/model-readable.test.ts
import { Context } from '../context';

function fakeEmbedding(dim: number): any {
    return { getProvider: () => 'fake', getDimension: () => dim, embed: async () => ({ vector: [], dimension: dim }), embedBatch: async () => [], detectDimension: async () => dim };
}

describe('isModelReadable (P3)', () => {
    it('primary readable iff its collection exists (byte-identical to today)', async () => {
        const present: any = { hasCollection: async (_c: string) => true };
        const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: present });
        await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-8b')).resolves.toBe(true);
        const absent: any = { hasCollection: async (_c: string) => false };
        const ctx2 = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: absent });
        await expect(ctx2.isModelReadable(process.cwd(), 'qwen3-embedding-8b')).resolves.toBe(false);
    });

    it('secondary NOT readable when not configured (no embedding instance)', async () => {
        const present: any = { hasCollection: async () => true };
        const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: present });
        await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(false);
    });

    it('secondary readable only when collection exists AND coverage sufficient', async () => {
        const present: any = { hasCollection: async () => true };
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: present });
        // Coverage gate closed → not readable even though collection exists.
        jest.spyOn(ctx as any, 'isCoverageSufficientForModel').mockReturnValue(false);
        await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(false);
        // Coverage gate open → readable.
        (ctx as any).isCoverageSufficientForModel.mockReturnValue(true);
        await expect(ctx.isModelReadable(process.cwd(), 'qwen3-embedding-0.6b')).resolves.toBe(true);
    });
});
