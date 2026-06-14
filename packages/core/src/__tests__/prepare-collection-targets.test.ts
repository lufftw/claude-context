// Task 2.1 (M6) — per-target prepareCollection. Creates one collection per
// active IndexTarget at that target's own dimension, same hybrid branch; the
// writable-shared collection is still created ONCE at the primary dimension.

import { Context } from '../context';

describe('prepareCollection per-target (M6)', () => {
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });

    function makeCtx(secondary: boolean) {
        const created: Array<{ name: string; dim: number; hybrid: boolean }> = [];
        const stubDb: any = {
            hasCollection: async () => false,
            createCollection: async (n: string, d: number) => { created.push({ name: n, dim: d, hybrid: false }); },
            createHybridCollection: async (n: string, d: number) => { created.push({ name: n, dim: d, hybrid: true }); },
            dropCollection: async () => { },
        };
        const mk = (dim: number, prov: string) => ({
            getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
            embed: async () => ({ vector: [], dimension: dim }), embedBatchPartial: async () => [],
        });
        const ctx = new Context({
            vectorDatabase: stubDb, embedding: mk(4096, 'p') as any,
            ...(secondary ? { secondaryEmbedding: mk(1024, 's') as any } : {}),
        });
        (ctx as any).getIsHybrid = () => true;
        return { ctx, created };
    }

    it('creates BOTH collections, secondary at dim 1024, same hybrid branch', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const { ctx, created } = makeCtx(true);
        await (ctx as any).prepareCollection('/repo', false);
        const byName = Object.fromEntries(created.map(c => [c.name, c]));
        expect(byName['claude_context_own']).toMatchObject({ dim: 4096, hybrid: true });
        expect(byName['claude_context_own_0p6b']).toMatchObject({ dim: 1024, hybrid: true });
    });

    it('single-model: only the primary collection is created (byte-identical)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const { ctx, created } = makeCtx(false);
        await (ctx as any).prepareCollection('/repo', false);
        expect(created.map(c => c.name)).toEqual(['claude_context_own']);
    });

    it('writable-shared is created ONCE at the primary dim (not duplicated per target)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
        const { ctx, created } = makeCtx(true);
        await (ctx as any).prepareCollection('/repo', false);
        const shared = created.filter(c => c.name === 'dev_infra_shared');
        expect(shared).toHaveLength(1);
        expect(shared[0].dim).toBe(4096);
    });
});
