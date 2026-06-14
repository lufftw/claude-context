// Commit 2/4 — partial-batch reducer + three-way abort counter.
//
// These tests exercise the indexer batch reducer in `context.ts`:
//   - processChunkBatch must consume embedBatchPartial's per-item results,
//     insert ONLY the succeeded slots (paired indices, no positional drift),
//     and return a BatchOutcome with per-file produced/inserted accounting.
//   - processChunkBuffer must forward the FULL tuple (incl. relativePath).
//   - processFileList must apply a THREE-WAY abort counter:
//       REAL failures      -> increment consecutiveBatchErrors (-> abort at MAX)
//       clean+productive   -> reset to 0
//       pure WAIT (neutral)-> leave unchanged
//     and the abort throw MUST propagate out of processFileList (not be
//     swallowed by the per-file try/catch).
//
// We construct a real Context with a stub vectorDatabase (the constructor
// requires one) and inject fake `embedding` / `vectorDatabase` / `codeSplitter`
// via (ctx as any), mirroring how vectordb/__tests__/query-all.test.ts injects
// fakes onto a constructed instance.

import { Context } from '../context';
import { CodeChunk } from '../splitter';
import { EmbedItemResult, EmbedReason } from '../embedding';

// ── Helpers ──────────────────────────────────────────────────────────────

const DIM = 4;

function vec(): number[] {
    return [0.1, 0.2, 0.3, 0.4];
}

function ok(index: number, vector: number[] = vec()): EmbedItemResult {
    return { ok: true, index, vector, dimension: vector.length };
}

function fail(index: number, reason: EmbedReason): EmbedItemResult {
    return { ok: false, index, reason };
}

function makeChunk(filePath: string, startLine: number, content: string): CodeChunk {
    return {
        content,
        metadata: {
            startLine,
            endLine: startLine + 1,
            language: 'typescript',
            filePath,
        },
    };
}

// Build a Context with a stub vectordb so the constructor succeeds, then
// overwrite the private fields with fakes for the test.
function makeContext(opts: {
    embedBatchPartial: (texts: string[]) => Promise<EmbedItemResult[]>;
    insert?: (collection: string, docs: any[]) => Promise<void>;
    insertHybrid?: (collection: string, docs: any[]) => Promise<void>;
    upsert?: (collection: string, docs: any[]) => Promise<void>;
    upsertHybrid?: (collection: string, docs: any[]) => Promise<void>;
    dimension?: number;
    hybrid?: boolean;
}): Context {
    // Phase 3: processChunkBatch now writes via upsert/upsertHybrid. For backward
    // compatibility with the existing `insert`/`insertHybrid` test handlers, map
    // upsert→insert and upsertHybrid→insertHybrid unless an explicit upsert handler
    // is provided. insert/insertHybrid remain on the stub so a regression to the
    // old insert path would be observable (those handlers would fire instead).
    const stubDb: any = {
        hasCollection: async () => false,
        query: async () => [],
        queryAll: async () => [],
        insert: opts.insert || (async () => { }),
        insertHybrid: opts.insertHybrid || (async () => { }),
        upsert: opts.upsert || opts.insert || (async () => { }),
        upsertHybrid: opts.upsertHybrid || opts.insertHybrid || (async () => { }),
        deleteByFilter: async () => { },
        createCollection: async () => { },
        createHybridCollection: async () => { },
        dropCollection: async () => { },
    };
    const ctx = new Context({ vectorDatabase: stubDb });

    (ctx as any).embedding = {
        embedBatchPartial: opts.embedBatchPartial,
        embedBatch: async (texts: string[]) =>
            texts.map(() => ({ vector: vec(), dimension: opts.dimension ?? DIM })),
        getDimension: () => opts.dimension ?? DIM,
        getProvider: () => 'fake',
        embed: async () => ({ vector: vec(), dimension: opts.dimension ?? DIM }),
        detectDimension: async () => opts.dimension ?? DIM,
    };

    // Force a deterministic hybrid setting (avoids HYBRID_MODE env dependence).
    (ctx as any).getIsHybrid = () => opts.hybrid ?? false;

    return ctx;
}

