// packages/core/src/__tests__/shared-collection-model.test.ts
import { Context } from '../context';

// Minimal VectorDatabase stub — getSharedCollectionNameForModel touches no DB,
// but Context's ctor requires a vectorDatabase instance.
const dbStub: any = { hasCollection: async () => true };

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
    try { fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

describe('getSharedCollectionNameForModel (M5)', () => {
    it('primary 8B returns the configured shared collection (hybrid strategy)', () => {
        withEnv({ MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
            const ctx = new Context({ vectorDatabase: dbStub });
            expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-8b')).toBe('dev_infra_shared');
        });
    });

    it('secondary 0.6B returns undefined even when a shared collection is configured', () => {
        withEnv({ MILVUS_STRATEGY: 'hybrid', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
            const ctx = new Context({ vectorDatabase: dbStub });
            expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-0.6b')).toBeUndefined();
        });
    });

    it('primary 8B returns undefined under strategy=private (parity with getSharedCollectionName)', () => {
        withEnv({ MILVUS_STRATEGY: 'private', MILVUS_COLLECTION_SHARED: 'dev_infra_shared' }, () => {
            const ctx = new Context({ vectorDatabase: dbStub });
            expect(ctx.getSharedCollectionNameForModel('qwen3-embedding-8b')).toBeUndefined();
        });
    });

    it('throws on an unknown model id (registry SSOT)', () => {
        const ctx = new Context({ vectorDatabase: dbStub });
        expect(() => ctx.getSharedCollectionNameForModel('gpt')).toThrow(/unknown embedding model/i);
    });
});
