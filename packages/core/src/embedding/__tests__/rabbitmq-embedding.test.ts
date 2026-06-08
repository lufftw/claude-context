import { RabbitMQEmbedding } from '../rabbitmq-embedding';
import { EmbedItemResult } from '../base-embedding';

// ── Hermetic fake amqplib ────────────────────────────────────────────────
//
// The fake mirrors just enough of the amqplib surface the provider uses:
//   conn.createConfirmChannel() -> publish channel (captures published buffers)
//   conn.createChannel()        -> reply channel (assertQueue + consume)
//   conn.close / ch.close / .on
//
// `harness.deliver(taskId, replyObj)` drives a reply message into the registered
// reply consumer so tests can simulate success / malformed / wrong-dim / failure.
// `harness.lastTaskId()` returns the taskId of the most recently published task.
// `harness.publishedTasks` is the parsed list of every published task body.

interface PublishedTask {
    id: string;
    priority: number;
    retryCount: number;
    headers: { 'x-retry-count': number };
    replyTo: string;
    [k: string]: any;
}

function makeHarness() {
    const publishedTasks: PublishedTask[] = [];
    // Always points at the consumer registered by the MOST RECENT initialize().
    let consumeCallback: ((msg: any) => void) | null = null;
    let replyQueueName = 'amq.gen-fake-reply';
    // Captured connection-level event handlers (so tests can fire 'close'/'error').
    const connHandlers: Record<string, Array<(arg?: any) => void>> = {};
    // How many times assertQueue('') has been called — a proxy for "new reply
    // queue created" across (re)initializations.
    let assertQueueCount = 0;

    const noopEmitter = () => { /* on() handler — ignored in tests */ };

    const captureOn = (store: Record<string, Array<(arg?: any) => void>>) =>
        (event: string, cb: (arg?: any) => void) => {
            (store[event] ??= []).push(cb);
        };

    const publishCh: any = {
        // Channel-level handlers are not exercised by current tests; keep no-op.
        on: noopEmitter,
        publish: (_exchange: string, _queue: string, buffer: Buffer, _opts: any, cb?: (err: any) => void) => {
            const task = JSON.parse(buffer.toString('utf8')) as PublishedTask;
            publishedTasks.push(task);
            // ConfirmChannel callback signals broker ack — call it with no error.
            if (cb) cb(null);
            return true;
        },
        close: async () => { /* noop */ },
    };

    const replyCh: any = {
        on: noopEmitter,
        assertQueue: async () => {
            assertQueueCount++;
            return { queue: replyQueueName };
        },
        consume: async (_queue: string, cb: (msg: any) => void) => {
            // Re-bind to the latest consumer so deliveries after a reconnect target
            // the fresh reply queue's consumer.
            consumeCallback = cb;
            return { consumerTag: 'fake-tag' };
        },
        close: async () => { /* noop */ },
    };

    const conn: any = {
        // Capture connection 'close'/'error' handlers so tests can fire them.
        on: captureOn(connHandlers),
        createConfirmChannel: async () => publishCh,
        createChannel: async () => replyCh,
        close: async () => { /* noop */ },
    };

    const connectFn = (async () => conn) as any;

    return {
        connectFn,
        publishedTasks,
        lastTaskId: () => publishedTasks[publishedTasks.length - 1]?.id,
        taskIdAt: (i: number) => publishedTasks[i]?.id,
        setReplyQueueName: (name: string) => { replyQueueName = name; },
        // Number of times an exclusive reply queue has been asserted (assertQueue('')).
        // 1 after first init; increments to 2 after a successful reconnect.
        assertQueueCount: () => assertQueueCount,
        // Simulate the broker/transport dropping the connection: fire the captured
        // connection 'close' handler, which the provider wires to resetState(...).
        dropConnection: () => {
            const handlers = connHandlers['close'] ?? [];
            if (handlers.length === 0) throw new Error('no connection close handler captured yet');
            for (const cb of handlers) cb();
        },
        deliver: (taskId: string, reply: any) => {
            if (!consumeCallback) throw new Error('consumer not registered yet');
            const content = Buffer.from(JSON.stringify({ taskId, ...reply }));
            consumeCallback({ content });
        },
        // Deliver a raw (non-JSON-parseable as our shape) content buffer.
        deliverRaw: (buffer: Buffer) => {
            if (!consumeCallback) throw new Error('consumer not registered yet');
            consumeCallback({ content: buffer });
        },
    };
}

function makeVector(dim: number): number[] {
    // Build a unit-norm vector: first component 1, rest 0 -> norm == 1.0.
    const v = new Array(dim).fill(0);
    v[0] = 1;
    return v;
}

const DIM = 8;

