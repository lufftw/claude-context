// Task 2.0 — IndexTarget interface + getCollectionNameForModel resolver +
// buildIndexTargets (LD-3 / LD-5 / C2). Unit tests (run under `pnpm test`).
//
// These exercise the SHARED owner of the per-run target array: the resolver maps
// a canonical model id to a collection name (primary byte-identical, secondary
// suffixed/overridable), and buildIndexTargets emits the per-run IndexTarget[]:
//   - single-model  ⇒ exactly one target, byte-identical name + same embedding.
//   - dual-model    ⇒ primary first, then the _0p6b secondary.
//   - writable-shared (C2) ⇒ an extra '__writable_shared__' target with the
//     SAME embedding instance/dimension as the primary but a distinct collection.

import { Context } from '../context';

function makeCtx(opts: { secondary?: boolean; hybrid?: boolean } = {}): Context {
    const stubDb: any = {
        hasCollection: async () => false, query: async () => [], queryAll: async () => [],
        upsert: async () => { }, upsertHybrid: async () => { }, deleteByFilter: async () => { },
        createCollection: async () => { }, createHybridCollection: async () => { }, dropCollection: async () => { },
    };
    const primary = {
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: [0, 0, 0, 0], dimension: 4 })),
        getDimension: () => 4096, getProvider: () => 'primary',
        embed: async () => ({ vector: [0, 0, 0, 0], dimension: 4096 }), detectDimension: async () => 4096,
    };
    const secondary = opts.secondary ? {
        embedBatchPartial: async (t: string[]) => t.map((_x, i) => ({ ok: true, index: i, vector: [0], dimension: 1 })),
        getDimension: () => 1024, getProvider: () => 'secondary',
        embed: async () => ({ vector: [0], dimension: 1024 }), detectDimension: async () => 1024,
    } : undefined;
    const ctx = new Context({ vectorDatabase: stubDb, embedding: primary as any, secondaryEmbedding: secondary as any });
    (ctx as any).getIsHybrid = () => opts.hybrid ?? true;
    return ctx;
}

describe('getCollectionNameForModel', () => {
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });

    it('primary suffix "" is byte-identical to getCollectionName', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const ctx = makeCtx();
        expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-8b'))
            .toBe(ctx.getCollectionName('/repo'));
        expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-8b')).toBe('claude_context_own');
    });

    it('secondary appends the registry suffix to the base name', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const ctx = makeCtx();
        expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-0.6b'))
            .toBe('claude_context_own_0p6b');
    });

    it('MILVUS_COLLECTION_PRIVATE_0P6B override wins verbatim', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_COLLECTION_PRIVATE_0P6B = 'custom_small_collection';
        const ctx = makeCtx();
        expect((ctx as any).getCollectionNameForModel('/repo', 'qwen3-embedding-0.6b'))
            .toBe('custom_small_collection');
    });

    it('unknown model id throws', () => {
        const ctx = makeCtx();
        expect(() => (ctx as any).getCollectionNameForModel('/repo', 'gpt')).toThrow(/unknown embedding model/i);
    });
});

describe('buildIndexTargets', () => {
    afterEach(() => {
        delete process.env.MILVUS_COLLECTION_PRIVATE;
        delete process.env.MILVUS_COLLECTION_PRIVATE_0P6B;
        delete process.env.MILVUS_WRITABLE_SHARED;
    });

    it('single-model: exactly one target, byte-identical collection + same embedding instance', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const ctx = makeCtx();
        const targets = (ctx as any).buildIndexTargets('/repo');
        expect(targets).toHaveLength(1);
        expect(targets[0].modelId).toBe('qwen3-embedding-8b');
        expect(targets[0].collectionName).toBe('claude_context_own');
        expect(targets[0].embedding).toBe(ctx.getEmbedding());
        expect(targets[0].isHybrid).toBe(true);
    });

    it('dual-model: two targets, primary first; secondary has _0p6b + secondary instance', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        const ctx = makeCtx({ secondary: true });
        const targets = (ctx as any).buildIndexTargets('/repo');
        expect(targets.map((t: any) => t.modelId)).toEqual(['qwen3-embedding-8b', 'qwen3-embedding-0.6b']);
        expect(targets[1].collectionName).toBe('claude_context_own_0p6b');
        expect(targets[1].embedding.getDimension()).toBe(1024);
    });

    // C2 (rev1.2): writable-shared must be an actual IndexTarget — same instance +
    // dimension as the primary, distinct collection, synthetic '__writable_shared__'
    // ledger key (so it never clobbers the primary's per-model ledger).
    it('writable-shared: primary + __writable_shared__ target; same embedding, different collection', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
        const ctx = makeCtx();
        const targets = (ctx as any).buildIndexTargets('/repo');
        expect(targets.map((t: any) => t.modelId)).toEqual(['qwen3-embedding-8b', '__writable_shared__']);
        const primary = targets[0];
        const ws = targets[1];
        expect(ws.collectionName).toBe('dev_infra_shared');
        expect(primary.collectionName).toBe('claude_context_own');
        expect(ws.collectionName).not.toBe(primary.collectionName);
        // Same embedding INSTANCE as primary ⇒ no extra embedding cost, no dim mismatch.
        expect(ws.embedding).toBe(primary.embedding);
        expect(ws.isHybrid).toBe(true);
    });

    it('writable-shared appended AFTER primary and BEFORE the secondary', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_WRITABLE_SHARED = 'dev_infra_shared';
        const ctx = makeCtx({ secondary: true });
        const targets = (ctx as any).buildIndexTargets('/repo');
        expect(targets.map((t: any) => t.modelId)).toEqual([
            'qwen3-embedding-8b', '__writable_shared__', 'qwen3-embedding-0.6b',
        ]);
    });

    it('writable-shared equal to the primary collection is NOT appended', () => {
        process.env.MILVUS_COLLECTION_PRIVATE = 'claude_context_own';
        process.env.MILVUS_WRITABLE_SHARED = 'claude_context_own';
        const ctx = makeCtx();
        const targets = (ctx as any).buildIndexTargets('/repo');
        expect(targets).toHaveLength(1);
        expect(targets[0].modelId).toBe('qwen3-embedding-8b');
    });
});
