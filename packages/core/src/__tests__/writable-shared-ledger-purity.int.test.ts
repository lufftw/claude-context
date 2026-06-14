// Fix 1 (Phase 2+3 quality) — the synthetic '__writable_shared__' IndexTarget
// must NEVER write a ledger. It is write-only dead weight on the SHARED snapshot
// (its priorLedger is seeded from the primary 8B ledger and is never read back),
// so the core gates it out at EVERY onFileComplete fire site (the fireLedger
// closure in processFileList).
//
// This test proves, with MILVUS_WRITABLE_SHARED set, that:
//   (a) the writable-shared collection still RECEIVES every chunk (the target is
//       NOT disabled — only its LEDGER firing is suppressed), AND
//   (b) the modelIds passed to onFileComplete are ONLY canonical ids
//       (qwen3-embedding-8b / -0.6b) — never '__writable_shared__', AND
//   (c) routing the captured callbacks through the SAME branch logic the snapshot
//       manager uses (primary → top-level `files`; else → filesByModel[modelId])
//       yields a snapshot with NO filesByModel['__writable_shared__'] key.

import { Context } from '../context';
import { CodeChunk } from '../splitter';

const PRIMARY = 'claude_context_own';
const SHARED = 'dev_infra_shared';
const SYNTHETIC = '__writable_shared__';

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

describe('writable-shared ledger purity (Fix 1)', () => {
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });

    function makeContext(opts: { secondary: boolean }) {
        const upserts: Array<{ collection: string; count: number }> = [];
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async () => [],
            query: async () => [],
            deleteByFilter: async () => { },
            upsertHybrid: async (c: string, docs: any[]) => { upserts.push({ collection: c, count: docs.length }); },
            upsert: async (c: string, docs: any[]) => { upserts.push({ collection: c, count: docs.length }); },
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
        return { ctx, upserts };
    }

    // Mirror SnapshotManager.setFileCompleteForModel's routing so we can prove the
    // END-TO-END snapshot shape without importing the mcp package (core must not).
    // primary (DEFAULT_PRIMARY_MODEL_ID) → top-level `files`; else → filesByModel.
    function applyToSnapshot(
        snapshot: { files: Record<string, unknown>; filesByModel: Record<string, Record<string, unknown>> },
        modelId: string, rp: string, info: unknown,
    ) {
        if (modelId === 'qwen3-embedding-8b') {
            snapshot.files[rp] = info;
        } else {
            (snapshot.filesByModel[modelId] ??= {})[rp] = info;
        }
    }

    it('writable-shared collection receives every chunk but NEVER writes a ledger (dual-target)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.MILVUS_WRITABLE_SHARED = SHARED;
        const { ctx, upserts } = makeContext({ secondary: true });

        const firedModelIds = new Set<string>();
        const snapshot = { files: {} as Record<string, unknown>, filesByModel: {} as Record<string, Record<string, unknown>> };

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts', '/repo/b.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => {
                firedModelIds.add(modelId);
                applyToSnapshot(snapshot, modelId, rp, info);
            },
            new Map(),   // no prior ledgers ⇒ every target needs every file
        ));

        // (a) the shared collection still RECEIVED every chunk — the target is alive.
        const sharedCount = upserts.filter(u => u.collection === SHARED).reduce((n, u) => n + u.count, 0);
        expect(sharedCount).toBe(2);
        const primaryCount = upserts.filter(u => u.collection === PRIMARY).reduce((n, u) => n + u.count, 0);
        expect(primaryCount).toBe(2);

        // (b) onFileComplete only ever saw canonical, queryable model ids.
        expect(firedModelIds.has(SYNTHETIC)).toBe(false);
        expect([...firedModelIds].sort()).toEqual(['qwen3-embedding-0.6b', 'qwen3-embedding-8b']);

        // (c) the resulting snapshot has NO filesByModel['__writable_shared__'].
        expect(Object.prototype.hasOwnProperty.call(snapshot.filesByModel, SYNTHETIC)).toBe(false);
        expect(Object.keys(snapshot.filesByModel)).toEqual(['qwen3-embedding-0.6b']);
        // primary ledger is the legacy top-level files; both files present.
        expect(Object.keys(snapshot.files).sort()).toEqual(['a.ts', 'b.ts']);
    });

    it('writable-shared purity holds for the single-model (8B-only) config too', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.MILVUS_WRITABLE_SHARED = SHARED;
        const { ctx, upserts } = makeContext({ secondary: false });

        const firedModelIds = new Set<string>();
        const snapshot = { files: {} as Record<string, unknown>, filesByModel: {} as Record<string, Record<string, unknown>> };

        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo',
            undefined,
            (modelId: string, rp: string, info: any) => {
                firedModelIds.add(modelId);
                applyToSnapshot(snapshot, modelId, rp, info);
            },
            new Map(),
        ));

        // shared still received the chunk
        expect(upserts.some(u => u.collection === SHARED)).toBe(true);
        // ledger purity: only the 8B canonical id ever fired
        expect(firedModelIds.has(SYNTHETIC)).toBe(false);
        expect([...firedModelIds]).toEqual(['qwen3-embedding-8b']);
        expect(Object.keys(snapshot.filesByModel)).toEqual([]); // nothing in filesByModel at all
    });

    it('ledger purity survives a writable-shared delete-on-change FAILURE (recovery path is gated too)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.MILVUS_WRITABLE_SHARED = SHARED;

        const upserts: Array<{ collection: string; count: number }> = [];
        // existing hash present + DIFFERENT → triggers delete-on-change; the shared
        // delete THROWS → the recovery onFileComplete(complete:false) path runs and
        // must STILL be gated for the synthetic key (Fix 1).
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async (_c: string) => [{ relativePath: 'a.ts', metadata: { fileHash: 'OLD-HASH' } }],
            query: async () => [],
            deleteByFilter: async (c: string) => { if (c === SHARED) throw new Error('shared delete boom'); },
            upsertHybrid: async (c: string, docs: any[]) => { upserts.push({ collection: c, count: docs.length }); },
            upsert: async (c: string, docs: any[]) => { upserts.push({ collection: c, count: docs.length }); },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const mk = (dim: number) => ({
            getDimension: () => dim, getProvider: () => 'p', detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
        });
        const ctx = new Context({ vectorDatabase: stubDb, embedding: mk(4096) as any });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
                [{ content: 'x', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }],
        };

        const firedModelIds = new Set<string>();
        await withFakeRead(() => (ctx as any).processFileList(
            ['/repo/a.ts'], '/repo',
            undefined,
            (modelId: string) => { firedModelIds.add(modelId); },
            new Map(),
        ));

        // The synthetic key never fired even via the delete-failure recovery branch.
        expect(firedModelIds.has(SYNTHETIC)).toBe(false);
    });
});
