import { RabbitMQEmbedding } from '../rabbitmq-embedding';

// A query lane and an indexing lane, and a depth gate for indexing.
//   (iii) every message expires at its own timeout, so an abandoned request never waits for a worker;
//   (i)   indexing publishes below the events outbox's priority 5; a search query keeps `priority`;
//   (ii)  indexing publishes only while the queue holds fewer ready messages than indexDepthLimit.
//
// The harness mirrors the amqplib surface the client uses, and also captures the publish options
// and serves a programmable queue depth on the second channel the client opens.

interface Published {
    task: any;
    opts: any;
}

const DIM = 8;

function unitVector(): number[] {
    const v = new Array(DIM).fill(0);
    v[0] = 1;
    return v;
}

function makeHarness(initialDepth: number | Error = 0) {
    const published: Published[] = [];
    let consumeCallback: ((msg: any) => void) | null = null;
    let depth: number | Error = initialDepth;
    let depthReads = 0;
    let channelCalls = 0;
    const noop = () => { /* event handlers are not exercised here */ };

    const publishCh: any = {
        on: noop,
        publish: (_exchange: string, _queue: string, buffer: Buffer, opts: any, cb?: (err: any) => void) => {
            published.push({ task: JSON.parse(buffer.toString('utf8')), opts });
            if (cb) cb(null);
            return true;
        },
        close: async () => { /* noop */ },
    };
    const replyCh: any = {
        on: noop,
        assertQueue: async () => ({ queue: 'amq.gen-lanes' }),
        consume: async (_queue: string, cb: (msg: any) => void) => {
            consumeCallback = cb;
            return { consumerTag: 'fake-tag' };
        },
        close: async () => { /* noop */ },
    };
    const depthCh: any = {
        on: noop,
        checkQueue: async (queue: string) => {
            depthReads++;
            if (depth instanceof Error) throw depth;
            return { queue, messageCount: depth, consumerCount: 2 };
        },
        close: async () => { /* noop */ },
    };
    const conn: any = {
        on: noop,
        createConfirmChannel: async () => publishCh,
        // The first channel is the reply channel; any later one is the depth channel.
        createChannel: async () => (channelCalls++ === 0 ? replyCh : depthCh),
        close: async () => { /* noop */ },
    };

    return {
        connectFn: (async () => conn) as any,
        published,
        setDepth: (d: number | Error) => { depth = d; },
        depthReads: () => depthReads,
        reply: (i: number) => {
            if (!consumeCallback) throw new Error('consumer not registered yet');
            const content = Buffer.from(JSON.stringify({
                taskId: published[i].task.id,
                success: true,
                content: JSON.stringify([unitVector()]),
            }));
            consumeCallback({ content });
        },
    };
}

const BASE = { url: 'amqp://x', queue: 'embedding.test', modelName: 'm', dimension: DIM };
const flush = () => new Promise((r) => setImmediate(r));

describe('lane defaults', () => {
    it('indexing waits 1,700,000 ms at priority 4 behind a depth gate of 1000; a query waits 30,000 ms at 5', () => {
        const h = makeHarness();
        const cfg = (new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn }) as any).config;
        expect(cfg.timeoutMs).toBe(1_700_000);
        expect(cfg.queryTimeoutMs).toBe(30_000);
        expect(cfg.priority).toBe(5);
        expect(cfg.indexPriority).toBe(4);
        expect(cfg.indexDepthLimit).toBe(1000);
        expect(cfg.depthPollMs).toBe(15_000);
        // The broker-ceiling invariant still holds for the patient lane.
        expect(cfg.timeoutMs * (cfg.maxRetries + 1)).toBeLessThan(7_200_000);
    });

    it('a timeoutMs below 30,000 also bounds a query', () => {
        const h = makeHarness();
        const cfg = (new RabbitMQEmbedding({ ...BASE, timeoutMs: 10_000, connectFn: h.connectFn }) as any).config;
        expect(cfg.queryTimeoutMs).toBe(10_000);
    });

    it('explicit values win', () => {
        const h = makeHarness();
        const cfg = (new RabbitMQEmbedding({
            ...BASE, queryTimeoutMs: 5000, indexPriority: 2, indexDepthLimit: 0, depthPollMs: 1000,
            connectFn: h.connectFn,
        }) as any).config;
        expect(cfg.queryTimeoutMs).toBe(5000);
        expect(cfg.indexPriority).toBe(2);
        expect(cfg.indexDepthLimit).toBe(0);
        expect(cfg.depthPollMs).toBe(1000);
    });
});

