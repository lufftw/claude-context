// Fix 2 (Phase 2+3 quality) — per-target abort isolation. The 0.6B secondary is
// the OPTIONAL / resilient path: its death must NOT abort the 8B primary index.
//
// Policy proved here:
//   - A NON-primary (0.6B) target that returns REAL-class failures until it hits
//     MAX_CONSECUTIVE_BATCH_ERRORS is DROPPED — the run does NOT throw, the 8B
//     primary receives ALL chunks and its ledger is complete, and the dropped 0.6B
//     target's collection did NOT receive the post-drop chunks (its ledger is NOT
//     falsely marked complete).
//   - The PRIMARY (8B) still aborts the WHOLE run when it hits MAX (no point
//     continuing if the primary is dead) — the run THROWS the abort sentinel.

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

describe('dual-target abort isolation (Fix 2)', () => {
    afterEach(() => { delete process.env.MILVUS_COLLECTION_PRIVATE; delete process.env.INDEX_MAX_CONSECUTIVE_ERRORS; });

    // One file per "chunk" so we can control failures file-by-file. EMBEDDING_BATCH
    // _SIZE=1 ⇒ each chunk is its own batch ⇒ each yields one REAL failure ⇒ the
    // consecutive counter advances one per chunk; MAX=3 ⇒ the target drops on the
    // 3rd consecutive REAL batch.
    function makeContext(opts: {
        primaryEmbedFails?: boolean;       // 8B returns REAL failures (whole-run abort)
        secondaryEmbedFails?: boolean;     // 0.6B returns REAL failures (target drop)
    }) {
        const upserts: Array<{ collection: string; relativePaths: string[] }> = [];
        const stored = new Map<string, Set<string>>();
        const stubDb: any = {
            hasCollection: async () => true,
            queryAll: async () => [],
            query: async () => [],
            deleteByFilter: async () => { },
            upsertHybrid: async (c: string, docs: any[]) => {
                upserts.push({ collection: c, relativePaths: docs.map((d: any) => d.relativePath) });
                const s = stored.get(c) ?? new Set(); docs.forEach((d: any) => s.add(d.relativePath)); stored.set(c, s);
            },
            upsert: async (c: string, docs: any[]) => {
                upserts.push({ collection: c, relativePaths: docs.map((d: any) => d.relativePath) });
                const s = stored.get(c) ?? new Set(); docs.forEach((d: any) => s.add(d.relativePath)); stored.set(c, s);
            },
            createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
        };
        const okEmbed = (dim: number) => ({
            getDimension: () => dim, getProvider: () => 'p', detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) =>
                t.map((_x: string, i: number) => ({ ok: true, index: i, vector: new Array(dim).fill(0.01), dimension: dim })),
        });
        // REAL-class failure for every slot (reason 'worker-error' ∈ REAL_REASONS).
        const failEmbed = (dim: number) => ({
            getDimension: () => dim, getProvider: () => 'p', detectDimension: async () => dim,
            embed: async () => ({ vector: new Array(dim).fill(0.01), dimension: dim }),
            embedBatchPartial: async (t: string[]) =>
                t.map((_x: string, i: number) => ({ ok: false, index: i, reason: 'worker-error' as const })),
        });
        const ctx = new Context({
            vectorDatabase: stubDb,
            embedding: (opts.primaryEmbedFails ? failEmbed(4096) : okEmbed(4096)) as any,
            secondaryEmbedding: (opts.secondaryEmbedFails ? failEmbed(1024) : okEmbed(1024)) as any,
        });
        (ctx as any).getIsHybrid = () => true;
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string): Promise<CodeChunk[]> =>
                [{ content: 'x', metadata: { startLine: 1, endLine: 2, language: 'typescript', filePath: fp } }],
        };
        return { ctx, upserts, stored };
    }

    it('a 0.6B (non-primary) MAX abort DROPS that target only; the run does NOT throw and the 8B primary completes', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.INDEX_MAX_CONSECUTIVE_ERRORS = '3';
        const { ctx, stored } = makeContext({ secondaryEmbedFails: true });

        const completions: Array<{ modelId: string; rp: string; complete: boolean }> = [];
        // 5 files; with batch size 1 the 0.6B target drops after the 3rd consecutive
        // REAL batch (files 1-3), so files 4-5 are never embedded for 0.6B.
        const files = ['/repo/f1.ts', '/repo/f2.ts', '/repo/f3.ts', '/repo/f4.ts', '/repo/f5.ts'];
        process.env.EMBEDDING_BATCH_SIZE = '1';

        let threw = false;
        try {
            await withFakeRead(() => (ctx as any).processFileList(
                files, '/repo',
                undefined,
                (modelId: string, rp: string, info: any) => completions.push({ modelId, rp, complete: info.complete }),
                new Map(),
            ));
        } catch (e) {
            threw = true;
        }
        delete process.env.EMBEDDING_BATCH_SIZE;

        // (a) the run did NOT throw — a secondary death never aborts the run.
        expect(threw).toBe(false);

        // (b) the 8B/primary collection received ALL 5 files, and its ledger is complete.
        const primaryStored = stored.get(PRIMARY) ?? new Set();
        expect([...primaryStored].sort()).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']);
        const primaryComplete = completions.filter(c => c.modelId === 'qwen3-embedding-8b' && c.complete).map(c => c.rp).sort();
        expect(primaryComplete).toEqual(['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts']);

        // (c) the 0.6B target was DROPPED: its collection got NONE of the post-drop
        // files (it never embedded any — every slot failed), and its ledger was
        // NEVER falsely marked complete:true. The in-flight files are complete:false.
        const secondaryStored = stored.get(SECONDARY) ?? new Set();
        expect(secondaryStored.size).toBe(0);
        const secondaryTrue = completions.filter(c => c.modelId === 'qwen3-embedding-0.6b' && c.complete);
        expect(secondaryTrue).toEqual([]);   // never falsely complete
        // post-drop files (f4, f5) got NO 0.6B ledger entry at all (target was gone).
        const secondaryAny = completions.filter(c => c.modelId === 'qwen3-embedding-0.6b').map(c => c.rp);
        expect(secondaryAny).not.toContain('f4.ts');
        expect(secondaryAny).not.toContain('f5.ts');
    });

    it('a PRIMARY (8B) MAX abort still aborts the WHOLE run (throws the sentinel)', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.INDEX_MAX_CONSECUTIVE_ERRORS = '3';
        process.env.EMBEDDING_BATCH_SIZE = '1';
        const { ctx } = makeContext({ primaryEmbedFails: true });

        const files = ['/repo/f1.ts', '/repo/f2.ts', '/repo/f3.ts', '/repo/f4.ts'];
        let caught: any = undefined;
        try {
            await withFakeRead(() => (ctx as any).processFileList(
                files, '/repo', undefined, () => { }, new Map(),
            ));
        } catch (e) {
            caught = e;
        }
        delete process.env.EMBEDDING_BATCH_SIZE;

        expect(caught).toBeDefined();
        // It is the typed abort sentinel (Fix 4) — re-thrown past the per-file catch.
        expect((caught as any).__isIndexAbort).toBe(true);
    });

    it('with BOTH healthy, both collections complete (no spurious drop/abort) — control', async () => {
        process.env.MILVUS_COLLECTION_PRIVATE = PRIMARY;
        process.env.EMBEDDING_BATCH_SIZE = '1';
        const { ctx, stored } = makeContext({});
        const files = ['/repo/f1.ts', '/repo/f2.ts'];

        let threw = false;
        try {
            await withFakeRead(() => (ctx as any).processFileList(
                files, '/repo', undefined, () => { }, new Map(),
            ));
        } catch { threw = true; }
        delete process.env.EMBEDDING_BATCH_SIZE;

        expect(threw).toBe(false);
        expect([...(stored.get(PRIMARY) ?? new Set())].sort()).toEqual(['f1.ts', 'f2.ts']);
        expect([...(stored.get(SECONDARY) ?? new Set())].sort()).toEqual(['f1.ts', 'f2.ts']);
    });
});
