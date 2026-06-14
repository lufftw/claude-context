// Task 3.2 (P1 gate) — distinct-PK == 1 per collection. Proves the residual
// inline writable-shared upsert is GONE (P1): with MILVUS_WRITABLE_SHARED set, a
// known chunk's deterministic PK appears EXACTLY ONCE in the private collection
// and EXACTLY ONCE in the shared collection — never twice in either. The shared
// collection is written by the '__writable_shared__' IndexTarget (C2), which
// REPLACES the deleted inline dual-write.

import { Context } from '../context';
import { CodeChunk } from '../splitter';

const PRIMARY = 'claude_context_own';
const SHARED = 'dev_infra_shared';

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

describe('no double-write into a single collection (P1 duplicate-PK guard)', () => {
    beforeEach(() => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.MILVUS_WRITABLE_SHARED = SHARED;
    });
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });

    it('each PK appears exactly once per collection, and in BOTH the private and shared collection', async () => {
        const CHUNKS = 3;
        // Track every upsert call's PK list per collection to catch within-collection
        // duplicates (a re-introduced inline dual-write would push the same PK twice
        // into the SAME collection in one batch).
        const allUpserts: Array<{ collection: string; ids: string[] }> = [];
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async () => [],
            query: async () => [],
            deleteByFilter: async () => { },
            upsertHybrid: async (c: string, docs: any[]) => { allUpserts.push({ collection: c, ids: docs.map(d => d.id) }); },
            upsert: async (c: string, docs: any[]) => { allUpserts.push({ collection: c, ids: docs.map(d => d.id) }); },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const mk = (dim: number, prov: string) => ({
            getDimension: () => dim, getProvider: () => prov, detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
        });
        // No secondary — writable-shared is the only extra target.
        const ctx = new Context({ vectorDatabase: stubDb, embedding: mk(4096, 'p') as any });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> => {
                const arr: CodeChunk[] = [];
                for (let k = 0; k < CHUNKS; k++) {
                    arr.push({ content: `chunk-${k}`, metadata: { startLine: k * 2 + 1, endLine: k * 2 + 2, language: 'typescript', filePath: fp } });
                }
                return arr;
            },
        };

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo', undefined, () => { }, new Map(),
        ));

        // Aggregate PKs per collection.
        const pkSets = new Map<string, string[]>();
        for (const u of allUpserts) {
            const list = pkSets.get(u.collection) ?? [];
            list.push(...u.ids);
            pkSets.set(u.collection, list);
        }

        // Both collections were written.
        expect(pkSets.has(PRIMARY)).toBe(true);
        expect(pkSets.has(SHARED)).toBe(true);

        for (const coll of [PRIMARY, SHARED]) {
            const ids = pkSets.get(coll)!;
            // distinct-PK == 1 for every chunk: no PK appears twice in one collection.
            expect(ids.length).toBe(CHUNKS);
            expect(new Set(ids).size).toBe(CHUNKS);
        }

        // The SAME deterministic PKs landed in both collections (idempotent, LD-7).
        expect(new Set(pkSets.get(PRIMARY)!)).toEqual(new Set(pkSets.get(SHARED)!));
    });
});
