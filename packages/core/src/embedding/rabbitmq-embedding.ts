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
     * Per-request liveness timeout in ms for indexing (`embedBatch`, `embedBatchPartial`)
     * (default 1_700_000 ≈ 28 min — patient backstop). Each indexing message also
     * expires at this age, so an abandoned request never waits in the queue for a worker.
     */
    timeoutMs?: number;
    /**
     * Max retry-via-republish attempts for WAIT-class faults, both lanes (default 3).
     * Invariant: timeoutMs * (maxRetries + 1) must stay under the broker
     * consumer_timeout (2h = 7_200_000ms) so a slow worker never exceeds it.
     */
    maxRetries?: number;
    /**
     * Per-request timeout in ms for a search query's embedding (`embed()`).
     * Default: the smaller of timeoutMs and 30_000, so a search waits seconds, never the
     * indexing backstop. Each query message also expires at this age.
     */
    queryTimeoutMs?: number;
    /** RabbitMQ priority (0-10) for a search query's embedding (`embed()`). Default 5. */
    priority?: number;
    /**
     * RabbitMQ priority (0-10) for indexing (`embedBatch`, `embedBatchPartial`). Default 4:
     * below the events outbox's 5 on the shared queue, so an index run never jumps the
     * events' own embeddings.
     */
    indexPriority?: number;
    /**
     * Depth gate for indexing: publish only while the target queue holds fewer ready
     * messages than this (default 1000; 0 disables). Queries are never gated. A slot that
     * cannot publish within its timeout fails as WAIT-class 'timeout' and is retried.
     */
    indexDepthLimit?: number;
    /** While the depth gate holds, re-read the queue depth this often, in ms (default 15_000). */
    depthPollMs?: number;
    /** Parallel in-flight requests for embedBatch (default 10) */
    concurrency?: number;
    /** AMQP heartbeat seconds (default 60) */
    heartbeat?: number;
    /** Source identifier included in the task body */
    source?: string;
    /** Injectable factory for tests */
    connectFn?: typeof amqplib.connect;
}

/** Which caller a request serves: a search query (`embed`) or indexing (`embedBatch*`). */
export type EmbedLane = 'query' | 'index';

