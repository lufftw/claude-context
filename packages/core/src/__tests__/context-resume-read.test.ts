// Commit 4/4 — ledger-gated resume skip: the KEYSTONE read.
//
// These tests drive the REAL processFileList in context.ts with injected fakes
// and verify the resume gate that consults the completeness ledger (priorLedger):
//
//   SKIP a file ⇔  Milvus already has it at this hash (existingHash === fileHash)
//                  AND the ledger says it fully completed at the SAME hash
//                  (led.complete === true && led.fileHash === fileHash).
//
//   Otherwise (re)embed, and delete-before-reembed whenever ANY chunks already
//   exist for the path (existingHash truthy) — this covers:
//     - changed hash (the classic incremental path),
//     - matching hash but ledger says complete:false (partial resume), and
//     - matching hash but ledger ABSENT (Add-2 dup-PK prevention: a plain
//       re-insert would manufacture duplicate deterministic-PK rows).
//
// We follow the makeContext/runFileList pattern from context-completeness.test.ts
// but additionally (a) seed loadExistingFileHashes, (b) pass a priorLedger, and
// (c) spy on deleteByFilter and on embedBatchPartial so we can assert exactly
// which files were re-embedded vs. skipped.

import { Context } from '../context';
import { CodeChunk } from '../splitter';
import { EmbedItemResult } from '../embedding';

const DIM = 4;

function vec(): number[] {
    return [0.1, 0.2, 0.3, 0.4];
}

function ok(index: number, vector: number[] = vec()): EmbedItemResult {
    return { ok: true, index, vector, dimension: vector.length };
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

// Compute the SHA-256 the implementation will produce for a file, using the same
// content the faked readFile returns. (computeFileHash hashes the file content.)
function expectedHashFor(base: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(`content-of-${base}`).digest('hex');
}

interface RunHandles {
    ctx: Context;
    completeCalls: Array<[string, { complete: boolean; fileHash: string; chunkCount: number }]>;
    embeddedTexts: string[];          // every text passed to embedBatchPartial
    deleteFilters: string[];          // every filter passed to deleteByFilter
    run: () => Promise<any>;
}

/**
 * Drive processFileList with:
 *  - chunksPerFile:  basename -> chunk count the splitter returns.
 *  - existingHashes: relativePath -> hash already in Milvus (seeds
 *    loadExistingFileHashes). Use expectedHashFor(base) for a matching hash.
 *  - priorLedger:    relativePath -> { complete, fileHash, chunkCount? } | the
 *    ledger from the prior run (undefined entry = absent).
 */
function runFileList(opts: {
    files: string[];
    chunksPerFile: Record<string, number>;
    existingHashes?: Record<string, string>;
    priorLedger?: Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>;
    batchSize?: number;
}): RunHandles {
    const completeCalls: Array<[string, { complete: boolean; fileHash: string; chunkCount: number }]> = [];
    const embeddedTexts: string[] = [];
    const deleteFilters: string[] = [];

    const stubDb: any = {
        hasCollection: async () => false,
        query: async () => [],
        queryAll: async () => [],
        insert: async () => { },
        insertHybrid: async () => { },
        deleteByFilter: async (_collection: string, filter: string) => { deleteFilters.push(filter); },
        createCollection: async () => { },
        createHybridCollection: async () => { },
        dropCollection: async () => { },
    };
    const ctx = new Context({ vectorDatabase: stubDb });

    (ctx as any).embedding = {
        embedBatchPartial: async (texts: string[]) => {
            for (const t of texts) embeddedTexts.push(t);
            return texts.map((_t, i) => ok(i));
        },
        embedBatch: async (texts: string[]) => texts.map(() => ({ vector: vec(), dimension: DIM })),
        getDimension: () => DIM,
        getProvider: () => 'fake',
        embed: async () => ({ vector: vec(), dimension: DIM }),
        detectDimension: async () => DIM,
    };

    (ctx as any).getIsHybrid = () => false;

    // Splitter returns chunksPerFile[basename] chunks for each file, with content
    // tagged by basename so we can assert which file's chunks got embedded.
    (ctx as any).codeSplitter = {
        split: async (_content: string, _lang: string, filePath: string) => {
            const base = filePath.split(/[\\/]/).pop()!;
            const n = opts.chunksPerFile[base] ?? 1;
            const chunks: CodeChunk[] = [];
            for (let k = 0; k < n; k++) {
                chunks.push(makeChunk(filePath, k * 2 + 1, `${base}-chunk-${k}`));
            }
            return chunks;
        },
    };

    const existing = new Map<string, string>(Object.entries(opts.existingHashes ?? {}));
    (ctx as any).loadExistingFileHashes = async () => existing;
    (ctx as any).getCollectionName = () => 'c1';
    (ctx as any).getWritableSharedCollectionName = () => undefined;

    const origRead = require('fs').promises.readFile;
    (require('fs').promises as any).readFile = async (p: any) => {
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
                    completeCalls.push([rp, info]);
                },
                opts.priorLedger,
            );
        } finally {
            (require('fs').promises as any).readFile = origRead;
            delete process.env.EMBEDDING_BATCH_SIZE;
        }
    };

    return { ctx, completeCalls, embeddedTexts, deleteFilters, run };
}

