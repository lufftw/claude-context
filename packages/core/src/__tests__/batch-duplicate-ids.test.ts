// A splitter can emit the same chunk twice (same path, lines and content => same deterministic id).
// Milvus rejects an upsert request that carries one primary key twice, which used to fail the whole
// batch as a REAL error and abort indexing. The batch must send each id once and still count every
// produced chunk as inserted, so per-file completeness is unaffected.
import { Context } from '../context';
import { CodeChunk } from '../splitter';

function chunk(fp: string, content: string, s = 1, e = 2): CodeChunk {
    return { content, metadata: { startLine: s, endLine: e, language: 'typescript', filePath: fp } };
}

function makeCtx(captured: any[][]) {
    const stubDb: any = {
        hasCollection: async () => false,
        upsert: async (_c: string, d: any[]) => { captured.push(d); },
        upsertHybrid: async (_c: string, d: any[]) => { captured.push(d); },
    };
    const ctx = new Context({
        vectorDatabase: stubDb,
        embedding: {
            getDimension: () => 4, getProvider: () => 'p', detectDimension: async () => 4,
            embed: async () => ({ vector: [], dimension: 4 }), embedBatchPartial: async () => [],
        } as any,
    });
    (ctx as any).getIsHybrid = () => true;
    return ctx;
}

const target = {
    modelId: 'qwen3-embedding-8b', collectionName: 'claude_context_own', isHybrid: true,
    embedding: {
        getDimension: () => 4,
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: [0.1, 0.2, 0.3, 0.4], dimension: 4 })),
    },
};

describe('processChunkBatch with duplicate chunk ids', () => {
    it('upserts each id once but counts every produced chunk as inserted', async () => {
        const captured: any[][] = [];
        const ctx = makeCtx(captured);
        const items = [
            { chunk: chunk('/repo/a.ts', 'same', 10, 20), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: chunk('/repo/a.ts', 'same', 10, 20), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: chunk('/repo/a.ts', 'other', 21, 30), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(target, items);
        expect(captured).toHaveLength(1);
        const ids = captured[0].map((d: any) => d.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toHaveLength(2);
        expect(outcome.realFailures).toBe(0);
        expect(outcome.successes).toBe(3);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 3, inserted: 3 });
    });

    it('same content at different lines or paths keeps separate rows', async () => {
        const captured: any[][] = [];
        const ctx = makeCtx(captured);
        const items = [
            { chunk: chunk('/repo/a.ts', 'same', 1, 2), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: chunk('/repo/a.ts', 'same', 3, 4), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: chunk('/repo/b.ts', 'same', 1, 2), codebasePath: '/repo', relativePath: 'b.ts' },
        ];
        await (ctx as any).processChunkBatch(target, items);
        expect(captured[0]).toHaveLength(3);
    });
});