// Build the single primary IndexTarget that processChunkBatch/Buffer now require
// (M7). Reads the injected fake embedding + getIsHybrid so the dim-guard / embed /
// upsert collection match what these unit tests expect (collection 'c1').
function targetFor(ctx: Context): any {
    return {
        modelId: 'qwen3-embedding-8b',
        collectionName: 'c1',
        embedding: (ctx as any).embedding,
        isHybrid: (ctx as any).getIsHybrid(),
    };
}

// ── 1. Partial insert: succeeded slots only, paired indices ───────────────

describe('processChunkBatch — partial insert (paired indices)', () => {
    it('inserts only succeeded slots and tallies per-file produced/inserted', async () => {
        const insertCalls: any[][] = [];
        const ctx = makeContext({
            // 3 chunks; slot 1 (index 1) fails REAL (worker-error).
            embedBatchPartial: async (_texts) => [ok(0), fail(1, 'worker-error'), ok(2)],
            insert: async (_collection, docs) => { insertCalls.push(docs); },
            hybrid: false,
        });

        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/a.ts', 3, 'BBB'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/b.ts', 1, 'CCC'), codebasePath: '/repo', relativePath: 'b.ts' },
        ];

        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);

        expect(outcome.successes).toBe(2);
        expect(outcome.realFailures).toBe(1);
        expect(outcome.waitFailures).toBe(0);

        // per-file accounting (keyed by relativePath)
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 2, inserted: 1 });
        expect(outcome.perFile.get('b.ts')).toEqual({ produced: 1, inserted: 1 });

        // exactly one insert call with exactly 2 docs
        expect(insertCalls.length).toBe(1);
        expect(insertCalls[0].length).toBe(2);

        // The surviving docs must map to the RIGHT chunks (no positional drift):
        // the inserted docs correspond to items[0] (AAA) and items[2] (CCC),
        // NOT items[1] (BBB which failed). Verify via generateId of the right chunk.
        const idFor = (rp: string, chunk: CodeChunk) =>
            (ctx as any).generateId(rp, chunk.metadata.startLine, chunk.metadata.endLine, chunk.content);
        const insertedIds = insertCalls[0].map((d: any) => d.id);
        expect(insertedIds).toContain(idFor('a.ts', items[0].chunk));
        expect(insertedIds).toContain(idFor('b.ts', items[2].chunk));
        expect(insertedIds).not.toContain(idFor('a.ts', items[1].chunk));
        // And their content matches the surviving chunks.
        const contents = insertCalls[0].map((d: any) => d.content).sort();
        expect(contents).toEqual(['AAA', 'CCC']);
    });
});

// ── 1b. Whole-batch embed throw counts as REAL (base-provider path) ───────

describe('processChunkBatch — whole-batch embed throw counts as REAL', () => {
    it('returns realFailures=items.length (does not throw) so the counter advances + buffer resets', async () => {
        const ctx = makeContext({
            // Base providers' default embedBatchPartial wraps all-or-nothing embedBatch;
            // a provider 500 throws the whole batch.
            embedBatchPartial: async (_texts) => { throw new Error('OpenAI 500: upstream error'); },
            hybrid: false,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/a.ts', 3, 'BBB'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];

        // Must NOT throw — must return a REAL outcome so the three-way counter sees it.
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);

        expect(outcome.realFailures).toBe(2);
        expect(outcome.successes).toBe(0);
        expect(outcome.waitFailures).toBe(0);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 2, inserted: 0 });
    });
});

// ── 2. Three-way abort counter (via processFileList) ──────────────────────