function embeddedAnyFor(embeddedTexts: string[], base: string): boolean {
    return embeddedTexts.some(t => t.startsWith(`${base}-chunk-`));
}

describe('processFileList — ledger-gated resume skip (Commit 4/4)', () => {
    it('1. verified-complete (hash matches + ledger complete:true at same hash) → SKIP, no re-embed, re-fires complete:true (P46)', async () => {
        const h = expectedHashFor('a.ts');
        const { completeCalls, embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/a.ts'],
            chunksPerFile: { 'a.ts': 2 },
            existingHashes: { 'a.ts': h },
            priorLedger: new Map([['a.ts', { complete: true, fileHash: h, chunkCount: 2 }]]),
            batchSize: 100,
        });
        const r = await run();
        expect(r.status).toBe('completed');

        // Not re-embedded: the splitter's chunks for a.ts never reached embedBatchPartial.
        expect(embeddedAnyFor(embeddedTexts, 'a.ts')).toBe(false);
        // No delete (we skipped, didn't re-embed).
        expect(deleteFilters.length).toBe(0);

        // P46: the ledger entry is re-fired complete:true so it survives the rewrite.
        const aCalls = completeCalls.filter(([rp]) => rp === 'a.ts');
        expect(aCalls.length).toBe(1);
        expect(aCalls[0][1]).toEqual({ complete: true, fileHash: h, chunkCount: 2 });
    });

    it('2. matching hash but ledger complete:false → RE-EMBED + deleteByFilter (partial-resume bug)', async () => {
        const h = expectedHashFor('b.ts');
        const { embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/b.ts'],
            chunksPerFile: { 'b.ts': 2 },
            existingHashes: { 'b.ts': h },
            priorLedger: new Map([['b.ts', { complete: false, fileHash: h, chunkCount: 1 }]]),
            batchSize: 100,
        });
        await run();

        // Re-embedded despite matching hash, because the ledger says incomplete.
        expect(embeddedAnyFor(embeddedTexts, 'b.ts')).toBe(true);
        // Delete-before-reembed fired for the path.
        expect(deleteFilters.some(f => f.includes('b.ts'))).toBe(true);
    });

    it('3. matching hash but ledger ABSENT → RE-EMBED + deleteByFilter (Add-2 dup-PK prevention)', async () => {
        const h = expectedHashFor('c.ts');
        const { embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/c.ts'],
            chunksPerFile: { 'c.ts': 2 },
            existingHashes: { 'c.ts': h },
            priorLedger: new Map(), // no ledger entry for c.ts
            batchSize: 100,
        });
        await run();

        // Even with a matching Milvus hash, an absent ledger entry must NOT skip:
        // a plain re-insert would create duplicate deterministic-PK rows. So we
        // re-embed, AND we delete-before-reembed (not a plain re-insert).
        expect(embeddedAnyFor(embeddedTexts, 'c.ts')).toBe(true);
        expect(deleteFilters.some(f => f.includes('c.ts'))).toBe(true);
    });

    it('4. changed hash → RE-EMBED + deleteByFilter (existing incremental behavior preserved)', async () => {
        const oldHash = 'deadbeef-stale-hash';
        const newHash = expectedHashFor('d.ts');
        const { embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/d.ts'],
            chunksPerFile: { 'd.ts': 2 },
            existingHashes: { 'd.ts': oldHash }, // stale hash differs from current
            // Even a complete:true ledger at the STALE hash must not skip — the
            // file changed on disk.
            priorLedger: new Map([['d.ts', { complete: true, fileHash: oldHash, chunkCount: 2 }]]),
            batchSize: 100,
        });
        await run();

        expect(newHash).not.toBe(oldHash);
        expect(embeddedAnyFor(embeddedTexts, 'd.ts')).toBe(true);
        expect(deleteFilters.some(f => f.includes('d.ts'))).toBe(true);
    });

    it('5. new file (no existingHash, no ledger) → embed, NO deleteByFilter', async () => {
        const { embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/e.ts'],
            chunksPerFile: { 'e.ts': 2 },
            existingHashes: {},          // nothing in Milvus
            priorLedger: new Map(),      // no ledger
            batchSize: 100,
        });
        await run();

        expect(embeddedAnyFor(embeddedTexts, 'e.ts')).toBe(true);
        // No prior chunks → nothing to delete.
        expect(deleteFilters.length).toBe(0);
    });

    it('6. complete ledger but file NOT in Milvus (existingHash absent) → RE-EMBED, NO delete', async () => {
        // Defense in depth: the ledger says complete but Milvus lost the chunks
        // (e.g. collection dropped). existingHash is undefined so the skip gate's
        // `existingHash === fileHash` arm is false → we re-embed. No prior chunks
        // exist for this path, so no delete is issued.
        const h = expectedHashFor('f.ts');
        const { embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/f.ts'],
            chunksPerFile: { 'f.ts': 2 },
            existingHashes: {}, // Milvus has nothing
            priorLedger: new Map([['f.ts', { complete: true, fileHash: h, chunkCount: 2 }]]),
            batchSize: 100,
        });
        await run();

        expect(embeddedAnyFor(embeddedTexts, 'f.ts')).toBe(true);
        expect(deleteFilters.length).toBe(0);
    });

    it('7. SIGKILL-resume: a partial prior run resumes — complete files skipped, the incomplete one re-embedded, new file embedded', async () => {
        // Faithful seeded-state resume (T3). A prior run was killed mid-flight:
        //   done.ts     — fully indexed last run (complete:true, hash matches)   → SKIP
        //   partial.ts  — was mid-insert when killed (complete:false, hash matches) → RE-EMBED + delete
        //   fresh.ts    — never seen before (no Milvus hash, no ledger)          → embed, no delete
        const hDone = expectedHashFor('done.ts');
        const hPartial = expectedHashFor('partial.ts');
        const { completeCalls, embeddedTexts, deleteFilters, run } = runFileList({
            files: ['/repo/done.ts', '/repo/partial.ts', '/repo/fresh.ts'],
            chunksPerFile: { 'done.ts': 2, 'partial.ts': 3, 'fresh.ts': 1 },
            existingHashes: { 'done.ts': hDone, 'partial.ts': hPartial }, // both present in Milvus
            priorLedger: new Map([
                ['done.ts', { complete: true, fileHash: hDone, chunkCount: 2 }],
                ['partial.ts', { complete: false, fileHash: hPartial, chunkCount: 1 }],
            ]),
            batchSize: 100,
        });
        const r = await run();
        expect(r.status).toBe('completed');

        // done.ts: skipped — never re-embedded, no delete, ledger re-fired complete:true.
        expect(embeddedAnyFor(embeddedTexts, 'done.ts')).toBe(false);
        const doneCalls = completeCalls.filter(([rp]) => rp === 'done.ts');
        expect(doneCalls.length).toBe(1);
        expect(doneCalls[0][1]).toEqual({ complete: true, fileHash: hDone, chunkCount: 2 });

        // partial.ts: re-embedded + delete-before-reembed.
        expect(embeddedAnyFor(embeddedTexts, 'partial.ts')).toBe(true);
        expect(deleteFilters.some(f => f.includes('partial.ts'))).toBe(true);

        // fresh.ts: embedded, no delete.
        expect(embeddedAnyFor(embeddedTexts, 'fresh.ts')).toBe(true);
        expect(deleteFilters.some(f => f.includes('fresh.ts'))).toBe(false);

        // The only delete issued was for partial.ts (done skipped, fresh new).
        expect(deleteFilters.length).toBe(1);
    });
});
