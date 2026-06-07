// Commit 3/4 — snapshot completeness ledger: the onFileComplete callback fired
// by processFileList.
//
// These tests drive the REAL processFileList in context.ts with injected fakes
// (embedding / vectorDatabase / codeSplitter) and an onFileComplete spy, then
// assert the firing contract:
//
//   complete:true  ⇔ every chunk the splitter produced for the file was
//                    embedded AND inserted AND that count equals the splitter's
//                    FULL chunk count (the chunk-limit orphan guard:
//                    produced === inserted is NOT sufficient; produced must also
//                    equal the splitter total, else a CHUNK_LIMIT-truncated file
//                    would be falsely reported complete).
//   complete:false ⇔ the file was produced but never reached complete:true
//                    (a chunk failed to embed/insert, or CHUNK_LIMIT truncated
//                    it mid-file).
//
// The fileHash carried in the fired info must match the file's computed hash.
//
// We follow the makeContext pattern from context-batch-reducer.test.ts.

import { Context } from '../context';
import { CodeChunk } from '../splitter';
import { EmbedItemResult, EmbedReason } from '../embedding';

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

function makeContext(opts: {
    embedBatchPartial: (texts: string[]) => Promise<EmbedItemResult[]>;
    insert?: (collection: string, docs: any[]) => Promise<void>;
    dimension?: number;
    hybrid?: boolean;
}): Context {
    const stubDb: any = {
        hasCollection: async () => false,
        query: async () => [],
        queryAll: async () => [],
        insert: opts.insert || (async () => { }),
        insertHybrid: opts.insert || (async () => { }),
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

    (ctx as any).getIsHybrid = () => opts.hybrid ?? false;

    return ctx;
}

/**
 * Drive processFileList over a fixed file list whose per-file chunking and
 * per-batch embed results are scripted. Returns the onFileComplete spy calls
 * and the computed fileHash the implementation will produce for the files.
 *
 *  - chunksPerFile:   map relativeFileName -> number of chunks the splitter
 *                     returns for that file.
 *  - embedResultsFor: optional override; given (relativePath, batchTexts) decide
 *                     the per-slot EmbedItemResult[] for that batch. Defaults to
 *                     all-ok.
 */
function runFileList(opts: {
    files: string[];                       // absolute-ish paths under /repo
    chunksPerFile: Record<string, number>; // basename -> chunk count
    batchSize?: number;
    embedAllOk?: boolean;                  // default true
    failFirstSlotOfFile?: string;          // basename whose first-seen chunk fails REAL
}): {
    ctx: Context;
    calls: Array<[string, { complete: boolean; fileHash: string; chunkCount: number }]>;
    run: () => Promise<any>;
} {
    const calls: Array<[string, { complete: boolean; fileHash: string; chunkCount: number }]> = [];

    const ctx = makeContext({
        embedBatchPartial: async (texts: string[]) => {
            if (opts.embedAllOk === false && opts.failFirstSlotOfFile) {
                // First slot fails REAL, the rest succeed.
                return texts.map((_t, i) => (i === 0 ? fail(i, 'worker-error') : ok(i)));
            }
            return texts.map((_t, i) => ok(i));
        },
        insert: async () => { },
        dimension: DIM,
        hybrid: false,
    });

    // Splitter returns chunksPerFile[basename] chunks for each file.
    (ctx as any).codeSplitter = {
        split: async (_content: string, _lang: string, filePath: string) => {
            const base = filePath.split('/').pop()!;
            const n = opts.chunksPerFile[base] ?? 1;
            const chunks: CodeChunk[] = [];
            for (let k = 0; k < n; k++) {
                chunks.push(makeChunk(filePath, k * 2 + 1, `${base}-chunk-${k}`));
            }
            return chunks;
        },
    };

    (ctx as any).loadExistingFileHashes = async () => new Map();
    (ctx as any).getCollectionName = () => 'c1';
    (ctx as any).getWritableSharedCollectionName = () => undefined;

    const origRead = require('fs').promises.readFile;
    (require('fs').promises as any).readFile = async (p: any) => {
        // computeFileHash reads as a Buffer; the streaming read uses 'utf-8'.
        // Make the content deterministic per-file so the hash is stable.
        const s = typeof p === 'string' ? p : String(p);
        const base = s.split(/[\\/]/).pop() || 'x';
        return `content-of-${base}`;
    };

    const run = async () => {
        if (opts.batchSize !== undefined) {
            process.env.EMBEDDING_BATCH_SIZE = String(opts.batchSize);
        }
        try {
            return await (ctx as any).processFileList(
                opts.files,
                '/repo',
                undefined, // onFileProcessed
                (rp: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => {
                    calls.push([rp, info]);
                },
            );
        } finally {
            (require('fs').promises as any).readFile = origRead;
            delete process.env.EMBEDDING_BATCH_SIZE;
        }
    };

    return { ctx, calls, run };
}

// Compute the SHA-256 the implementation will produce for a file, using the same
// content the faked readFile returns.
function expectedHashFor(base: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(`content-of-${base}`).digest('hex');
}

describe('processFileList — onFileComplete completeness ledger', () => {
    it('1. a file whose 2/2 chunks embed+insert fires complete:true exactly once', async () => {
        const { calls, run } = runFileList({
            files: ['/repo/a.ts'],
            chunksPerFile: { 'a.ts': 2 },
            batchSize: 100, // single final-batch flush
        });
        const r = await run();
        expect(r.status).toBe('completed');

        const aCalls = calls.filter(([rp]) => rp === 'a.ts');
        expect(aCalls.length).toBe(1);
        expect(aCalls[0][1]).toEqual({
            complete: true,
            fileHash: expectedHashFor('a.ts'),
            chunkCount: 2,
        });
    });

    it('2. a file with 1 of 2 chunks failing REAL fires complete:false (never complete:true)', async () => {
        const { calls, run } = runFileList({
            files: ['/repo/b.ts'],
            chunksPerFile: { 'b.ts': 2 },
            batchSize: 100,
            embedAllOk: false,
            failFirstSlotOfFile: 'b.ts',
        });
        await run();

        const bCalls = calls.filter(([rp]) => rp === 'b.ts');
        expect(bCalls.length).toBe(1);
        expect(bCalls[0][1].complete).toBe(false);
        // produced=2, inserted=1 -> incomplete; chunkCount reflects inserted.
        expect(bCalls[0][1].chunkCount).toBe(1);
        expect(bCalls.some(([, info]) => info.complete === true)).toBe(false);
    });

    it('3. chunk-limit orphan guard: produced < splitter-total fires complete:false even when produced === inserted', async () => {
        // FAITHFUL repro of the real CHUNK_LIMIT (450000) truncation path:
        // a single file whose splitter returns CHUNK_LIMIT + 1 chunks. The inner
        // loop breaks at totalChunks === 450000, leaving the last chunk unpushed.
        // Every pushed chunk embeds + inserts OK, so produced === inserted ===
        // 450000, but produced (450000) < total (450001) -> the gate must NOT
        // report complete:true; the end-of-run sweep fires complete:false.
        const CHUNK_LIMIT = 450000;
        const { calls, run } = runFileList({
            files: ['/repo/huge.ts'],
            chunksPerFile: { 'huge.ts': CHUNK_LIMIT + 1 },
            // Large batch size so the whole file flushes in the final batch; the
            // limit break happens during pushing, before the final flush.
            batchSize: CHUNK_LIMIT + 10,
        });
        const r = await run();
        expect(r.status).toBe('limit_reached');

        const hugeCalls = calls.filter(([rp]) => rp === 'huge.ts');
        expect(hugeCalls.length).toBe(1);
        expect(hugeCalls[0][1].complete).toBe(false);
        // Guard proof: produced === inserted (all flushed chunks succeeded) yet
        // still incomplete because produced < splitter total.
        expect(hugeCalls[0][1].chunkCount).toBe(CHUNK_LIMIT);
    }, 60000);

    it('4. the fired fileHash matches the file computed hash (multiple files)', async () => {
        const { calls, run } = runFileList({
            files: ['/repo/a.ts', '/repo/c.ts'],
            chunksPerFile: { 'a.ts': 1, 'c.ts': 3 },
            batchSize: 100,
        });
        const r = await run();
        expect(r.status).toBe('completed');

        const a = calls.find(([rp]) => rp === 'a.ts');
        const c = calls.find(([rp]) => rp === 'c.ts');
        expect(a).toBeDefined();
        expect(c).toBeDefined();
        expect(a![1]).toEqual({ complete: true, fileHash: expectedHashFor('a.ts'), chunkCount: 1 });
        expect(c![1]).toEqual({ complete: true, fileHash: expectedHashFor('c.ts'), chunkCount: 3 });
    });
});