describe('processFileList — three-way abort counter', () => {
    function fileListCtx(batches: EmbedItemResult[][], dimension = DIM): {
        ctx: Context;
        run: () => Promise<any>;
        insertCount: () => number;
    } {
        let call = 0;
        let inserts = 0;
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => {
                const r = batches[Math.min(call, batches.length - 1)];
                call++;
                return r;
            },
            insert: async () => { inserts++; },
            dimension,
            hybrid: false,
        });
        // One chunk per file; EMBEDDING_BATCH_SIZE=1 so each file flushes a batch.
        (ctx as any).codeSplitter = {
            split: async (_content: string, _lang: string, filePath: string) => [
                makeChunk(filePath, 1, `content-of-${filePath}`),
            ],
        };
        // No existing hashes -> nothing skipped.
        (ctx as any).loadExistingFileHashes = async () => new Map();
        (ctx as any).computeFileHash = async () => 'hash';
        (ctx as any).getCollectionName = () => 'c1';
        (ctx as any).getWritableSharedCollectionName = () => undefined;
        // fs reads are stubbed by replacing readFile via the split-only path: we
        // also stub readFile through fs — but processFileList reads the file
        // directly, so monkeypatch that read.
        const origRead = require('fs').promises.readFile;
        (require('fs').promises as any).readFile = async (p: any) => {
            if (typeof p === 'string') return 'X';
            return Buffer.from('X');
        };

        const files = batches.map((_b, i) => `/repo/file${i}.ts`);

        return {
            ctx,
            insertCount: () => inserts,
            run: async () => {
                process.env.EMBEDDING_BATCH_SIZE = '1';
                try {
                    return await (ctx as any).processFileList(files, '/repo');
                } finally {
                    (require('fs').promises as any).readFile = origRead;
                    delete process.env.EMBEDDING_BATCH_SIZE;
                }
            },
        };
    }

    it('REAL failures increment the counter; MAX consecutive REAL aborts the run', async () => {
        // 3 consecutive REAL-only batches (default MAX_CONSECUTIVE_BATCH_ERRORS=3).
        const { run } = fileListCtx([
            [fail(0, 'worker-error')],
            [fail(0, 'worker-error')],
            [fail(0, 'worker-error')],
            [ok(0)], // never reached
        ]);
        await expect(run()).rejects.toThrow(/Aborting indexing/);
    });

    it('a clean productive batch resets the counter (no abort)', async () => {
        // REAL, REAL, CLEAN, REAL, REAL -> never 3 in a row -> no abort.
        const { run } = fileListCtx([
            [fail(0, 'worker-error')],
            [fail(0, 'worker-error')],
            [ok(0)],
            [fail(0, 'worker-error')],
            [fail(0, 'worker-error')],
        ]);
        await expect(run()).resolves.toMatchObject({ status: 'completed' });
    });

    it('pure WAIT batches are neutral (do not increment, do not abort)', async () => {
        // 5 pure-WAIT batches (no successes, no real failures) -> never abort.
        const { run } = fileListCtx([
            [fail(0, 'timeout')],
            [fail(0, 'no-consumer')],
            [fail(0, 'connection-lost')],
            [fail(0, 'timeout')],
            [fail(0, 'no-consumer')],
        ]);
        await expect(run()).resolves.toMatchObject({ status: 'completed' });
    });

    it('WAIT batches interleaved with REAL still abort only on MAX consecutive REAL', async () => {
        // REAL, WAIT, REAL, WAIT, REAL -> 3 REAL but never 3 consecutive
        // (WAIT is neutral, does NOT reset) -> counter goes 1,1,2,2,3 -> abort.
        const { run } = fileListCtx([
            [fail(0, 'worker-error')],
            [fail(0, 'timeout')],
            [fail(0, 'worker-error')],
            [fail(0, 'timeout')],
            [fail(0, 'worker-error')],
        ]);
        await expect(run()).rejects.toThrow(/Aborting indexing/);
    });
});

// ── 3. Rogue-dimension regression ─────────────────────────────────────────

