// Task 2.4 (D2) — multi-target index integration. Proves the D2 contract + the
// M7 dim-rewire (N4):
//   1. Both collections receive EVERY chunk.
//   2. Each model's ledger reflects ONLY its own completions.
//   3. A 0.6B batch yields 1024-length vectors with ZERO rogue-dimension REAL
//      failures (proves expectedDim reads target.embedding).
//   4. Single-model variant: byte-identical (only the primary collection, ledger
//      fires for the 8B model only).

import { Context } from '../context';
import { CodeChunk } from '../splitter';

const PRIMARY = 'claude_context_own';
const SECONDARY = 'claude_context_own_0p6b';

function contentFor(base: string): string { return `content-of-${base}`; }

function withFakeRead<T>(fn: () => Promise<T>): Promise<T> {
    const origRead = require('fs').promises.readFile;
    (require('fs').promises as any).readFile = async (p: any) => {
        const s = typeof p === 'string' ? p : String(p);
        const base = s.split(/[\\/]/).pop() || 'x';
        return contentFor(base);
    };
    return fn().finally(() => { (require('fs').promises as any).readFile = origRead; });
}

describe('multi-target index integration (D2)', () => {
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    function makeContext(opts: { secondary: boolean }) {
        const upserts: Array<{ collection: string; vectorLens: number[] }> = [];
        const stored = new Map<string, Set<string>>();
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async (_c: string) => [],   // first run: nothing prior
            query: async () => [],
            deleteByFilter: async () => { },
            upsertHybrid: async (c: string, docs: any[]) => {
                upserts.push({ collection: c, vectorLens: docs.map(d => d.vector.length) });
                const s = stored.get(c) ?? new Set(); docs.forEach(d => s.add(d.id)); stored.set(c, s);
            },
            upsert: async (c: string, docs: any[]) => {
                upserts.push({ collection: c, vectorLens: docs.map(d => d.vector.length) });
                const s = stored.get(c) ?? new Set(); docs.forEach(d => s.add(d.id)); stored.set(c, s);
            },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const mk = (dim: number, prov: string) => ({
            getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) =>
                t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
        });
        const ctx = new Context({
            vectorDatabase: stubDb, embedding: mk(4096, 'p') as any,
            ...(opts.secondary ? { secondaryEmbedding: mk(1024, 's') as any } : {}),
        });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
                [{ content: 'x', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }],
        };
        return { ctx, upserts, stored };
    }

    it('both collections receive every chunk; ledgers are per-model; 0.6B has zero rogue-dim', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        const { ctx, upserts } = makeContext({ secondary: true });
        const completions: Array<[string, string, boolean]> = [];

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts', '/repo/b.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => completions.push([modelId, rp, info.complete]),
            new Map(),   // no prior ledgers ⇒ both targets need every file
        ));

        const byCollection = upserts.reduce((m, u) => (m[u.collection] = (m[u.collection] ?? 0) + u.vectorLens.length, m), {} as Record<string, number>);
        expect(byCollection[PRIMARY]).toBe(2);       // every chunk
        expect(byCollection[SECONDARY]).toBe(2);     // every chunk

        // 0.6B vectors are 1024-length (proves expectedDim reads target.embedding;
        // a rogue dim would have been a REAL failure → no upsert at all).
        const sixBLens = upserts.filter(u => u.collection === SECONDARY).flatMap(u => u.vectorLens);
        expect(sixBLens.every(l => l === 1024)).toBe(true);
        const eightBLens = upserts.filter(u => u.collection === PRIMARY).flatMap(u => u.vectorLens);
        expect(eightBLens.every(l => l === 4096)).toBe(true);

        // per-model ledger: both files complete in both models
        expect(completions.filter(c => c[0] === 'qwen3-embedding-8b' && c[2]).map(c => c[1]).sort()).toEqual(['a.ts', 'b.ts']);
        expect(completions.filter(c => c[0] === 'qwen3-embedding-0.6b' && c[2]).map(c => c[1]).sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('single-model (no secondary): byte-identical — only the primary collection, only the 8B ledger fires', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        const { ctx, upserts } = makeContext({ secondary: false });
        const completions: Array<[string, string, boolean]> = [];

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts', '/repo/b.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => completions.push([modelId, rp, info.complete]),
            new Map(),
        ));

        const collections = [...new Set(upserts.map(u => u.collection))];
        expect(collections).toEqual([PRIMARY]);                 // ONLY the primary
        // Every onFileComplete is for the 8B model exclusively (writes legacy `files`).
        expect(completions.every(c => c[0] === 'qwen3-embedding-8b')).toBe(true);
        expect(completions.filter(c => c[2]).map(c => c[1]).sort()).toEqual(['a.ts', 'b.ts']);
    });
});
