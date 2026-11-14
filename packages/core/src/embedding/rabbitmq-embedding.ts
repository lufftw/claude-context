import amqplib, { type ChannelModel, type Channel, type ConfirmChannel } from 'amqplib';

/**
 * Return `url` with `heartbeat=<seconds>` in its query, unless the URL already sets one
 * (an explicit `?heartbeat=` in RABBITMQ_INFERENCE_URL wins). Credentials and vhost are
 * preserved. Non-parseable URLs are returned unchanged so amqplib reports the real error.
 */
export function withHeartbeat(url: string, seconds: number | undefined): string {
    if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return url;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url;
    }
    if (parsed.searchParams.has('heartbeat')) return url;
    parsed.searchParams.set('heartbeat', String(Math.floor(seconds)));
    return parsed.toString();
}
import { randomUUID } from 'node:crypto';
import { Embedding, EmbeddingVector, EmbedItemResult, EmbedReason, WAIT_REASONS } from './base-embedding';
import { CONNECT_BACKOFF_MS, CONTEXT_BUSY_BACKOFF_MS, MAX_OVERSIZE_CUTS, isContextBusy, shortenForContextLimit } from './oversize-retry';

/**
 * RabbitMQEmbedding
 *
 * Publishes embedding requests via RPC-over-RabbitMQ to a pre-existing
 * inference worker (e.g. qwen3-embedding-8b running on a remote GPU server
 * consuming the `embedding.qwen3-8b` queue in the `inference` vhost).
 *
 * Designed to interoperate with the event-search-service / event-crawler
 * inference queue architecture. Shares the same task schema and reply
 * format:
 *
 *   Request  (to `<queue>`):
 *     {
 *       id, type:'embedding', model, createdAt, traceId, source,
 *       priority, replyTo, correlationId,
 *       prompt,                               // single-text shortcut
 *       retryCount: 0,
 *       headers: { 'x-retry-count':0, 'x-first-attempt-at': <ms> },
 *       payload: { texts:[<text>], normalize:true, truncate:'end' }
 *     }
 *
 *   Reply    (on exclusive <replyQueue>):
 *     { taskId, success, content: '[[0.1,...]]', durationMs }
 *     or legacy { taskId, embeddings: [[...]] }
 *
 * Dimension is fixed by configuration — we do not probe the worker for it,
 * which keeps initialization fast and avoids a cold-path embed() round-trip
 * just to learn the dimension.
 */
export interface RabbitMQEmbeddingConfig {
    /** Full AMQP URL, e.g. amqp://user:pass@host:5672/inference */
    url: string;
    /** Target inference queue, e.g. 'embedding.qwen3-8b' */
    queue: string;
    /** Logical model name passed in the task body, e.g. 'qwen3-embedding-8b' */
    modelName: string;
    /** Vector dimension produced by the worker (Qwen3-8b = 4096) */
    dimension: number;
    /**
     * Per-request liveness timeout in ms (default 1_700_000 ≈ 28 min — patient backstop).
     * The message carries no AMQP `expiration`: the shared queue dead-letters expired
     * messages into dlq.failed, so staleness is left to the worker side.
     */
    timeoutMs?: number;
    /**
     * Accepted for configuration compatibility and no longer used: a chunk is never
     * re-published after a timeout or a connection fault (see sendOneWithRetry). The
     * oversize-cut, busy-context and broker-unreachable resends have their own budgets.
     * @deprecated has no effect
     */
    maxRetries?: number;
    /**
     * RabbitMQ priority (0-10), default 2: code-search embeds sit below the event pipeline's
     * traffic on the shared queue. An explicit value is honoured as given.
     */
    priority?: number;
    /** Parallel in-flight requests for embedBatch (default 10) */
    concurrency?: number;
    /** AMQP heartbeat seconds (default 60) */
    heartbeat?: number;
    /** Source identifier included in the task body */
    source?: string;
    /** Injectable factory for tests */
    connectFn?: typeof amqplib.connect;
}

