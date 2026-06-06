// Interface definitions
export interface EmbeddingVector {
    vector: number[];
    dimension: number;
}

/**
 * Machine-readable fault classification for embedding failures.
 *
 * REAL class  — a genuine, content/logic-level fault that retrying cannot fix
 *               (the worker rejected the input, returned a bad shape, or the
 *               DB insert was rejected). Do NOT retry.
 * WAIT class  — a transient liveness/transport fault where the work itself was
 *               never definitively rejected; a fresh republish may succeed.
 *               ('shutdown' is intentionally NOT in WAIT_REASONS — a deliberate
 *               close must never be retried.)
 */
export type EmbedReason =
    | 'worker-error' | 'bad-dimension' | 'malformed' | 'insert-error'   // REAL class
    | 'timeout' | 'no-consumer' | 'connection-lost' | 'shutdown';        // WAIT class (+ shutdown=non-retryable)

export const REAL_REASONS: ReadonlySet<EmbedReason> =
    new Set<EmbedReason>(['worker-error', 'bad-dimension', 'malformed', 'insert-error']);

export const WAIT_REASONS: ReadonlySet<EmbedReason> =
    new Set<EmbedReason>(['timeout', 'no-consumer', 'connection-lost']); // 'shutdown' is NOT retried

/**
 * Index-aligned per-item result for a partial-tolerant batch embed.
 * A failed slot carries a tagged `reason` (and optional human `detail`) but
 * NEVER a zero/wrong-dimension vector — callers can skip it without corrupting
 * the collection.
 */
export type EmbedItemResult =
    | { ok: true; index: number; vector: number[]; dimension: number }
    | { ok: false; index: number; reason: EmbedReason; detail?: string };

/**
 * Abstract base class for embedding implementations
 */
export abstract class Embedding {
    protected abstract maxTokens: number;

    /**
     * Preprocess text to ensure it's valid for embedding
     * @param text Input text
     * @returns Processed text
     */
    protected preprocessText(text: string): string {
        // Replace empty string with single space
        if (text === '') {
            return ' ';
        }

        // Simple character-based truncation (approximation)
        // Each token is roughly 4 characters on average for English text
        const maxChars = this.maxTokens * 4;
        if (text.length > maxChars) {
            let sliced = text.substring(0, maxChars);
            // Guard against cutting a UTF-16 surrogate pair: if the last
            // code unit is a high surrogate (U+D800..U+DBFF) with no paired
            // low surrogate, drop it. Downstream JSON consumers that strictly
            // validate surrogate pairs (e.g. llama.cpp nlohmann::json) reject
            // lone surrogates with json.exception.parse_error.101.
            const lastUnit = sliced.charCodeAt(sliced.length - 1);
            if (lastUnit >= 0xD800 && lastUnit <= 0xDBFF) {
                sliced = sliced.substring(0, sliced.length - 1);
            }
            return sliced;
        }

        return text;
    }

    /**
     * Detect embedding dimension 
     * @param testText Test text for dimension detection
     * @returns Embedding dimension
     */
    abstract detectDimension(testText?: string): Promise<number>;

    /**
     * Preprocess array of texts
     * @param texts Array of input texts
     * @returns Array of processed texts
     */
    protected preprocessTexts(texts: string[]): string[] {
        return texts.map(text => this.preprocessText(text));
    }

    // Abstract methods that must be implemented by subclasses
    /**
     * Generate text embedding vector
     * @param text Text content
     * @returns Embedding vector
     */
    abstract embed(text: string): Promise<EmbeddingVector>;

    /**
     * Generate text embedding vectors in batch
     * @param texts Text array
     * @returns Embedding vector array
     */
    abstract embedBatch(texts: string[]): Promise<EmbeddingVector[]>;

    /**
     * Partial-tolerant batch embed. The default implementation simply wraps
     * embedBatch's all-or-nothing result into index-aligned ok=true entries;
     * providers with real partial semantics (e.g. RabbitMQEmbedding) override
     * this to return per-item failures without aborting the whole batch.
     * @param texts Text array
     * @returns Index-aligned per-item results
     */
    async embedBatchPartial(texts: string[]): Promise<EmbedItemResult[]> {
        const vics = await this.embedBatch(texts);
        return vics.map((v, index) => ({ ok: true as const, index, vector: v.vector, dimension: v.dimension }));
    }

    /**
     * Get embedding vector dimension
     * @returns Vector dimension
     */
    abstract getDimension(): number;

    /**
     * Get service provider name
     * @returns Provider name
     */
    abstract getProvider(): string;
} 