/** A depth reading is reused for at most this long, so concurrent slots share one broker round-trip. */
const DEPTH_CACHE_MS = 2_000;

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
    // Depth gate: a dedicated channel, so a failed checkQueue (it closes its channel)
    // never takes the publish or reply channel with it.
    private depthCh: Channel | null = null;
    private depthCache: { at: number; depth: number } | null = null;
    private depthRead: Promise<number | null> | null = null;
    private depthWarned: boolean = false;

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
            queryTimeoutMs: config.queryTimeoutMs ?? Math.min(config.timeoutMs ?? 1_700_000, 30_000),
            priority: config.priority ?? 5,
            indexPriority: config.indexPriority ?? 4,
            indexDepthLimit: config.indexDepthLimit ?? 1000,
            depthPollMs: config.depthPollMs ?? 15_000,
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
        this.depthCh = null;
        this.depthCache = null;
        this.conn = null;
    }

    /** Graceful shutdown — closes channels and connection. */
    async close(): Promise<void> {
        try { if (this.depthCh) await this.depthCh.close(); } catch { /* ignore */ }
        try { if (this.replyCh) await this.replyCh.close(); } catch { /* ignore */ }
        try { if (this.publishCh) await this.publishCh.close(); } catch { /* ignore */ }
        try { if (this.conn) await this.conn.close(); } catch { /* ignore */ }
        this.resetState('Explicit close', 'shutdown');
    }

    // ── Embedding API ────────────────────────────────────────

    async embed(text: string): Promise<EmbeddingVector> {
        await this.initialize();
        const processed = this.preprocessText(text);
        const vector = await this.sendOneWithRetry(processed, 'query');
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
                const vector = await this.sendOne(processed[idx], 0, 'index');
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
                    const vector = await this.sendOneWithRetry(processed[idx], 'index');
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
     * Bounded retry-via-republish wrapper around sendOne. Only WAIT-class faults
     * are retried; REAL faults and 'shutdown' fail fast. Retries re-publish a
     * fresh taskId (the prior attempt already settled — timeout deleted its
     * pending entry, or the channel closed) and reuse the configured priority
     * (never escalate).
     */
    private async sendOneWithRetry(text: string, lane: EmbedLane = 'index'): Promise<number[]> {
        let lastErr: any;
        for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await this.sendOne(text, attempt, lane);
            } catch (err) {
                lastErr = err;
                const reason = (err as { embedReason?: EmbedReason }).embedReason;
                if (!reason || !WAIT_REASONS.has(reason)) throw err; // REAL or 'shutdown' → no retry
                // WAIT-class: re-publish a fresh taskId on the next loop iteration.
                console.error(`[RabbitMQEmbedding] retry ${attempt + 1}/${this.config.maxRetries} after ${reason} (${lane})`);
            }
        }
        throw lastErr;
    }

    /** The priority and timeout a lane publishes with. Each message expires at its timeout. */
    private laneSettings(lane: EmbedLane): { priority: number; timeoutMs: number } {
        return lane === 'query'
            ? { priority: this.config.priority, timeoutMs: this.config.queryTimeoutMs }
            : { priority: this.config.indexPriority, timeoutMs: this.config.timeoutMs };
    }

    /**
     * Ready messages on the target queue, or null when they cannot be read (the gate then
     * stays open: an unreadable depth must not stop indexing). One read is shared by every
     * concurrent caller and reused for up to DEPTH_CACHE_MS.
     */
    private async readQueueDepth(): Promise<number | null> {
        const cacheMs = Math.min(DEPTH_CACHE_MS, this.config.depthPollMs);
        if (this.depthCache && Date.now() - this.depthCache.at < cacheMs) return this.depthCache.depth;
        if (!this.depthRead) {
            this.depthRead = this.fetchQueueDepth().finally(() => { this.depthRead = null; });
        }
        return this.depthRead;
    }

    private async fetchQueueDepth(): Promise<number | null> {
        try {
            await this.initialize();
            if (!this.depthCh) {
                if (!this.conn) return null;
                const ch = await this.conn.createChannel();
                ch.on('error', (err: Error) => {
                    console.error(`[RabbitMQEmbedding] depth channel error: ${err.message}`);
                });
                ch.on('close', () => { if (this.depthCh === ch) this.depthCh = null; });
                this.depthCh = ch;
            }
            const ch = this.depthCh as unknown as { checkQueue?: (queue: string) => Promise<{ messageCount: number }> };
            if (typeof ch.checkQueue !== 'function') throw new Error('channel has no checkQueue');
            const ok = await ch.checkQueue(this.config.queue);
            this.depthCache = { at: Date.now(), depth: ok.messageCount };
            return ok.messageCount;
        } catch (err) {
            this.depthCh = null;
            if (!this.depthWarned) {
                this.depthWarned = true;
                console.error(`[RabbitMQEmbedding] depth gate cannot read ${this.config.queue}: ${(err as Error).message}; indexing publishes without it`);
            }
            return null;
        }
    }

    /**
     * Hold an indexing publish while the queue holds indexDepthLimit or more ready messages.
     * Bounded by the lane timeout: past it the slot fails as WAIT-class 'timeout' with nothing
     * published, so the retry loop and the broker-ceiling invariant still hold.
     */
    private async waitForIndexDepth(maxWaitMs: number): Promise<void> {
        const limit = this.config.indexDepthLimit;
        if (!(limit > 0)) return;
        const started = Date.now();
        let announced = false;
        while (true) {
            const depth = await this.readQueueDepth();
            if (depth === null || depth < limit) return;
            const waited = Date.now() - started;
            if (waited >= maxWaitMs) {
                throw Object.assign(
                    new Error(`Embedding depth gate: ${this.config.queue} held ${depth} ready messages (limit ${limit}) for ${waited}ms`),
                    { embedReason: 'timeout' as EmbedReason });
            }
            if (!announced) {
                announced = true;
                console.error(`[RabbitMQEmbedding] depth gate: ${this.config.queue} holds ${depth} ready (limit ${limit}); indexing waits`);
            }
            await new Promise<void>((r) => setTimeout(r, Math.min(this.config.depthPollMs, maxWaitMs - waited)));
        }
    }

    private async sendOne(text: string, attempt: number = 0, lane: EmbedLane = 'index'): Promise<number[]> {
        const { priority, timeoutMs } = this.laneSettings(lane);
        if (lane === 'index') await this.waitForIndexDepth(timeoutMs);
        // Re-establish after a resetState (idempotent + mutex-guarded) so WAIT-class
        // retries can recover from a transient connection/channel drop. Because each
        // retry calls sendOne afresh, it reads the NEW this.replyQueue at publish time.
        await this.initialize();
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
            priority,
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
                        new Error(`Embedding timeout after ${timeoutMs}ms (queue=${this.config.queue}, ${lane})`),
                        { embedReason: 'timeout' as EmbedReason }));
                }
            }, timeoutMs);

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
                    priority,
                    // The request is abandoned at its timeout (a retry republishes under a fresh
                    // taskId), so the message expires then too: no worker spends time on it. The
                    // queue's dead-letter exchange receives it with x-death reason 'expired'.
                    expiration: String(timeoutMs),
                    timestamp: Math.floor(now / 1000),
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
