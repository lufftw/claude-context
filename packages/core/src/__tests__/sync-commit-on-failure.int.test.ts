// A background sync deletes a changed file's rows, then re-embeds them. If it stops between the two, the saved baseline
// must not have moved, or the rows are gone for good and every later sync reports "no changes".
import { Context } from '../context';

const PRIMARY = 'sync_failure_own';

describe('_reindexByChangeImpl keeps the baseline when re-embedding fails', () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    function build(fakeSync: any) {
        const stubDb: any = {
            hasCollection: async () => true,
            query: async () => [{ id: 'stale-id' }],
            delete: async () => { },
            queryAll: async () => [],
            deleteByFilter: async () => { },
            upsert: async () => { }, upsertHybrid: async () => { },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const mk = (dim: number, prov: string) => ({
            getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async () => [],
        });
        const ctx = new Context({ vectorDatabase: stubDb, embedding: mk(4096, 'p') as any, secondaryEmbedding: mk(1024, 's') as any });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).synchronizers.set(PRIMARY, fakeSync);
        return ctx;
    }

    const fake = (modified: string[], removed: string[] = []) => {
        const calls = { commit: 0 };
        return {
            calls,
            sync: {
                initialize: async () => { },
                checkForChanges: async () => ({ added: [], removed, modified }),
                commitChanges: async () => { calls.commit++; },
            },
        };
    };

    it('does not commit when re-embedding throws', async () => {
        const { calls, sync } = fake(['a.ts']);
        const ctx = build(sync);
        (ctx as any).processFileList = async () => { throw new Error('embedding worker unavailable'); };
        await expect((ctx as any).reindexByChange('/repo')).rejects.toThrow('embedding worker unavailable');
        expect(calls.commit).toBe(0);
    });

    it('does not commit when the chunk limit stopped the run', async () => {
        const { calls, sync } = fake(['a.ts']);
        const ctx = build(sync);
        (ctx as any).processFileList = async () => ({ processedFiles: 0, totalChunks: 0, status: 'limit_reached' });
        await (ctx as any).reindexByChange('/repo');
        expect(calls.commit).toBe(0);
    });

    it('commits a removal, which needs no re-embedding', async () => {
        const { calls, sync } = fake([], ['gone.ts']);
        await (build(sync) as any).reindexByChange('/repo');
        expect(calls.commit).toBe(1);
    });

    it('commits nothing when nothing changed', async () => {
        const { calls, sync } = fake([]);
        await (build(sync) as any).reindexByChange('/repo');
        expect(calls.commit).toBe(0);
    });
});
