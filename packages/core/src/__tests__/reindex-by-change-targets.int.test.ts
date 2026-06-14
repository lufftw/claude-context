// Task 3.3 (P2) — _reindexByChangeImpl under IndexTarget. The background syncer is
// a SECOND live entry point; left single-target it desyncs _0p6b on the first user
// edit. This proves a modified file is:
//   (a) deleted from BOTH claude_context_own and claude_context_own_0p6b,
//   (b) re-upserted into BOTH collections,
//   (c) desync gate: after reindex, every row the syncer wrote into _0p6b for the
//       modified path carries the NEW fileHash (no stale-hash rows survive).

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

describe('_reindexByChangeImpl — per-target delete + re-embed (P2)', () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    it('a modified file is deleted from + re-upserted into BOTH collections; no stale-hash _0p6b rows', async () => {
        const deletedFrom: string[] = [];          // collections deleteFileChunks ran on
        const upsertedRows: Array<{ collection: string; fileHash: string; relativePath: string }> = [];

        const stubDb: any = {
            hasCollection: async () => true,
            // deleteFileChunks: query returns one stale row id per collection, then delete.
            query: async (_collection: string, _filter: string, _fields: string[]) => [{ id: 'stale-id' }],
            delete: async (collection: string, _ids: string[]) => { deletedFrom.push(collection); },
            queryAll: async () => [],   // processFileList loadExistingFileHashes → empty (post-delete)
            deleteByFilter: async () => { },
            upsert: async (c: string, docs: any[]) => {
                docs.forEach(d => upsertedRows.push({ collection: c, fileHash: d.metadata?.fileHash, relativePath: d.relativePath }));
            },
            upsertHybrid: async (c: string, docs: any[]) => {
                docs.forEach(d => upsertedRows.push({ collection: c, fileHash: d.metadata?.fileHash, relativePath: d.relativePath }));
            },
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

        // Inject a fake FileSynchronizer keyed by the PRIMARY collection so
        // _reindexByChangeImpl uses it directly (no real FS Merkle scan).
        const fakeSync = {
            initialize: async () => { },
            checkForChanges: async () => ({ added: [], removed: [], modified: ['a.ts'] }),
        };
        (ctx as any).synchronizers.set(PRIMARY, fakeSync);

        const result = await withFakeRead(() => (ctx as any).reindexByChange('/repo'));
        expect(result).toEqual({ added: 0, removed: 0, modified: 1 });

        // (a) deleted from BOTH collections.
        expect(deletedFrom.filter(c => c === PRIMARY)).toHaveLength(1);
        expect(deletedFrom.filter(c => c === SECONDARY)).toHaveLength(1);

        // (b) re-upserted into BOTH collections.
        expect(upsertedRows.some(r => r.collection === PRIMARY && r.relativePath === 'a.ts')).toBe(true);
        expect(upsertedRows.some(r => r.collection === SECONDARY && r.relativePath === 'a.ts')).toBe(true);

        // (c) desync gate: every _0p6b row for a.ts carries the NEW disk hash.
        const newHash = hashFor('a.ts');
        const sixBRows = upsertedRows.filter(r => r.collection === SECONDARY && r.relativePath === 'a.ts');
        expect(sixBRows.length).toBeGreaterThan(0);
        expect(sixBRows.every(r => r.fileHash === newHash)).toBe(true);
    });

    it('a removed file is deleted from BOTH collections', async () => {
        const deletedFrom: string[] = [];
        const stubDb: any = {
            hasCollection: async () => true,
            query: async () => [{ id: 'stale-id' }],
            delete: async (collection: string) => { deletedFrom.push(collection); },
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
        const fakeSync = {
            initialize: async () => { },
            checkForChanges: async () => ({ added: [], removed: ['gone.ts'], modified: [] }),
        };
        (ctx as any).synchronizers.set(PRIMARY, fakeSync);

        const result = await (ctx as any).reindexByChange('/repo');
        expect(result).toEqual({ added: 0, removed: 1, modified: 0 });
        expect(deletedFrom.filter(c => c === PRIMARY)).toHaveLength(1);
        expect(deletedFrom.filter(c => c === SECONDARY)).toHaveLength(1);
    });
});
