// Task 3.1 / D3 (LD-6 + P1) — per-target delete-on-change with recovery.
//
// Two active targets, both with a STALE existingHash for a.ts (≠ disk hash) so
// both must delete. The 0.6B target's deleteByFilter is stubbed to THROW (and its
// upsert is also stubbed to throw so the file stays incomplete across the run);
// assert:
//   - the 8B target delete SUCCEEDED (deleteByFilter fired for its collection, no
//     complete:false written for 8B by the delete path),
//   - the 0.6B target's onFileComplete fired (modelId='qwen3-embedding-0.6b', a.ts,
//     complete:false) with chunkCount:0 — recovery, NOT a silent warn.

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

describe('deleteChangedForTargets — per-target delete with complete:false recovery (D3)', () => {
    beforeEach(() => { process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY; });
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; });

    it('8B delete OK + 0.6B delete throws ⇒ 0.6B ledger marked complete:false (recovery)', async () => {
        const stale = 'deadbeef-stale-hash';
        const disk = hashFor('a.ts');
        const deletes: Array<{ collection: string; filter: string }> = [];

        const stubDb: any = {
            hasCollection: async () => true,
            // Both collections have a.ts at a STALE hash ⇒ both targets need + delete.
            queryAll: async (_collection: string) => [{ relativePath: 'a.ts', metadata: { fileHash: stale } }],
            query: async () => [],
            deleteByFilter: async (collection: string, filter: string) => {
                deletes.push({ collection, filter });
                if (collection === SECONDARY) {
                    throw new Error('simulated Milvus delete failure on _0p6b');
                }
            },
            upsert: async (collection: string) => {
                if (collection === SECONDARY) throw new Error('simulated _0p6b upsert failure (stays incomplete)');
            },
            upsertHybrid: async (collection: string) => {
                if (collection === SECONDARY) throw new Error('simulated _0p6b upsert failure (stays incomplete)');
            },
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
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
                [{ content: 'a-chunk', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }],
        };

        const completions: Array<[string, string, boolean, number]> = [];
        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => completions.push([modelId, rp, info.complete, info.chunkCount]),
            new Map(),   // empty prior ledgers ⇒ both targets need the changed file
        ));

        // Both targets attempted a delete (stale existingHash ≠ disk hash).
        expect(deletes.some(d => d.collection === PRIMARY && d.filter.includes('a.ts'))).toBe(true);
        expect(deletes.some(d => d.collection === SECONDARY && d.filter.includes('a.ts'))).toBe(true);

        // 8B: NO complete:false written by the delete path (its delete succeeded);
        // it should reach complete:true after a successful embed+upsert.
        const eightB = completions.filter(c => c[0] === 'qwen3-embedding-8b' && c[1] === 'a.ts');
        expect(eightB.some(c => c[2] === false)).toBe(false);
        expect(eightB.some(c => c[2] === true)).toBe(true);

        // 0.6B: delete FAILED ⇒ recovery complete:false (chunkCount 0) fired.
        const sixB = completions.filter(c => c[0] === 'qwen3-embedding-0.6b' && c[1] === 'a.ts');
        expect(sixB.some(c => c[2] === false && c[3] === 0)).toBe(true);
        // and it never ends complete:true (upsert also failed in the same run).
        expect(sixB.some(c => c[2] === true)).toBe(false);
    });

    it('no delete when existingHash === disk hash (unchanged-but-incomplete: upsert overwrites, no pre-delete)', async () => {
        const disk = hashFor('a.ts');
        const deletes: string[] = [];
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async (_collection: string) => [{ relativePath: 'a.ts', metadata: { fileHash: disk } }],
            query: async () => [],
            deleteByFilter: async (collection: string) => { deletes.push(collection); },
            upsert: async () => { }, upsertHybrid: async () => { },
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
        // 8B ledger incomplete at the disk hash ⇒ 8B needs the file but its hash matches
        // ⇒ no pre-delete (upsert overwrites by deterministic PK). Same for 0.6B (empty).
        const prior = new Map<string, Map<string, any>>([
            ['qwen3-embedding-8b', new Map([['a.ts', { complete: false, fileHash: disk, chunkCount: 0 }]])],
            ['qwen3-embedding-0.6b', new Map()],
        ]);
        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo', undefined, () => { }, prior,
        ));
        expect(deletes).toHaveLength(0);
    });
});
