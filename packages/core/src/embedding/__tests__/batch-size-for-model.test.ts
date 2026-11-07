// The 0.6B worker (llama-server) rejects a request whose texts exceed its shared context budget
// ("Context size has been exceeded"): measured 2026-11-06 with ~1.9 KB code chunks, batches of
// 100/50/25/16/8 fail and 4 succeeds. A global EMBEDDING_BATCH_SIZE cannot serve both models, so
// each model gets a registry cap, and EMBEDDING_BATCH_SIZE_<SUFFIX> overrides it per model.
import { batchSizeForModel } from '../model-registry';

describe('batchSizeForModel', () => {
    const env = (vals: Record<string, string>) => (k: string) => vals[k];

    it('8B uses the global batch size (no registry cap)', () => {
        expect(batchSizeForModel('qwen3-embedding-8b', 100, env({}))).toBe(100);
    });

    it('0.6B is capped by the registry even when the global size is larger', () => {
        expect(batchSizeForModel('qwen3-embedding-0.6b', 100, env({}))).toBe(4);
    });

    it('a smaller global size still wins over the cap', () => {
        expect(batchSizeForModel('qwen3-embedding-0.6b', 2, env({}))).toBe(2);
    });

    it('EMBEDDING_BATCH_SIZE_0P6B overrides the cap for the 0.6B model only', () => {
        expect(batchSizeForModel('qwen3-embedding-0.6b', 100, env({ EMBEDDING_BATCH_SIZE_0P6B: '8' }))).toBe(8);
        expect(batchSizeForModel('qwen3-embedding-8b', 100, env({ EMBEDDING_BATCH_SIZE_0P6B: '8' }))).toBe(100);
    });

    it('EMBEDDING_BATCH_SIZE_PRIMARY overrides the primary model', () => {
        expect(batchSizeForModel('qwen3-embedding-8b', 100, env({ EMBEDDING_BATCH_SIZE_PRIMARY: '16' }))).toBe(16);
    });

    it('invalid overrides are ignored and the result is never below 1', () => {
        expect(batchSizeForModel('qwen3-embedding-0.6b', 100, env({ EMBEDDING_BATCH_SIZE_0P6B: 'abc' }))).toBe(4);
        expect(batchSizeForModel('qwen3-embedding-0.6b', 100, env({ EMBEDDING_BATCH_SIZE_0P6B: '0' }))).toBe(4);
        expect(batchSizeForModel('unknown-model', 0, env({}))).toBe(1);
    });
});
