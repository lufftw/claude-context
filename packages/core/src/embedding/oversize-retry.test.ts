import { CONTEXT_BUSY_BACKOFF_MS, MAX_OVERSIZE_CUTS, shortenForContextLimit } from './oversize-retry';
import { RabbitMQEmbedding } from './rabbitmq-embedding';

const oversize = (tokens: number, limit = 2048) =>
    `terminal: OpenAI-compatible embed error: 400 - {"error":{"code":400,"message":"request (${tokens} tokens) exceeds the available context size (${limit} tokens), try increasing it","type":"exceed_context_size_error"}}`;

describe('shortenForContextLimit', () => {
    it('keeps the leading part, scaled by the reported limit with a margin', () => {
        const text = 'a'.repeat(2500);
        const out = shortenForContextLimit(text, oversize(2222))!;
        expect(out).toBe(text.slice(0, out.length));
        expect(out.length).toBe(Math.floor(2500 * (2048 / 2222) * 0.9)); // 2073
        expect(out.length).toBeLessThan(2500);
    });

    it('returns null for any other error, so those still fail as before', () => {
        expect(shortenForContextLimit('abc', 'OpenAI-compatible embed error: 500 - boom')).toBeNull();
        expect(shortenForContextLimit('abc', 'Embedding worker returned failure')).toBeNull();
    });

    it('returns null when the numbers do not describe an overflow or the text cannot shrink', () => {
        expect(shortenForContextLimit('abcdef', oversize(100, 2048))).toBeNull();
        expect(shortenForContextLimit('a', oversize(5000))).toBeNull();
    });
});

describe('RabbitMQEmbedding.sendOneWithRetry on oversize chunks', () => {
    // The wrapper is private and sendOne needs a broker; build the object without connecting and stub sendOne.
    const make = (sendOne: (text: string, attempt: number) => Promise<number[]>, maxRetries = 0) => {
        const emb = Object.create(RabbitMQEmbedding.prototype) as any;
        emb.config = { maxRetries };
        emb.sendOne = sendOne;
        return emb as { sendOneWithRetry(text: string): Promise<number[]> };
    };
    const workerError = (message: string) => Object.assign(new Error(message), { embedReason: 'worker-error' });
    let errSpy: jest.SpyInstance;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => errSpy.mockRestore());

    it('sends a shortened copy once and returns its vector', async () => {
        const seen: number[] = [];
        const emb = make(async (text) => {
            seen.push(text.length);
            if (text.length > 2100) throw workerError(oversize(2222));
            return [1, 2, 3];
        });
        await expect(emb.sendOneWithRetry('a'.repeat(2500))).resolves.toEqual([1, 2, 3]);
        expect(seen).toEqual([2500, 2073]);
    });

    it('does not use the WAIT-retry budget (maxRetries 0 still gets its shortened attempt)', async () => {
        let calls = 0;
        const emb = make(async (text) => {
            calls++;
            if (text.length === 1000) throw workerError(oversize(3000));
            return [9];
        }, 0);
        await expect(emb.sendOneWithRetry('b'.repeat(1000))).resolves.toEqual([9]);
        expect(calls).toBe(2);
    });

    it('stays bounded: an input that still overflows after the cuts fails as a worker error', async () => {
        let calls = 0;
        const emb = make(async () => { calls++; throw workerError(oversize(9000)); });
        await expect(emb.sendOneWithRetry('c'.repeat(5000))).rejects.toMatchObject({ embedReason: 'worker-error' });
        expect(calls).toBe(MAX_OVERSIZE_CUTS + 1);
    });

    it('resends after a pause when the worker reports momentary context pressure, then succeeds', async () => {
        jest.useFakeTimers();
        try {
            let calls = 0;
            const emb = make(async () => {
                calls++;
                if (calls < 3) throw workerError('OpenAI-compatible embed error: 500 - {"error":{"code":500,"message":"Context size has been exceeded."}}');
                return [4, 5];
            });
            const p = emb.sendOneWithRetry('e'.repeat(300));
            await jest.advanceTimersByTimeAsync(60_000);
            await expect(p).resolves.toEqual([4, 5]);
            expect(calls).toBe(3);
        } finally {
            jest.useRealTimers();
        }
    });

    it('gives up after the backoff list when the worker stays busy', async () => {
        jest.useFakeTimers();
        try {
            let calls = 0;
            const emb = make(async () => { calls++; throw workerError('500 - Context size has been exceeded.'); });
            const p = emb.sendOneWithRetry('f'.repeat(300));
            const settled = expect(p).rejects.toMatchObject({ embedReason: 'worker-error' });
            await jest.advanceTimersByTimeAsync(300_000);
            await settled;
            expect(calls).toBe(CONTEXT_BUSY_BACKOFF_MS.length + 1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('fails fast, with no resend, on a worker error that is not about size', async () => {
        let calls = 0;
        const emb = make(async () => { calls++; throw workerError('OpenAI-compatible embed error: 500 - boom'); }, 3);
        await expect(emb.sendOneWithRetry('d'.repeat(500))).rejects.toMatchObject({ embedReason: 'worker-error' });
        expect(calls).toBe(1);
    });
});
