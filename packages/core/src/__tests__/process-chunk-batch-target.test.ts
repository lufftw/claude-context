// Task 2.2 (M7 + P1) — processChunkBatch(target, items): the expectedDim
// rogue-dimension guard reads target.embedding.getDimension(), embed reads
// target.embedding.embedBatchPartial, and upsert goes to target.collectionName.
// There is NO inline writable-shared double-write (P1) — writable-shared is its
// own IndexTarget, so a batch upserts exactly once into target.collectionName.

import { Context } from '../context';
import { CodeChunk } from '../splitter';

function chunk(fp: string, content: string): CodeChunk {
    return { content, metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } };
}

describe('processChunkBatch(target, items) (M7 + P1)', () => {
    afterEach(() => {
        delete process.env.MILVUS_WRITABLE_SHARED;
        delete process.env.MILVUS_COLLECTION_PRIVATE;
    });

    function makeCtx() {
        const upserts: Array<{ collection: string; count: number }> = [];
        const stubDb: any = {
            hasCollection: async () => false,
            upsert: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
            upsertHybrid: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
        };
        const ctx = new Context({
            vectorDatabase: stubDb,
            embedding: {
                getDimension: () => 4096, getProvider: () => 'p', detectDimension: async () => 4096,
                embed: async () => ({ vector: [], dimension: 4096 }), embedBatchPartial: async () => [],
            } as any,
        });
        (ctx as any).getIsHybrid = () => true;
        return { ctx, upserts };
    }

    it('uses target.embedding dim for the rogue-dimension guard (1024 passes, no rogue REAL)', async () => {
        // Even with MILVUS_WRITABLE_SHARED set, the batch must upsert ONCE (P1) —
        // the inline shared dual-write is gone.
        process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
        const { ctx, upserts } = makeCtx();
        const target = {
            modelId: 'qwen3-embedding-0.6b', collectionName: 'claude_context_own_0p6b', isHybrid: true,
            embedding: {
                getDimension: () => 1024,
                embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(1024).fill(0.01), dimension: 1024 })),
            },
        };
        const items = [{ chunk: chunk('/repo/a.ts', 'x'), codebasePath: '/repo', relativePath: 'a.ts' }];
        const outcome = await (ctx as any).processChunkBatch(target, items);
        expect(outcome.realFailures).toBe(0);   // proves expectedDim was rewired to 1024
        expect(outcome.successes).toBe(1);
        expect(upserts).toEqual([{ collection: 'claude_context_own_0p6b', count: 1 }]); // P1: NO shared double-write
    });

    it('a 4096 vector against a 1024 target is a rogue-dimension REAL (proves guard reads target)', async () => {
        const { ctx } = makeCtx();
        const target = {
            modelId: 'qwen3-embedding-0.6b', collectionName: 'claude_context_own_0p6b', isHybrid: true,
            embedding: {
                getDimension: () => 1024,
                embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(4096).fill(0.01), dimension: 4096 })),
            },
        };
        const items = [{ chunk: chunk('/repo/a.ts', 'x'), codebasePath: '/repo', relativePath: 'a.ts' }];
        const outcome = await (ctx as any).processChunkBatch(target, items);
        expect(outcome.realFailures).toBe(1);
        expect(outcome.successes).toBe(0);
    });

    it('non-hybrid target upserts via plain upsert into target.collectionName', async () => {
        const { ctx, upserts } = makeCtx();
        const target = {
            modelId: 'qwen3-embedding-8b', collectionName: 'claude_context_own', isHybrid: false,
            embedding: {
                getDimension: () => 4096,
                embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(4096).fill(0.01), dimension: 4096 })),
            },
        };
        const items = [{ chunk: chunk('/repo/a.ts', 'x'), codebasePath: '/repo', relativePath: 'a.ts' }];
        const outcome = await (ctx as any).processChunkBatch(target, items);
        expect(outcome.successes).toBe(1);
        expect(upserts).toEqual([{ collection: 'claude_context_own', count: 1 }]);
    });
});
