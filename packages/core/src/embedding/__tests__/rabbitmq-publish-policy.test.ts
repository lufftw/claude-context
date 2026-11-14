import { RabbitMQEmbedding } from '../rabbitmq-embedding';

// CC-EMBED-FIX-1114: code-search embeds must not flood the shared queue.
//   1. default publish priority is 2
//   2. every publish carries an AMQP `expiration` equal to String(timeoutMs)
//   3. no path re-publishes a chunk while an earlier copy of it can still be queued

interface Published {
    task: { id: string; [k: string]: any };
    opts: { priority?: number; expiration?: string; messageId?: string; persistent?: boolean; [k: string]: any };
}

function makeHarness() {
    const published: Published[] = [];
    let consumeCallback: ((msg: any) => void) | null = null;
    let replyQueueName = 'amq.gen-fake-reply';
    const connHandlers: Record<string, Array<(arg?: any) => void>> = {};
    let publishError: Error | null = null;

    const publishCh: any = {
        on: () => undefined,
        publish: (_x: string, _q: string, buffer: Buffer, opts: any, cb?: (err: any) => void) => {
            published.push({ task: JSON.parse(buffer.toString('utf8')), opts });
            if (cb) cb(publishError);
            return true;
        },
        close: async () => undefined,
    };
    const replyCh: any = {
        on: () => undefined,
        assertQueue: async () => ({ queue: replyQueueName }),
        consume: async (_q: string, cb: (msg: any) => void) => { consumeCallback = cb; return { consumerTag: 't' }; },
        close: async () => undefined,
    };
    const conn: any = {
        on: (event: string, cb: (arg?: any) => void) => { (connHandlers[event] ??= []).push(cb); },
        createConfirmChannel: async () => publishCh,
        createChannel: async () => replyCh,
        close: async () => undefined,
    };
    return {
        connectFn: (async () => conn) as any,
        published,
        setReplyQueueName: (n: string) => { replyQueueName = n; },
        failNextPublishes: (err: Error | null) => { publishError = err; },
        dropConnection: () => { for (const cb of connHandlers['close'] ?? []) cb(); },
        deliver: (taskId: string, reply: any) => {
            consumeCallback!({ content: Buffer.from(JSON.stringify({ taskId, ...reply })) });
        },
    };
}

const DIM = 8;
const unit = () => { const v = new Array(DIM).fill(0); v[0] = 1; return v; };
const ok = () => ({ success: true, content: JSON.stringify([unit()]) });
const base = (h: ReturnType<typeof makeHarness>, extra: object = {}) => ({
    url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM, connectFn: h.connectFn, ...extra,
});

describe('publish policy: priority and expiration', () => {
    let errSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

    it('defaults to priority 2, in the config, the message options and the task body', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h));
        expect((e as any).config.priority).toBe(2);
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        expect(h.published).toHaveLength(1);
        expect(h.published[0].opts.priority).toBe(2);
        expect(h.published[0].task.priority).toBe(2);
        h.deliver(h.published[0].task.id, ok());
        await p;
    });

    it('an explicit priority still wins over the default', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h, { priority: 7 }));
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        expect(h.published[0].opts.priority).toBe(7);
        h.deliver(h.published[0].task.id, ok());
        await p;
    });

    it('expiration is String(timeoutMs) by default', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h));
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        expect(h.published[0].opts.expiration).toBe('1700000');
        h.deliver(h.published[0].task.id, ok());
        await p;
    });

    it('expiration follows an explicit timeoutMs, for embed and for embedBatch', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h, { timeoutMs: 12345 }));
        const p = e.embedBatch(['a', 'b']);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(h.published).toHaveLength(2);
        for (const m of h.published) expect(m.opts.expiration).toBe('12345');
        for (const m of h.published) h.deliver(m.task.id, ok());
        await p;
    });
});

describe('publish policy: no path re-publishes while a copy can still be queued', () => {
    let errSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;
    beforeEach(() => {
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => { errSpy.mockRestore(); warnSpy.mockRestore(); });

    it('a timeout produces exactly one publish for the chunk and then fails as timeout', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness();
            const e = new RabbitMQEmbedding(base(h, { timeoutMs: 1000, maxRetries: 3 }));
            const p = e.embed('hello');
            const settled = expect(p).rejects.toMatchObject({ embedReason: 'timeout' });
            await jest.advanceTimersByTimeAsync(0);
            expect(h.published).toHaveLength(1);
            await jest.advanceTimersByTimeAsync(1000);
            await jest.advanceTimersByTimeAsync(600_000); // far past any plausible retry pause
            await settled;
            expect(h.published).toHaveLength(1);
            expect((e as any).pending.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('embedBatchPartial reports the timed-out slot as timeout, with one publish', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness();
            const e = new RabbitMQEmbedding(base(h, { timeoutMs: 1000, maxRetries: 3, concurrency: 1 }));
            const pr = e.embedBatchPartial(['only']);
            await jest.advanceTimersByTimeAsync(0);
            await jest.advanceTimersByTimeAsync(1000);
            await jest.advanceTimersByTimeAsync(600_000);
            const results = await pr;
            expect(results[0]).toMatchObject({ ok: false, reason: 'timeout' });
            expect(h.published).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('a connection drop after the publish fails the chunk as connection-lost, with one publish', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h, { maxRetries: 3 }));
        const p = e.embed('x');
        const settled = expect(p).rejects.toMatchObject({ embedReason: 'connection-lost' });
        await new Promise((r) => setImmediate(r));
        expect(h.published).toHaveLength(1);
        h.dropConnection();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        await settled;
        expect(h.published).toHaveLength(1);
    });

    it('a failed publish confirm is not re-published', async () => {
        const h = makeHarness();
        h.failNextPublishes(new Error('channel closed'));
        const e = new RabbitMQEmbedding(base(h, { maxRetries: 3 }));
        await expect(e.embed('x')).rejects.toBeInstanceOf(Error);
        await new Promise((r) => setImmediate(r));
        expect(h.published).toHaveLength(1);
    });

    it('a worker failure reply that is not a cut or busy case is not re-published', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h, { maxRetries: 3 }));
        const p = e.embed('x');
        await new Promise((r) => setImmediate(r));
        h.deliver(h.published[0].task.id, { success: false, error: 'permanent' });
        await expect(p).rejects.toMatchObject({ embedReason: 'worker-error' });
        expect(h.published).toHaveLength(1);
    });

    it('the oversize cut resends only after the worker answered the first message, never before', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding(base(h));
        const p = e.embed('x'.repeat(5000));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        // nothing answered yet: exactly one live copy
        expect(h.published).toHaveLength(1);
        // a definite failure reply means the worker consumed the first message
        h.deliver(h.published[0].task.id, {
            success: false,
            error: 'request (4000 tokens) exceeds the available context size (2048 tokens)',
        });
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(h.published).toHaveLength(2);
        expect(h.published[1].task.id).not.toBe(h.published[0].task.id);
        expect(h.published[1].task.prompt.length).toBeLessThan(5000);
        h.deliver(h.published[1].task.id, ok());
        await p;
    });
});
