import { CONNECT_BACKOFF_MS } from './oversize-retry';
import { RabbitMQEmbedding } from './rabbitmq-embedding';

describe('RabbitMQEmbedding when the broker cannot be reached', () => {
    let errSpy: jest.SpyInstance;
    beforeEach(() => { errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined); });
    afterEach(() => errSpy.mockRestore());

    const make = (sendOne: (text: string, attempt: number) => Promise<number[]>, maxRetries = 3) => {
        const emb = Object.create(RabbitMQEmbedding.prototype) as any;
        emb.config = { maxRetries };
        emb.sendOne = sendOne;
        return emb as { sendOneWithRetry(text: string): Promise<number[]> };
    };
    const connectFailure = () => Object.assign(new Error('Socket closed abruptly during opening handshake'),
        { embedReason: 'connection-lost', embedConnectFailure: true });

    it('sendOne tags a failed connection as a wait-class connection fault', async () => {
        const emb = Object.create(RabbitMQEmbedding.prototype) as any;
        emb.initialize = async () => { throw new Error('Socket closed abruptly during opening handshake'); };
        await expect(emb.sendOne('x', 0)).rejects.toMatchObject({ embedReason: 'connection-lost', embedConnectFailure: true });
    });

    it('waits out a broker outage longer than the three WAIT retries and then succeeds', async () => {
        jest.useFakeTimers();
        try {
            let calls = 0;
            const emb = make(async () => {
                calls++;
                if (calls <= 5) throw connectFailure();
                return [1, 2];
            });
            const p = emb.sendOneWithRetry('chunk');
            await jest.advanceTimersByTimeAsync(600_000);
            await expect(p).resolves.toEqual([1, 2]);
            expect(calls).toBe(6);
        } finally {
            jest.useRealTimers();
        }
    });

    it('gives up once the reconnect budget is spent, as a connection fault', async () => {
        jest.useFakeTimers();
        try {
            let calls = 0;
            const emb = make(async () => { calls++; throw connectFailure(); });
            const p = emb.sendOneWithRetry('chunk');
            const settled = expect(p).rejects.toMatchObject({ embedReason: 'connection-lost' });
            await jest.advanceTimersByTimeAsync(1_500_000);
            await settled;
            // the reconnect pauses are a separate budget, then the ordinary WAIT retries run
            expect(calls).toBe(CONNECT_BACKOFF_MS.length + 3 + 1);
        } finally {
            jest.useRealTimers();
        }
    });
});