describe('Edit B — patient default + maxRetries invariant', () => {
    it('default timeoutMs is the patient backstop and satisfies the broker-ceiling invariant', () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x',
            queue: 'q',
            modelName: 'm',
            dimension: DIM,
            connectFn: h.connectFn,
        });
        const cfg = (e as any).config;
        expect(cfg.timeoutMs).toBe(1_700_000);
        expect(cfg.maxRetries).toBe(3);
        // Broker consumer_timeout is 2h = 7_200_000ms. Every attempt (initial + retries)
        // must fit under that ceiling so a slow worker never exceeds the broker timeout.
        expect(cfg.timeoutMs * (cfg.maxRetries + 1)).toBeLessThan(7_200_000);
    });

    it('honours explicit overrides for timeoutMs and maxRetries', () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            timeoutMs: 12345, maxRetries: 1, connectFn: h.connectFn,
        });
        const cfg = (e as any).config;
        expect(cfg.timeoutMs).toBe(12345);
        expect(cfg.maxRetries).toBe(1);
    });
});

describe('Edit C — tagged fault reasons', () => {
    it('worker failure reply rejects with embedReason=worker-error', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r)); // let publish happen
        const taskId = h.lastTaskId();
        h.deliver(taskId, { success: false, error: 'boom' });
        await expect(p).rejects.toMatchObject({ embedReason: 'worker-error' });
        expect((e as any).pending.size).toBe(0);
    });

    it('unparseable content rejects with embedReason=malformed', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        const taskId = h.lastTaskId();
        h.deliver(taskId, { success: true, content: 'not-json{' });
        await expect(p).rejects.toMatchObject({ embedReason: 'malformed' });
    });

    it('empty/malformed vectors reject with embedReason=malformed', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        const taskId = h.lastTaskId();
        h.deliver(taskId, { success: true, content: '[]' });
        await expect(p).rejects.toMatchObject({ embedReason: 'malformed' });
    });

    it('close() rejects pending with embedReason=shutdown (non-retryable)', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 3, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        await e.close();
        await expect(p).rejects.toMatchObject({ embedReason: 'shutdown' });
    });
});

describe('Edit D — Layer-0 dimension/norm guard', () => {
    it('a wrong-dimension reply rejects with embedReason=bad-dimension and does NOT resolve', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        const taskId = h.lastTaskId();
        // Reply with a vector of the WRONG length (DIM-1).
        const wrong = makeVector(DIM - 1);
        h.deliver(taskId, { success: true, content: JSON.stringify([wrong]) });
        await expect(p).rejects.toMatchObject({ embedReason: 'bad-dimension' });
        expect((e as any).pending.size).toBe(0);
    });

    it('a right-dimension unit-norm reply resolves', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        const taskId = h.lastTaskId();
        h.deliver(taskId, { success: true, content: JSON.stringify([makeVector(DIM)]) });
        const out = await p;
        expect(out.vector.length).toBe(DIM);
        expect(out.dimension).toBe(DIM);
    });
});

