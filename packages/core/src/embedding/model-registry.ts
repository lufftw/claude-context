// Single source of truth for dual-embedding model identity (Option B: one collection per model).
// Keyed by CANONICAL model id (stable; collection names are env-mutable and must NOT be ledger keys).

export type CanonicalModelId = 'qwen3-embedding-8b' | 'qwen3-embedding-0.6b';

export interface EmbeddingModelSpec {
    /** Canonical model id; also the per-model ledger key. */
    id: CanonicalModelId;
    /** RabbitMQ inference queue this model's worker consumes. */
    queue: string;
    /** Vector dimension the worker emits (also the Milvus collection dim). */
    dimension: number;
    /** Suffix appended to the base collection name for this model. '' = primary (byte-identical name). */
    collectionSuffix: string;
    /** Default RabbitMQ priority for writes with this model (interactive 8B=10; backfill 0.6B=1). */
    priorityDefault: number;
}

export const DEFAULT_PRIMARY_MODEL_ID: CanonicalModelId = 'qwen3-embedding-8b';

export const EMBEDDING_MODEL_REGISTRY: Record<CanonicalModelId, EmbeddingModelSpec> = {
    'qwen3-embedding-8b': {
        id: 'qwen3-embedding-8b', queue: 'embedding.qwen3-8b', dimension: 4096,
        collectionSuffix: '', priorityDefault: 10,
    },
    'qwen3-embedding-0.6b': {
        id: 'qwen3-embedding-0.6b', queue: 'embedding.qwen3-0.6b', dimension: 1024,
        collectionSuffix: '_0p6b', priorityDefault: 1,
    },
};

export function getModelSpec(id: string): EmbeddingModelSpec {
    if (!isCanonicalModelId(id)) {
        throw new Error(`unknown embedding model id: '${id}' (known: ${Object.keys(EMBEDDING_MODEL_REGISTRY).join(', ')})`);
    }
    return EMBEDDING_MODEL_REGISTRY[id];
}

export function isCanonicalModelId(id: string): id is CanonicalModelId {
    return Object.prototype.hasOwnProperty.call(EMBEDDING_MODEL_REGISTRY, id);
}