interface PendingRequest {
    resolve: (vector: number[]) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

export class RabbitMQEmbedding extends Embedding {
    protected maxTokens: number = 8192;
    private readonly config: Required<Omit<RabbitMQEmbeddingConfig, 'connectFn'>> & Pick<RabbitMQEmbeddingConfig, 'connectFn'>;
    private conn: ChannelModel | null = null;
    private publishCh: ConfirmChannel | null = null;
    private replyCh: Channel | null = null;
    private replyQueue: string | null = null;
    private pending: Map<string, PendingRequest> = new Map();
    private initPromise: Promise<void> | null = null;
    private isInitialized: boolean = false;

    constructor(config: RabbitMQEmbeddingConfig) {
        super();
        if (!config.url) throw new Error('RabbitMQEmbedding: url is required');
        if (!config.queue) throw new Error('RabbitMQEmbedding: queue is required');
        if (!config.modelName) throw new Error('RabbitMQEmbedding: modelName is required');
        if (!config.dimension || config.dimension <= 0) {
            throw new Error('RabbitMQEmbedding: dimension must be a positive integer');
        }
        this.config = {
            url: config.url,
            queue: config.queue,
            modelName: config.modelName,
            dimension: config.dimension,
            timeoutMs: config.timeoutMs ?? 1_700_000,
            maxRetries: config.maxRetries ?? 3,
            priority: config.priority ?? 2,
            concurrency: config.concurrency ?? 10,
            heartbeat: config.heartbeat ?? 60,
            source: config.source ?? 'claude-context',
            connectFn: config.connectFn,
        };
    }

    // ── Lifecycle ────────────────────────────────────────────