describe('(iii) each message expires at its own timeout', () => {
    it('a query message expires at the query timeout and carries an AMQP timestamp', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
        const p = e.embed('where is the depth gate');
        await flush();
        expect(h.published.length).toBe(1);
        expect(h.published[0].opts.expiration).toBe('30000');
        const ts = h.published[0].opts.timestamp;
        expect(Number.isInteger(ts)).toBe(true);
        expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5);
        h.reply(0);
        await p;
    });

    it('an indexing message expires at the indexing timeout', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
        const pr = e.embedBatchPartial(['chunk']);
        await flush();
        expect(h.published.length).toBe(1);
        expect(h.published[0].opts.expiration).toBe('1700000');
        h.reply(0);
        const results = await pr;
        expect(results[0].ok).toBe(true);
    });

    it('an explicit query timeout sets the query expiration', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, queryTimeoutMs: 5000, connectFn: h.connectFn });
        const p = e.embed('q');
        await flush();
        expect(h.published[0].opts.expiration).toBe('5000');
        h.reply(0);
        await p;
    });
});

describe('(i) priority by lane', () => {
    it('a query keeps the configured priority', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, priority: 8, connectFn: h.connectFn });
        const p = e.embed('q');
        await flush();
        expect(h.published[0].task.priority).toBe(8);
        expect(h.published[0].opts.priority).toBe(8);
        h.reply(0);
        await p;
    });

    it('indexing publishes at 4 by default, whatever the query priority', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, priority: 8, connectFn: h.connectFn });
        const pr = e.embedBatchPartial(['a']);
        await flush();
        expect(h.published[0].task.priority).toBe(4);
        expect(h.published[0].opts.priority).toBe(4);
        h.reply(0);
        await pr;
    });

    it('embedBatch is indexing too, and indexPriority sets it', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({ ...BASE, priority: 8, indexPriority: 2, connectFn: h.connectFn });
        const pr = e.embedBatch(['a']);
        await flush();
        expect(h.published[0].opts.priority).toBe(2);
        h.reply(0);
        await pr;
    });
});

describe('a query is not held to the indexing backstop', () => {
    it('a default client retries a query after 30 s, not 1,700 s', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness();
            const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
            const p = e.embed('q');
            await jest.advanceTimersByTimeAsync(0);
            expect(h.published.length).toBe(1);
            await jest.advanceTimersByTimeAsync(30_000);
            await jest.advanceTimersByTimeAsync(0);
            expect(h.published.length).toBe(2);
            expect(h.published[1].task.retryCount).toBe(1);
            h.reply(1);
            await p;
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('(ii) the depth gate holds indexing, never queries', () => {
    it('indexing waits while the queue holds the limit or more, and publishes once it drains', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness(1500);
            const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
            const pr = e.embedBatchPartial(['a']);
            await jest.advanceTimersByTimeAsync(0);
            expect(h.published.length).toBe(0);
            h.setDepth(10);
            await jest.advanceTimersByTimeAsync(15_000);
            await jest.advanceTimersByTimeAsync(0);
            expect(h.published.length).toBe(1);
            h.reply(0);
            const results = await pr;
            expect(results[0].ok).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a query publishes at any depth and reads none', async () => {
        const h = makeHarness(5000);
        const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
        const p = e.embed('q');
        await flush();
        expect(h.published.length).toBe(1);
        expect(h.depthReads()).toBe(0);
        h.reply(0);
        await p;
    });

    it('a slot held past its timeout fails as WAIT-class timeout with nothing published', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness(5000);
            const e = new RabbitMQEmbedding({
                ...BASE, timeoutMs: 60_000, maxRetries: 0, connectFn: h.connectFn,
            });
            const pr = e.embedBatchPartial(['a']);
            await jest.advanceTimersByTimeAsync(60_000);
            await jest.advanceTimersByTimeAsync(0);
            const results = await pr;
            expect(results[0].ok).toBe(false);
            if (!results[0].ok) expect(results[0].reason).toBe('timeout');
            expect(h.published.length).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a limit of 0 turns the gate off', async () => {
        const h = makeHarness(5000);
        const e = new RabbitMQEmbedding({ ...BASE, indexDepthLimit: 0, connectFn: h.connectFn });
        const pr = e.embedBatchPartial(['a']);
        await flush();
        expect(h.published.length).toBe(1);
        expect(h.depthReads()).toBe(0);
        h.reply(0);
        await pr;
    });

    it('a depth that cannot be read leaves the gate open', async () => {
        const h = makeHarness(new Error('NOT_FOUND'));
        const e = new RabbitMQEmbedding({ ...BASE, connectFn: h.connectFn });
        const pr = e.embedBatchPartial(['a']);
        await flush();
        await flush();
        expect(h.published.length).toBe(1);
        h.reply(0);
        await pr;
    });

    it('concurrent slots share one depth reading', async () => {
        const h = makeHarness(0);
        const e = new RabbitMQEmbedding({ ...BASE, concurrency: 4, connectFn: h.connectFn });
        const pr = e.embedBatchPartial(['a', 'b', 'c', 'd']);
        await flush();
        expect(h.published.length).toBe(4);
        expect(h.depthReads()).toBe(1);
        for (let i = 0; i < 4; i++) h.reply(i);
        const results = await pr;
        expect(results.every((r) => r.ok)).toBe(true);
    });
});
