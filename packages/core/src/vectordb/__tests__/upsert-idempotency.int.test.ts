// Live integration test (excluded from the hermetic `pnpm test`; run via `pnpm test:int`).
// Guards the Phase-3 keystone invariant that mocked unit tests cannot: a native Milvus
// upsert on a DETERMINISTIC primary key collapses to exactly ONE physical row (no
// duplicate-PK accumulation) — for BOTH the plain and the hybrid (BM25 sparse_vector
// function-field) collections.
//
// Gated on MILVUS_LIVE so CI without a broker stays green. To run:
//   MILVUS_LIVE=1 MILVUS_ADDRESS=127.0.0.1:19530 MILVUS_TOKEN=root:... pnpm --filter @zilliz/claude-context-core test:int
//
// It operates ONLY on throwaway collections (__upsert_idem_int*, dropped in afterAll) —
// never a real/shared collection.

import { MilvusVectorDatabase } from '../milvus-vectordb';
import { VectorDocument } from '../types';

const live = process.env.MILVUS_LIVE === '1';
const address = process.env.MILVUS_ADDRESS || '127.0.0.1:19530';
const token = process.env.MILVUS_TOKEN || '';

const DIM = 4096;
const PLAIN = '__upsert_idem_int_plain';
const HYBRID = '__upsert_idem_int_hybrid';

function unitVec(): number[] {
    const v = new Array(DIM).fill(0);
    v[0] = 1; // L2 norm = 1
    return v;
}
function doc(id: string, content: string): VectorDocument {
    return {
        id, vector: unitVec(), content,
        relativePath: 'int/x.ts', startLine: 1, endLine: 2, fileExtension: '.ts',
        metadata: { language: 'typescript', fileHash: 'h' },
    };
}

// jest has no native describe.skipIf — emulate it.
const suite = live ? describe : describe.skip;

suite('Milvus upsert idempotency (live)', () => {
    let db: MilvusVectorDatabase;

    beforeAll(async () => {
        db = new MilvusVectorDatabase({ address, token });
        for (const c of [PLAIN, HYBRID]) {
            try { if (await db.hasCollection(c)) await db.dropCollection(c); } catch { /* ignore */ }
        }
    }, 60000);

    afterAll(async () => {
        for (const c of [PLAIN, HYBRID]) {
            try { await db.dropCollection(c); } catch { /* ignore */ }
        }
    }, 60000);

    it('plain: upserting the same deterministic PK twice yields exactly 1 row', async () => {
        await db.createCollection(PLAIN, DIM, 'upsert idempotency (throwaway)');
        await db.upsert(PLAIN, [doc('chunk_idem1', 'first content')]);
        await db.upsert(PLAIN, [doc('chunk_idem1', 'second content')]); // overwrite, must NOT duplicate
        const rows = await db.queryAll(PLAIN, ['id', 'content']);
        const forId = rows.filter(r => r.id === 'chunk_idem1');
        expect(forId.length).toBe(1);               // no duplicate-PK row
        expect(forId[0].content).toBe('second content'); // overwrite took effect
    }, 60000);

    it('hybrid: upsertHybrid on the same PK twice yields exactly 1 row (sparse_vector regenerates)', async () => {
        await db.createHybridCollection(HYBRID, DIM, 'upsert idempotency hybrid (throwaway)');
        await db.upsertHybrid(HYBRID, [doc('chunk_idemh', 'alpha hybrid content')]);
        await db.upsertHybrid(HYBRID, [doc('chunk_idemh', 'beta hybrid content')]);
        const rows = await db.queryAll(HYBRID, ['id', 'content']);
        const forId = rows.filter(r => r.id === 'chunk_idemh');
        expect(forId.length).toBe(1);
        expect(forId[0].content).toBe('beta hybrid content');
        // sparse_vector usability after upsert is proven by a hybrid search on the new term.
        const hits = await db.hybridSearch(HYBRID, [
            { data: unitVec(), anns_field: 'vector', param: {}, limit: 5 },
            { data: 'beta', anns_field: 'sparse_vector', param: {}, limit: 5 },
        ], { limit: 5 });
        expect(hits.length).toBeGreaterThan(0);
    }, 60000);
});