    /**
     * Idempotent, mutex-protected connection + reply queue setup.
     * Thundering-herd guard: concurrent first-calls all await the same in-flight init.
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) return;
        if (this.initPromise) return this.initPromise;

        this.initPromise = this._doInitialize();
        try {
            await this.initPromise;
        } finally {
            this.initPromise = null;
        }
    }

    private async _doInitialize(): Promise<void> {
        const connect = this.config.connectFn ?? amqplib.connect;
        // amqplib reads `heartbeat` only from the URL query (or a Connect object), never from
        // socket options; passing it there was silently ignored (1.x then disabled heartbeats).
        const conn = await connect(withHeartbeat(this.config.url, this.config.heartbeat), {
            clientProperties: {
                product: 'claude-context',
                information: 'RabbitMQEmbedding publisher',
            },
        });
        this.conn = conn;

        conn.on('error', (err: Error) => {
            console.error(`[RabbitMQEmbedding] connection error: ${err.message}`);
        });
        conn.on('close', () => this.resetState('RabbitMQ connection closed'));

        // Publisher: ConfirmChannel for durable publishing
        const pubCh = await conn.createConfirmChannel();
        pubCh.on('error', (err: Error) => {
            console.error(`[RabbitMQEmbedding] publish channel error: ${err.message}`);
        });
        pubCh.on('close', () => this.resetState('Publish channel closed'));
        this.publishCh = pubCh;

        // Reply consumer: dedicated Channel so a consumer-cancellation
        // on the reply queue does not kill the publisher channel.
        const rCh = await conn.createChannel();
        rCh.on('error', (err: Error) => {
            console.error(`[RabbitMQEmbedding] reply channel error: ${err.message}`);
        });
        rCh.on('close', () => this.resetState('Reply channel closed'));
        this.replyCh = rCh;

        const q = await rCh.assertQueue('', { exclusive: true, autoDelete: true });
        this.replyQueue = q.queue;

        await rCh.consume(
            this.replyQueue,
            (msg) => {
                if (!msg) {
                    // Consumer cancelled by broker (e.g. queue deleted)
                    this.resetState('Reply consumer cancelled');
                    return;
                }
                try {
                    const raw = JSON.parse(msg.content.toString('utf8')) as {
                        taskId?: string;
                        success?: boolean;
                        content?: string;
                        embeddings?: number[][];
                        error?: string;
                    };
                    const taskId = raw.taskId;
                    if (!taskId) return;

                    const pending = this.pending.get(taskId);
                    if (!pending) return; // Stale or unknown taskId — drop silently

                    clearTimeout(pending.timer);
                    this.pending.delete(taskId);

                    if (raw.success === false) {
                        pending.reject(Object.assign(
                            new Error(raw.error || 'Embedding worker returned failure'),
                            { embedReason: 'worker-error' as EmbedReason }));
                        return;
                    }

                    let vectors: number[][] | null = null;
                    if (raw.content) {
                        try {
                            vectors = JSON.parse(raw.content) as number[][];
                        } catch (err) {
                            pending.reject(Object.assign(
                                new Error(`Failed to parse reply content JSON: ${(err as Error).message}`),
                                { embedReason: 'malformed' as EmbedReason }));
                            return;
                        }
                    } else if (Array.isArray(raw.embeddings)) {
                        vectors = raw.embeddings;
                    }

                    if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
                        pending.reject(Object.assign(
                            new Error('Empty or malformed embedding response'),
                            { embedReason: 'malformed' as EmbedReason }));
                        return;
                    }

                    // ── Layer-0 dimension/norm guard ──────────────────────────
                    // Never emit a zero/wrong-dimension vector. Loop-sum the norm;
                    // NEVER Math.hypot(...v) — a 4096-arg spread throws RangeError.
                    const v = vectors[0];
                    let sumSq = 0;
                    for (let k = 0; k < v.length; k++) sumSq += v[k] * v[k];
                    const norm = Math.sqrt(sumSq);
                    if (v.length !== this.config.dimension || !(norm > 0.5 && norm < 2.0)) {
                        pending.reject(Object.assign(
                            new Error(`bad embedding: len=${v.length} expected=${this.config.dimension} norm=${norm.toFixed(3)}`),
                            { embedReason: 'bad-dimension' as EmbedReason }));
                        return;
                    }
                    pending.resolve(v);
                } catch (err) {
                    console.error(`[RabbitMQEmbedding] reply parse error: ${(err as Error).message}`);
                }
            },
            { noAck: true }
        );

        this.isInitialized = true;
        // Library-boundary stdout safety: @zilliz/claude-context-core is a standalone
        // library and must not rely on the MCP entry-point's console shim to keep
        // stdout (JSON-RPC) clean — diagnostics go to stderr.
        console.error(
            `[RabbitMQEmbedding] ✅ initialized — queue=${this.config.queue}, model=${this.config.modelName}, dim=${this.config.dimension}, replyQueue=${this.replyQueue}`
        );
    }

    /**
     * Idempotent state reset. Rejects all pending requests so callers see
     * a prompt failure instead of waiting for the per-request timeout.
     */
    private resetState(reason: string, embedClass: EmbedReason = 'connection-lost'): void {
        if (!this.isInitialized && !this.replyQueue && this.pending.size === 0) return;
        console.warn(`[RabbitMQEmbedding] reset: ${reason}`);
        this.isInitialized = false;
        this.replyQueue = null;

        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(Object.assign(
                new Error(`RabbitMQEmbedding reset: ${reason}`),
                { embedReason: embedClass }));
        }
        this.pending.clear();

        // Null out refs — amqplib will emit close events which are fine to ignore
        this.replyCh = null;
        this.publishCh = null;
        this.conn = null;
    }

    /** Graceful shutdown — closes channels and connection. */
    async close(): Promise<void> {
        try { if (this.replyCh) await this.replyCh.close(); } catch { /* ignore */ }
        try { if (this.publishCh) await this.publishCh.close(); } catch { /* ignore */ }
        try { if (this.conn) await this.conn.close(); } catch { /* ignore */ }
        this.resetState('Explicit close', 'shutdown');
    }

    // ── Embedding API ────────────────────────────────────────

