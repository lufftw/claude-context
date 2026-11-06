// Model-scoped operations: resolveScopedModelIds + clearIndex(onlyModelId)
import { Context } from '../context';
import { FileSynchronizer } from '../sync/synchronizer';

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
const P = 'claude_context_own';
const S = 'claude_context_own_0p6b';

function setEnv(extra: Record<string, string> = {}) {
    process.env.MILVUS_COLLECTION_PRIVATE = P;
    process.env.MILVUS_COLLECTION_PRIVATE_0P6B = S;
    for (const [k, v] of Object.entries(extra)) process.env[k] = v;
}
function clearEnv() {
    for (const k of ['MILVUS_COLLECTION_PRIVATE', 'MILVUS_COLLECTION_PRIVATE_0P6B', 'MILVUS_WRITABLE_SHARED']) delete process.env[k];
}

describe('resolveScopedModelIds', () => {
    afterEach(clearEnv);

    it('omitted or blank selects every active model', () => {
        setEnv();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: spyDb(new Set()).db });
        expect(ctx.resolveScopedModelIds()).toEqual(['qwen3-embedding-8b', 'qwen3-embedding-0.6b']);
        expect(ctx.resolveScopedModelIds('   ')).toEqual(['qwen3-embedding-8b', 'qwen3-embedding-0.6b']);
    });

    it('a named active model selects exactly that model', () => {
        setEnv();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: spyDb(new Set()).db });
        expect(ctx.resolveScopedModelIds('qwen3-embedding-0.6b')).toEqual(['qwen3-embedding-0.6b']);
        expect(ctx.resolveScopedModelIds('qwen3-embedding-8b')).toEqual(['qwen3-embedding-8b']);
    });

    it('an unknown id throws instead of falling back to all models', () => {
        setEnv();
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: spyDb(new Set()).db });
        expect(() => ctx.resolveScopedModelIds('qwen3-embedding-4b')).toThrow(/not active/);
    });

    it('the secondary throws when it is not configured (single-model server)', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = P;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
        const ctx = new Context({ embedding: fakeEmbedding(4096), vectorDatabase: spyDb(new Set()).db });
        expect(() => ctx.resolveScopedModelIds('qwen3-embedding-0.6b')).toThrow(/MILVUS_COLLECTION_PRIVATE_0P6B/);
    });
});

describe('clearIndex(onlyModelId)', () => {
    afterEach(() => { clearEnv(); jest.restoreAllMocks(); });

    it('secondary only: drops just the _0p6b collection and keeps change tracking', async () => {
        setEnv({ MILVUS_WRITABLE_SHARED: 'dev_infra_shared' });
        const del = jest.spyOn(FileSynchronizer, 'deleteSnapshot').mockResolvedValue(undefined as any);
        const { db, dropped } = spyDb(new Set([P, S, 'dev_infra_shared']));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await ctx.clearIndex(CB, undefined, 'qwen3-embedding-0.6b');
        expect(dropped).toEqual([S]);
        expect(del).not.toHaveBeenCalled();
    });

    it('primary only: drops the private primary, never the shared sibling or the secondary', async () => {
        setEnv({ MILVUS_WRITABLE_SHARED: 'dev_infra_shared' });
        const del = jest.spyOn(FileSynchronizer, 'deleteSnapshot').mockResolvedValue(undefined as any);
        const { db, dropped } = spyDb(new Set([P, S, 'dev_infra_shared']));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await ctx.clearIndex(CB, undefined, 'qwen3-embedding-8b');
        expect(dropped).toEqual([P]);
        expect(del).not.toHaveBeenCalled();
    });

    it('unknown model: throws and drops nothing', async () => {
        setEnv();
        const del = jest.spyOn(FileSynchronizer, 'deleteSnapshot').mockResolvedValue(undefined as any);
        const { db, dropped } = spyDb(new Set([P, S]));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await expect(ctx.clearIndex(CB, undefined, 'bogus-model')).rejects.toThrow(/not active/);
        expect(dropped).toEqual([]);
        expect(del).not.toHaveBeenCalled();
    });

    it('no model given: unchanged behaviour, drops every model and the snapshot', async () => {
        setEnv();
        const del = jest.spyOn(FileSynchronizer, 'deleteSnapshot').mockResolvedValue(undefined as any);
        const { db, dropped } = spyDb(new Set([P, S]));
        const ctx = new Context({ embedding: fakeEmbedding(4096), secondaryEmbedding: fakeEmbedding(1024), vectorDatabase: db });
        await ctx.clearIndex(CB);
        expect(dropped.sort()).toEqual([P, S]);
        expect(del).toHaveBeenCalledTimes(1);
    });
});