describe('processChunkBatch — rogue dimension counts as REAL', () => {
    it('ok slot with wrong vector length is treated as REAL (bad-dimension) and not inserted', async () => {
        const insertCalls: any[][] = [];
        const ctx = makeContext({
            // ok:true but the vector has the WRONG dimension (2 vs expected 4).
            embedBatchPartial: async (_texts) => [ok(0, [0.1, 0.2])],
            insert: async (_c, docs) => { insertCalls.push(docs); },
            dimension: DIM,
            hybrid: false,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(outcome.realFailures).toBe(1);
        expect(outcome.successes).toBe(0);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 1, inserted: 0 });
        // nothing inserted (either no call, or a call with 0 docs)
        const totalDocs = insertCalls.reduce((s, c) => s + c.length, 0);
        expect(totalDocs).toBe(0);
    });

    it('three consecutive bad-dimension batches abort (preserves rogue-worker guard)', async () => {
        let call = 0;
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => { call++; return [ok(0, [0.1, 0.2])]; },
            insert: async () => { },
            dimension: DIM,
            hybrid: false,
        });
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string) => [makeChunk(fp, 1, `c-${fp}`)],
        };
        (ctx as any).loadExistingFileHashes = async () => new Map();
        (ctx as any).computeFileHash = async () => 'h';
        (ctx as any).getCollectionName = () => 'c1';
        (ctx as any).getWritableSharedCollectionName = () => undefined;
        const origRead = require('fs').promises.readFile;
        (require('fs').promises as any).readFile = async () => 'X';
        process.env.EMBEDDING_BATCH_SIZE = '1';
        try {
            await expect(
                (ctx as any).processFileList(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'], '/repo')
            ).rejects.toThrow(/Aborting indexing/);
        } finally {
            (require('fs').promises as any).readFile = origRead;
            delete process.env.EMBEDDING_BATCH_SIZE;
        }
    });
});

// ── 4. Insert-throw classification ────────────────────────────────────────

describe('processChunkBatch — insert throw counts as REAL (insert-error)', () => {
    it('when insert throws, slots count as realFailures and inserted stays 0', async () => {
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0), ok(1)],
            insert: async () => { throw new Error("insert failed for 'c1': CollectionNotExists"); },
            dimension: DIM,
            hybrid: false,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/a.ts', 3, 'BBB'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(outcome.realFailures).toBe(2);
        expect(outcome.successes).toBe(0);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 2, inserted: 0 });
    });
});

// ── 4b. Phase 3: processChunkBatch writes via upsert (NOT insert) ──────────

describe('processChunkBatch — Phase 3 uses upsert/upsertHybrid (not insert/insertHybrid)', () => {
    it('non-hybrid: calls vectorDatabase.upsert and never insert', async () => {
        const upsertCalls: any[][] = [];
        let insertCalled = false;
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0), ok(1)],
            insert: async () => { insertCalled = true; },     // must NOT fire
            upsert: async (_c, docs) => { upsertCalls.push(docs); },
            dimension: DIM,
            hybrid: false,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/a.ts', 3, 'BBB'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(insertCalled).toBe(false);
        expect(upsertCalls.length).toBe(1);
        expect(upsertCalls[0].length).toBe(2);
        expect(outcome.successes).toBe(2);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 2, inserted: 2 });
    });

    it('hybrid: calls vectorDatabase.upsertHybrid and never insertHybrid', async () => {
        const upsertHybridCalls: any[][] = [];
        let insertHybridCalled = false;
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0)],
            insertHybrid: async () => { insertHybridCalled = true; }, // must NOT fire
            upsertHybrid: async (_c, docs) => { upsertHybridCalls.push(docs); },
            dimension: DIM,
            hybrid: true,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(insertHybridCalled).toBe(false);
        expect(upsertHybridCalls.length).toBe(1);
        expect(upsertHybridCalls[0].length).toBe(1);
        expect(outcome.successes).toBe(1);
    });

    it('a thrown upsert still classifies as REAL insert-error (counter advances)', async () => {
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0), ok(1)],
            upsert: async () => { throw new Error("upsert failed for 'c1': CollectionNotExists"); },
            dimension: DIM,
            hybrid: false,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
            { chunk: makeChunk('/repo/a.ts', 3, 'BBB'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(outcome.realFailures).toBe(2);
        expect(outcome.successes).toBe(0);
        expect(outcome.perFile.get('a.ts')).toEqual({ produced: 2, inserted: 0 });
    });

    it('a thrown upsertHybrid (hybrid path) also classifies as REAL insert-error', async () => {
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0)],
            upsertHybrid: async () => { throw new Error("upsert failed for 'c1': OutOfMemory"); },
            dimension: DIM,
            hybrid: true,
        });
        const items = [
            { chunk: makeChunk('/repo/a.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'a.ts' },
        ];
        const outcome = await (ctx as any).processChunkBatch(targetFor(ctx), items);
        expect(outcome.realFailures).toBe(1);
        expect(outcome.successes).toBe(0);
    });
});