    async embed(text: string): Promise<EmbeddingVector> {
        await this.initialize();
        const processed = this.preprocessText(text);
        const vector = await this.sendOneWithRetry(processed);
        return { vector, dimension: this.config.dimension };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        await this.initialize();
        const processed = this.preprocessTexts(texts);
        const out: EmbeddingVector[] = new Array(processed.length);

        // Bounded concurrency — publish up to `concurrency` tasks in flight at once.
        const workers = Math.min(this.config.concurrency, processed.length);
        let cursor = 0;

        const runWorker = async (): Promise<void> => {
            while (true) {
                const idx = cursor++;
                if (idx >= processed.length) return;
                const vector = await this.sendOne(processed[idx]);
                out[idx] = { vector, dimension: this.config.dimension };
            }
        };

        const tasks: Promise<void>[] = [];
        for (let i = 0; i < workers; i++) tasks.push(runWorker());
        await Promise.all(tasks);
        return out;
    }

    /**
     * Partial-tolerant batch embed. Same bounded worker-pool as embedBatch but
     * over sendOneWithRetry, returning index-aligned results. A failed slot
     * carries a tagged reason — it NEVER pushes an empty or zero vector, so the
     * indexer can skip just that chunk without corrupting the collection.
     */
    async embedBatchPartial(texts: string[]): Promise<EmbedItemResult[]> {
        await this.initialize();
        const processed = this.preprocessTexts(texts);
        const out: EmbedItemResult[] = new Array(processed.length);

        const workers = Math.min(this.config.concurrency, processed.length);
        let cursor = 0;

        const runWorker = async (): Promise<void> => {
            while (true) {
                const idx = cursor++;
                if (idx >= processed.length) return;
                try {
                    const vector = await this.sendOneWithRetry(processed[idx]);
                    // Defense-in-depth: re-check dimension at the boundary.
                    if (vector.length !== this.config.dimension) {
                        out[idx] = { ok: false, index: idx, reason: 'bad-dimension' };
                    } else {
                        out[idx] = { ok: true, index: idx, vector, dimension: vector.length };
                    }
                } catch (err) {
                    const reason = (err as { embedReason?: EmbedReason }).embedReason ?? 'worker-error';
                    out[idx] = { ok: false, index: idx, reason, detail: (err as Error).message };
                }
            }
        };

        const tasks: Promise<void>[] = [];
        for (let i = 0; i < workers; i++) tasks.push(runWorker());
        await Promise.all(tasks);
        return out;
    }

    async detectDimension(_testText: string = 'test'): Promise<number> {
        // Dimension is declared by config — no network probe.
        return this.config.dimension;
    }

    getDimension(): number {
        return this.config.dimension;
    }

    getProvider(): string {
        return 'RabbitMQ';
    }

    // ── Internals ────────────────────────────────────────────

    /**
     * Resend wrapper around sendOne. A chunk is re-published only when no earlier copy of
     * it can still be in the queue:
     *   - after a definite failure reply from the worker (oversize cut, busy context): the
     *     worker consumed that message and answered it;
     *   - when the broker could not be reached at all (embedConnectFailure): nothing was
     *     published yet.
     * Every other fault fails the chunk without a resend. In particular a timeout, a
     * connection or channel loss after the publish, and a failed publish confirm all leave
     * the earlier message possibly queued (it is persistent and unacked), so re-publishing
     * under a fresh id would put a second live copy of the chunk on the shared queue. The
     * caller sees the fault (timeout / connection-lost) and decides.
     */
    private async sendOneWithRetry(text: string): Promise<number[]> {
        let cuts = 0;
        let busyResends = 0;
        let connectRetries = 0;
        for (;;) {
            try {
                return await this.sendOne(text, 0);
            } catch (err) {
                const reason = (err as { embedReason?: EmbedReason }).embedReason;
                // A chunk longer than the worker's context is a property of that chunk, not a worker fault: shorten it from
                // the limit the worker reports and send it again (bounded). The worker answered the first message.
                if (reason === 'worker-error' && cuts < MAX_OVERSIZE_CUTS) {
                    const shorter = shortenForContextLimit(text, (err as Error).message ?? '');
                    if (shorter !== null) {
                        cuts++;
                        console.error(`[RabbitMQEmbedding] chunk over the worker context; cut ${text.length} -> ${shorter.length} chars (${cuts}/${MAX_OVERSIZE_CUTS})`);
                        text = shorter;
                        continue;
                    }
                }
                // Momentary context pressure on a busy worker: resend after a growing pause (own bounded budget). The worker answered.
                if (reason === 'worker-error' && busyResends < CONTEXT_BUSY_BACKOFF_MS.length && isContextBusy((err as Error).message ?? '')) {
                    const pause = CONTEXT_BUSY_BACKOFF_MS[busyResends++] * (0.75 + Math.random() * 0.5);
                    console.error(`[RabbitMQEmbedding] worker context busy; resend ${busyResends}/${CONTEXT_BUSY_BACKOFF_MS.length} after ${Math.round(pause)} ms`);
                    await new Promise((resolve) => setTimeout(resolve, pause));
                    continue;
                }
                // The broker could not be reached at all (restart, network switch, socket closed in the handshake): nothing was
                // published, so wait it out on its own growing budget and try again.
                if ((err as { embedConnectFailure?: boolean }).embedConnectFailure && connectRetries < CONNECT_BACKOFF_MS.length) {
                    const pause = CONNECT_BACKOFF_MS[connectRetries++] * (0.75 + Math.random() * 0.5);
                    console.error(`[RabbitMQEmbedding] broker unreachable (${(err as Error).message}); reconnect ${connectRetries}/${CONNECT_BACKOFF_MS.length} after ${Math.round(pause)} ms`);
                    await new Promise((resolve) => setTimeout(resolve, pause));
                    continue;
                }
                if (reason && WAIT_REASONS.has(reason)) {
                    console.error(`[RabbitMQEmbedding] ${reason}: not re-publishing (an earlier copy may still be queued)`);
                }
                throw err;
            }
        }
    }