describe('Edit E — sendOneWithRetry (bounded retry-via-republish)', () => {
    it('times out, retries, then succeeds: exactly 2 publishes, pending empty', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness();
            const e = new RabbitMQEmbedding({
                url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
                timeoutMs: 1000, maxRetries: 3, connectFn: h.connectFn,
            });
            const p = e.embed('hello');
            // Let initialize() + first publish complete.
            await jest.advanceTimersByTimeAsync(0);
            expect(h.publishedTasks.length).toBe(1);
            // First attempt times out.
            await jest.advanceTimersByTimeAsync(1000);
            // Retry should have published a second task.
            await jest.advanceTimersByTimeAsync(0);
            expect(h.publishedTasks.length).toBe(2);
            // Deliver a good reply for the SECOND task.
            const secondId = h.taskIdAt(1);
            h.deliver(secondId, { success: true, content: JSON.stringify([makeVector(DIM)]) });
            const out = await p;
            expect(out.vector.length).toBe(DIM);
            expect((e as any).pending.size).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });

    it('REAL worker-error is NOT retried: exactly 1 publish, rejects', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 3, connectFn: h.connectFn,
        });
        const p = e.embed('hello');
        await new Promise((r) => setImmediate(r));
        expect(h.publishedTasks.length).toBe(1);
        const taskId = h.lastTaskId();
        h.deliver(taskId, { success: false, error: 'permanent' });
        await expect(p).rejects.toMatchObject({ embedReason: 'worker-error' });
        expect(h.publishedTasks.length).toBe(1);
        expect((e as any).pending.size).toBe(0);
    });

    it('retry stamps the attempt index into retryCount / x-retry-count', async () => {
        jest.useFakeTimers();
        try {
            const h = makeHarness();
            const e = new RabbitMQEmbedding({
                url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
                timeoutMs: 1000, maxRetries: 3, connectFn: h.connectFn,
            });
            const p = e.embed('hello');
            await jest.advanceTimersByTimeAsync(0);
            await jest.advanceTimersByTimeAsync(1000); // first times out
            await jest.advanceTimersByTimeAsync(0);    // retry published
            expect(h.publishedTasks[0].retryCount).toBe(0);
            expect(h.publishedTasks[0].headers['x-retry-count']).toBe(0);
            expect(h.publishedTasks[1].retryCount).toBe(1);
            expect(h.publishedTasks[1].headers['x-retry-count']).toBe(1);
            // Resolve to avoid dangling.
            h.deliver(h.taskIdAt(1), { success: true, content: JSON.stringify([makeVector(DIM)]) });
            await p;
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('Edit G — connection-lost (WAIT-class) retries re-establish the connection', () => {
    it('a mid-flight connection drop re-initializes and the retry resolves on the NEW reply queue', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 3, connectFn: h.connectFn,
        });

        const p = e.embed('x');
        // Let initialize() (#1) + first publish complete.
        await new Promise((r) => setImmediate(r));
        expect(h.publishedTasks.length).toBe(1);
        expect(h.assertQueueCount()).toBe(1); // first exclusive reply queue asserted

        // Simulate a transient connection drop INSTEAD of replying. resetState rejects
        // the pending with embedReason='connection-lost' (WAIT class → retryable) and
        // nulls publishCh/replyQueue + isInitialized=false.
        h.setReplyQueueName('amq.gen-fake-reply-2');
        h.dropConnection();

        // The retry must re-initialize: a SECOND assertQueue('') (new reply queue) and a
        // SECOND publish. Let the retry loop run initialize() (#2) + republish.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(h.assertQueueCount()).toBe(2); // reconnect created a fresh reply queue
        expect(h.publishedTasks.length).toBe(2);
        // The republished task targets the NEW reply queue.
        expect(h.publishedTasks[1].replyTo).toBe('amq.gen-fake-reply-2');

        // Deliver a good reply to the NEW reply queue's consumer for the SECOND task.
        h.deliver(h.taskIdAt(1), { success: true, content: JSON.stringify([makeVector(DIM)]) });

        // It RESOLVES with a valid vector — and never throws the opaque "not initialized".
        const out = await p;
        expect(out.vector.length).toBe(DIM);
        expect(out.dimension).toBe(DIM);
        expect((e as any).pending.size).toBe(0);
    });

    it('embedBatchPartial recovers a single slot after a connection drop (resolves, not "not initialized")', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 3, concurrency: 1, connectFn: h.connectFn,
        });

        const pr = e.embedBatchPartial(['only']);
        await new Promise((r) => setImmediate(r));
        expect(h.publishedTasks.length).toBe(1);

        // Drop instead of replying → connection-lost → retry re-initializes.
        h.dropConnection();
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(h.publishedTasks.length).toBe(2);

        h.deliver(h.taskIdAt(1), { success: true, content: JSON.stringify([makeVector(DIM)]) });
        const results = await pr;
        expect(results.length).toBe(1);
        expect(results[0].ok).toBe(true);
        if (results[0].ok) expect(results[0].vector.length).toBe(DIM);
    });
});

describe('Edit F — embedBatchPartial (partial tolerance, never zero-vector)', () => {
    it('one malformed slot fails in place; others succeed with right-dimension vectors', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, concurrency: 10, connectFn: h.connectFn,
        });
        const pr = e.embedBatchPartial(['a', 'b', 'c']);
        // Let initialize + all three publishes happen.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        expect(h.publishedTasks.length).toBe(3);
        // Slot 0 -> good, slot 1 -> malformed, slot 2 -> good. Match by task order
        // because the worker pool publishes index 0,1,2 in order.
        h.deliver(h.taskIdAt(0), { success: true, content: JSON.stringify([makeVector(DIM)]) });
        h.deliver(h.taskIdAt(1), { success: true, content: 'garbage{' });
        h.deliver(h.taskIdAt(2), { success: true, content: JSON.stringify([makeVector(DIM)]) });
        const results: EmbedItemResult[] = await pr;
        expect(results.length).toBe(3);

        const r0 = results[0];
        const r1 = results[1];
        const r2 = results[2];
        expect(r0.ok).toBe(true);
        expect(r2.ok).toBe(true);
        if (r0.ok) expect(r0.vector.length).toBe(DIM);
        if (r2.ok) expect(r2.vector.length).toBe(DIM);
        expect(r1.ok).toBe(false);
        if (!r1.ok) expect(r1.reason).toBe('malformed');

        // No result is an empty / zero vector.
        for (const r of results) {
            if (r.ok) {
                expect(r.vector.length).toBeGreaterThan(0);
                expect(r.vector.some((x) => x !== 0)).toBe(true);
            }
        }
    });

    it('preserves index alignment with the input array', async () => {
        const h = makeHarness();
        const e = new RabbitMQEmbedding({
            url: 'amqp://x', queue: 'q', modelName: 'm', dimension: DIM,
            maxRetries: 0, concurrency: 10, connectFn: h.connectFn,
        });
        const pr = e.embedBatchPartial(['x', 'y']);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        h.deliver(h.taskIdAt(0), { success: true, content: JSON.stringify([makeVector(DIM)]) });
        h.deliver(h.taskIdAt(1), { success: false, error: 'boom' });
        const results = await pr;
        expect(results[0].index).toBe(0);
        expect(results[1].index).toBe(1);
        expect(results[0].ok).toBe(true);
        expect(results[1].ok).toBe(false);
        if (!results[1].ok) expect(results[1].reason).toBe('worker-error');
    });
});
