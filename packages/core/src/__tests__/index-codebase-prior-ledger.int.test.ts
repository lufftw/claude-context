// Task 3.4 (M8 / R2-HANDLER-PRIORLEDGER) — the per-model prior ledgers are
// threaded end-to-end through the PUBLIC indexCodebase entry point. With the 8B
// ledger marking a.ts complete at the disk hash but the 0.6B ledger empty, a.ts
// is upserted ONLY into the _0p6b collection (8B skipped) — proving the per-model
// prior ledger map reaches processFileList's per-target resume-skip.

import { Context } from '../context';
import { CodeChunk } from '../splitter';

const PRIMARY = 'claude_context_own';
const SECONDARY = 'claude_context_own_0p6b';

function contentFor(base: string): string { return `content-of-${base}`; }
function hashFor(base: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(contentFor(base)).digest('hex');
}

function withFakeRead<T>(fn: () => Promise<T>): Promise<T> {
    const origRead = require('fs').promises.readFile;
    (require('fs').promises as any).readFile = async (p: any) => {
        const s = typeof p === 'string' ? p : String(p);
        const base = s.split(/[\\/]/).pop() || 'x';
        return contentFor(base);
    };
    return fn().finally(() => { (require('fs').promises as any).readFile = origRead; });
}

describe('indexCodebase — per-model prior ledgers threaded end-to-end (M8)', () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    it('8B ledger complete + 0.6B empty ⇒ a.ts upserts only into _0p6b', async () => {
        const h = hashFor('a.ts');
        const upserts: Array<{ collection: string; count: number }> = [];
        const stubDb: any = {
            hasCollection: async () => true,
            // 8B collection already has a.ts at the disk hash; _0p6b empty.
            queryAll: async (collection: string) =>
                collection === PRIMARY ? [{ relativePath: 'a.ts', metadata: { fileHash: h } }] : [],
            query: async () => [],
            deleteByFilter: async () => { },
            upsert: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
            upsertHybrid: async (c: string, d: any[]) => { upserts.push({ collection: c, count: d.length }); },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const mk = (dim: number, prov: string) => ({
            getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
        });
        const ctx = new Context({ vectorDatabase: stubDb, embedding: mk(4096, 'p') as any, secondaryEmbedding: mk(1024, 's') as any });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
                [{ content: 'a-chunk', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }],
        };
        // Avoid real FS traversal: stub the scan to return our single file.
        (ctx as any).loadIgnorePatterns = async () => { };
        (ctx as any).getCodeFiles = async () => ['/repo/a.ts'];

        const completions: Array<[string, string, boolean]> = [];
        const priorLedgersByModel = new Map<string, Map<string, any>>([
            ['qwen3-embedding-8b', new Map([['a.ts', { complete: true, fileHash: h, chunkCount: 1 }]])],
            ['qwen3-embedding-0.6b', new Map()],
        ]);

        const stats = await withFakeRead(() => ctx.indexCodebase(
            '/repo',
            undefined,
            (modelId: string, rp: string, info: { complete: boolean; fileHash: string; chunkCount: number }) =>
                completions.push([modelId, rp, info.complete]),
            false,
            priorLedgersByModel,
        ));

        expect(stats.indexedFiles).toBe(1);
        const byCollection = upserts.reduce((m, u) => (m[u.collection] = (m[u.collection] ?? 0) + u.count, m), {} as Record<string, number>);
        expect(byCollection[PRIMARY]).toBeUndefined();   // 8B verified-complete ⇒ skipped
        expect(byCollection[SECONDARY]).toBe(1);         // 0.6B backfilled
        // both models reported complete for a.ts (8B via re-fire, 0.6B via embed)
        expect(completions.filter(c => c[0] === 'qwen3-embedding-8b' && c[1] === 'a.ts' && c[2])).toHaveLength(1);
        expect(completions.filter(c => c[0] === 'qwen3-embedding-0.6b' && c[1] === 'a.ts' && c[2])).toHaveLength(1);
    });
});
