import {
    Embedding,
    EmbeddingVector,
    EmbedItemResult,
    EmbedReason,
    REAL_REASONS,
    WAIT_REASONS,
} from '../base-embedding';

// Minimal concrete subclass that only implements the abstract surface so we
// can exercise the base-class default `embedBatchPartial`.
class FakeEmbedding extends Embedding {
    protected maxTokens = 100;
    constructor(private readonly dim: number) {
        super();
    }
    async detectDimension(): Promise<number> {
        return this.dim;
    }
    async embed(text: string): Promise<EmbeddingVector> {
        const vector = new Array(this.dim).fill(text.length);
        return { vector, dimension: this.dim };
    }
    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }
    getDimension(): number {
        return this.dim;
    }
    getProvider(): string {
        return 'Fake';
    }
}

describe('Edit A — fault taxonomy + partial-result types', () => {
    it('REAL_REASONS contains exactly the REAL class', () => {
        const expected: EmbedReason[] = ['worker-error', 'bad-dimension', 'malformed', 'insert-error'];
        expect([...REAL_REASONS].sort()).toEqual([...expected].sort());
    });

    it('WAIT_REASONS contains the retryable WAIT class and NOT shutdown', () => {
        const expected: EmbedReason[] = ['timeout', 'no-consumer', 'connection-lost'];
        expect([...WAIT_REASONS].sort()).toEqual([...expected].sort());
        expect(WAIT_REASONS.has('shutdown' as EmbedReason)).toBe(false);
    });

    it('REAL and WAIT reason sets are disjoint', () => {
        for (const r of REAL_REASONS) {
            expect(WAIT_REASONS.has(r)).toBe(false);
        }
    });

    it('base embedBatchPartial wraps embedBatch into ok=true index-aligned results', async () => {
        const e = new FakeEmbedding(4);
        const results: EmbedItemResult[] = await e.embedBatchPartial(['a', 'bb', 'ccc']);
        expect(results.length).toBe(3);
        results.forEach((r, i) => {
            expect(r.ok).toBe(true);
            expect(r.index).toBe(i);
            if (r.ok) {
                expect(r.dimension).toBe(4);
                expect(r.vector.length).toBe(4);
            }
        });
    });
});
