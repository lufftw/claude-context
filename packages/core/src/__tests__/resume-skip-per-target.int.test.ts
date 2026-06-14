// Task 2.3 / C3 (M8) — per-target resume-skip. A file is AST-split ONCE iff ANY
// target needs it, but embed+upsert only the targets that individually disagree.
// This proves NOT all-or-nothing: with the 8B ledger complete for a.ts at the disk
// hash but the 0.6B ledger empty, only the 0.6B collection receives upserts.
//
// Drives the REAL processFileList with a primary (4096) + secondary (1024) embedding
// so both targets are active. queryAll returns a prior fileHash for the 8B
// collection but nothing for the _0p6b collection.

import { Context } from '../context';
import { CodeChunk } from '../splitter';

const PRIMARY = 'claude_context_own';
const SECONDARY = 'claude_context_own_0p6b';

// The deterministic content the faked readFile returns for a basename, and the
// SHA-256 the implementation computes from it.
function contentFor(base: string): string { return `content-of-${base}`; }
function hashFor(base: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(contentFor(base)).digest('hex');
}

function makeDualContext(priorRowsByCollection: Record<string, Array<{ relativePath: string; fileHash: string }>>) {
    const upserts: Array<{ collection: string; ids: string[] }> = [];
    const stubDb: any = {
        hasCollection: async () => true,
        // loadExistingFileHashes(collection) → queryAll(collection, ['relativePath','metadata'], '')
        queryAll: async (collection: string) => {
            const rows = priorRowsByCollection[collection] ?? [];
            return rows.map(r => ({ relativePath: r.relativePath, metadata: { fileHash: r.fileHash } }));
        },
        query: async () => [],
        deleteByFilter: async () => { },
        upsert: async (c: string, docs: any[]) => { upserts.push({ collection: c, ids: docs.map(d => d.id) }); },
        upsertHybrid: async (c: string, docs: any[]) => { upserts.push({ collection: c, ids: docs.map(d => d.id) }); },
        createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
    };
    const mk = (dim: number, prov: string) => ({
        getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
        embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
    });
    const ctx = new Context({
        vectorDatabase: stubDb, embedding: mk(4096, 'p') as any, secondaryEmbedding: mk(1024, 's') as any,
    });
    (ctx as any).getIsHybrid = () => true;
    (ctx as any).codeSplitter = {
        split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> => {
            const base = fp.split(/[\\/]/).pop()!;
            return [{ content: `${base}-chunk`, metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }];
        },
    };
    return { ctx, upserts };
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

describe('processFileList — per-target resume-skip (M8, NOT all-or-nothing)', () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    it('8B complete + 0.6B empty for a.ts ⇒ only the _0p6b collection re-embeds', async () => {
        const h = hashFor('a.ts');
        // 8B collection already has a.ts at the disk hash; _0p6b has nothing.
        const { ctx, upserts } = makeDualContext({
            [PRIMARY]: [{ relativePath: 'a.ts', fileHash: h }],
            [SECONDARY]: [],
        });
        const completions: Array<[string, string, boolean]> = [];
        const priorLedgersByModel = new Map<string, Map<string, any>>([
            ['qwen3-embedding-8b', new Map([['a.ts', { complete: true, fileHash: h, chunkCount: 1 }]])],
            ['qwen3-embedding-0.6b', new Map()],
        ]);

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => completions.push([modelId, rp, info.complete]),
            priorLedgersByModel,
        ));

        // a.ts was split once, but upserted ONLY into the _0p6b collection.
        const byCollection = upserts.reduce((m, u) => (m[u.collection] = (m[u.collection] ?? 0) + u.ids.length, m), {} as Record<string, number>);
        expect(byCollection[PRIMARY]).toBeUndefined();   // 8B already complete ⇒ NO re-embed (NOT all-or-nothing)
        expect(byCollection[SECONDARY]).toBe(1);         // 0.6B backfilled

        // onFileComplete fired complete:true for BOTH models (8B via re-fire, 0.6B via embed).
        expect(completions.filter(c => c[0] === 'qwen3-embedding-8b' && c[1] === 'a.ts' && c[2])).toHaveLength(1);
        expect(completions.filter(c => c[0] === 'qwen3-embedding-0.6b' && c[1] === 'a.ts' && c[2])).toHaveLength(1);
    });

    it('a file complete in BOTH ledgers at the disk hash is skipped entirely (no upsert to either)', async () => {
        const h = hashFor('a.ts');
        const { ctx, upserts } = makeDualContext({
            [PRIMARY]: [{ relativePath: 'a.ts', fileHash: h }],
            [SECONDARY]: [{ relativePath: 'a.ts', fileHash: h }],
        });
        const priorLedgersByModel = new Map<string, Map<string, any>>([
            ['qwen3-embedding-8b', new Map([['a.ts', { complete: true, fileHash: h, chunkCount: 1 }]])],
            ['qwen3-embedding-0.6b', new Map([['a.ts', { complete: true, fileHash: h, chunkCount: 1 }]])],
        ]);

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo', undefined, () => { }, priorLedgersByModel,
        ));

        expect(upserts).toHaveLength(0);   // unanimous skip
    });

    it('both ledgers empty ⇒ both collections receive the chunk (new file)', async () => {
        const { ctx, upserts } = makeDualContext({ [PRIMARY]: [], [SECONDARY]: [] });
        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo', undefined, () => { }, new Map(),
        ));
        const byCollection = upserts.reduce((m, u) => (m[u.collection] = (m[u.collection] ?? 0) + u.ids.length, m), {} as Record<string, number>);
        expect(byCollection[PRIMARY]).toBe(1);
        expect(byCollection[SECONDARY]).toBe(1);
    });
});
