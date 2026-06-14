// Task 0.1 (LD-1) — Model registry SSOT contract.
//
// Pins the single source of truth that maps a CANONICAL model id -> its queue,
// dimension, collection-name suffix, and default RabbitMQ priority. Later tasks
// (collection-name resolver in core; config in mcp) import these symbols, so the
// shape and values are a load-bearing contract — asserted here on PARSED values,
// never on substrings.

import {
    DEFAULT_PRIMARY_MODEL_ID,
    EMBEDDING_MODEL_REGISTRY,
    getModelSpec,
    isCanonicalModelId,
} from '../model-registry';

describe('Task 0.1 — embedding model registry SSOT', () => {
    it('registers exactly the two canonical model ids', () => {
        expect(Object.keys(EMBEDDING_MODEL_REGISTRY).sort()).toEqual([
            'qwen3-embedding-0.6b',
            'qwen3-embedding-8b',
        ]);
    });

    it('exposes the 8B spec (queue/dimension/suffix/priority)', () => {
        expect(getModelSpec('qwen3-embedding-8b')).toMatchObject({
            queue: 'embedding.qwen3-8b',
            dimension: 4096,
            collectionSuffix: '',
            priorityDefault: 10,
        });
    });

    it('exposes the 0.6B spec (queue/dimension/suffix/priority)', () => {
        expect(getModelSpec('qwen3-embedding-0.6b')).toMatchObject({
            queue: 'embedding.qwen3-0.6b',
            dimension: 1024,
            collectionSuffix: '_0p6b',
            priorityDefault: 1,
        });
    });

    it('throws on an unknown model id', () => {
        expect(() => getModelSpec('nope')).toThrow(/unknown embedding model/i);
    });

    it('rejects inherited Object.prototype keys (no prototype-pollution leak)', () => {
        expect(() => getModelSpec('__proto__')).toThrow(/unknown embedding model/i);
        expect(() => getModelSpec('constructor')).toThrow(/unknown embedding model/i);
    });

    it('defaults the primary model to 8B with the byte-identical (empty) suffix', () => {
        expect(DEFAULT_PRIMARY_MODEL_ID).toBe('qwen3-embedding-8b');
        expect(getModelSpec(DEFAULT_PRIMARY_MODEL_ID).collectionSuffix).toBe('');
    });

    it('narrows canonical ids via isCanonicalModelId', () => {
        expect(isCanonicalModelId('qwen3-embedding-0.6b')).toBe(true);
        expect(isCanonicalModelId('x')).toBe(false);
    });
});