    private async sendOne(text: string, attempt: number = 0): Promise<number[]> {
        // Re-establish after a resetState (idempotent + mutex-guarded) so the next chunk
        // can recover from a transient connection/channel drop. Each call to sendOne reads
        // the NEW this.replyQueue at publish time.
        try {
            await this.initialize();
        } catch (err) {
            // Not being able to open the connection says nothing about the chunk: it is a wait-class fault, never a real one.
            throw Object.assign(err instanceof Error ? err : new Error(String(err)), { embedReason: 'connection-lost' as EmbedReason, embedConnectFailure: true });
        }
        // Defensive post-init assertion: initialize() above guarantees these are set
        // on the happy path; this guards against a drop racing in between.
        if (!this.publishCh || !this.replyQueue) {
            throw new Error('RabbitMQEmbedding: not initialized');
        }
        const taskId = randomUUID();
        const now = Date.now();

        const task = {
            id: taskId,
            type: 'embedding' as const,
            model: this.config.modelName,
            createdAt: now,
            traceId: `${this.config.source}-${now}-${taskId.slice(0, 8)}`,
            source: this.config.source,
            priority: this.config.priority,
            replyTo: this.replyQueue,
            correlationId: taskId,
            prompt: text,
            retryCount: attempt,
            headers: {
                'x-retry-count': attempt,
                'x-first-attempt-at': now,
            },
            payload: {
                texts: [text],
                normalize: true,
                truncate: 'end' as const,
            },
        };

        const buffer = Buffer.from(JSON.stringify(task));
        const publishCh = this.publishCh;
        const replyQueue = this.replyQueue;

        return new Promise<number[]>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(taskId)) {
                    reject(Object.assign(
                        new Error(`Embedding timeout after ${this.config.timeoutMs}ms (queue=${this.config.queue})`),
                        { embedReason: 'timeout' as EmbedReason }));
                }
            }, this.config.timeoutMs);

            this.pending.set(taskId, { resolve, reject, timer });

            // Default exchange, route by queue name — matches event-search-service pattern
            publishCh.publish(
                '',
                this.config.queue,
                buffer,
                {
                    persistent: true,
                    contentType: 'application/json',
                    correlationId: taskId,
                    replyTo: replyQueue,
                    messageId: taskId,
                    priority: this.config.priority,
                },
                (err) => {
                    if (err) {
                        clearTimeout(timer);
                        this.pending.delete(taskId);
                        reject(err);
                    }
                }
            );
        });
    }
}