// ── 5. relativePath threaded through processChunkBuffer ────────────────────

describe('processChunkBuffer — forwards relativePath tuple to processChunkBatch', () => {
    it('keys perFile by the tuple relativePath (not derived positionally)', async () => {
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0), ok(1)],
            insert: async () => { },
            dimension: DIM,
            hybrid: false,
        });
        const buffer = [
            { chunk: makeChunk('/repo/x.ts', 1, 'AAA'), codebasePath: '/repo', relativePath: 'x.ts' },
            { chunk: makeChunk('/repo/y.ts', 1, 'BBB'), codebasePath: '/repo', relativePath: 'y.ts' },
        ];
        const outcome = await (ctx as any).processChunkBuffer(targetFor(ctx), buffer);
        expect(outcome.perFile.has('x.ts')).toBe(true);
        expect(outcome.perFile.has('y.ts')).toBe(true);
        expect(outcome.perFile.get('x.ts')).toEqual({ produced: 1, inserted: 1 });
        expect(outcome.perFile.get('y.ts')).toEqual({ produced: 1, inserted: 1 });
        expect(outcome.successes).toBe(2);
    });
});

// ── 6. Final-batch flush honors the three-way logic (REAL not swallowed) ───

describe('processFileList — final batch flush honors three-way classification', () => {
    it('a REAL failure ONLY in the final batch increments but does not silently complete-clean', async () => {
        // Single file, single chunk, EMBEDDING_BATCH_SIZE large so it only
        // flushes at the final-batch path. The slot fails REAL. With MAX=1
        // (INDEX_MAX_CONSECUTIVE_ERRORS=1) the final-batch REAL must abort.
        let call = 0;
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => { call++; return [fail(0, 'worker-error')]; },
            insert: async () => { },
            dimension: DIM,
            hybrid: false,
        });
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string) => [makeChunk(fp, 1, `c-${fp}`)],
        };
        (ctx as any).loadExistingFileHashes = async () => new Map();
        (ctx as any).computeFileHash = async () => 'h';
        (ctx as any).getCollectionName = () => 'c1';
        (ctx as any).getWritableSharedCollectionName = () => undefined;
        const origRead = require('fs').promises.readFile;
        (require('fs').promises as any).readFile = async () => 'X';
        process.env.EMBEDDING_BATCH_SIZE = '100'; // never trips inner flush
        process.env.INDEX_MAX_CONSECUTIVE_ERRORS = '1'; // abort on first REAL
        try {
            await expect(
                (ctx as any).processFileList(['/repo/a.ts'], '/repo')
            ).rejects.toThrow(/Aborting indexing/);
        } finally {
            (require('fs').promises as any).readFile = origRead;
            delete process.env.EMBEDDING_BATCH_SIZE;
            delete process.env.INDEX_MAX_CONSECUTIVE_ERRORS;
        }
    });

    it('a clean final batch completes without abort', async () => {
        const ctx = makeContext({
            embedBatchPartial: async (_texts) => [ok(0)],
            insert: async () => { },
            dimension: DIM,
            hybrid: false,
        });
        (ctx as any).codeSplitter = {
            split: async (_c: string, _l: string, fp: string) => [makeChunk(fp, 1, `c-${fp}`)],
        };
        (ctx as any).loadExistingFileHashes = async () => new Map();
        (ctx as any).computeFileHash = async () => 'h';
        (ctx as any).getCollectionName = () => 'c1';
        (ctx as any).getWritableSharedCollectionName = () => undefined;
        const origRead = require('fs').promises.readFile;
        (require('fs').promises as any).readFile = async () => 'X';
        process.env.EMBEDDING_BATCH_SIZE = '100';
        try {
            const r = await (ctx as any).processFileList(['/repo/a.ts'], '/repo');
            expect(r.status).toBe('completed');
        } finally {
            (require('fs').promises as any).readFile = origRead;
            delete process.env.EMBEDDING_BATCH_SIZE;
        }
    });
});
