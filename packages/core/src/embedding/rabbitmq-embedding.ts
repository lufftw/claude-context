import amqplib, { type ChannelModel, type Channel, type ConfirmChannel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { Embedding, EmbeddingVector } from './base-embedding';

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
    /** Per-request timeout in ms (default 30000) */
    timeoutMs?: number;
    /** RabbitMQ priority (0-10). Indexing = higher if you want to jump enrichment. */
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
            timeoutMs: config.timeoutMs ?? 30000,
            priority: config.priority ?? 5,
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
        const conn = await connect(this.config.url, {
            heartbeat: this.config.heartbeat,
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
                        pending.reject(new Error(raw.error || 'Embedding worker returned failure'));
                        return;
                    }

                    let vectors: number[][] | null = null;
                    if (raw.content) {
                        try {
                            vectors = JSON.parse(raw.content) as number[][];
                        } catch (err) {
                            pending.reject(new Error(`Failed to parse reply content JSON: ${(err as Error).message}`));
                            return;
                        }
                    } else if (Array.isArray(raw.embeddings)) {
                        vectors = raw.embeddings;
                    }

                    if (!vectors || vectors.length === 0 || !Array.isArray(vectors[0])) {
                        pending.reject(new Error('Empty or malformed embedding response'));
                        return;
                    }

                    pending.resolve(vectors[0]);
                } catch (err) {
                    console.error(`[RabbitMQEmbedding] reply parse error: ${(err as Error).message}`);
                }
            },
            { noAck: true }
        );

        this.isInitialized = true;
        console.log(
            `[RabbitMQEmbedding] ✅ initialized — queue=${this.config.queue}, model=${this.config.modelName}, dim=${this.config.dimension}, replyQueue=${this.replyQueue}`
        );
    }

    /**
     * Idempotent state reset. Rejects all pending requests so callers see
     * a prompt failure instead of waiting for the per-request timeout.
     */
    private resetState(reason: string): void {
        if (!this.isInitialized && !this.replyQueue && this.pending.size === 0) return;
        console.warn(`[RabbitMQEmbedding] reset: ${reason}`);
        this.isInitialized = false;
        this.replyQueue = null;

        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(`RabbitMQEmbedding reset: ${reason}`));
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
        this.resetState('Explicit close');
    }

    // ── Embedding API ────────────────────────────────────────

    async embed(text: string): Promise<EmbeddingVector> {
        await this.initialize();
        const processed = this.preprocessText(text);
        const vector = await this.sendOne(processed);
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

    private async sendOne(text: string): Promise<number[]> {
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
            retryCount: 0,
            headers: {
                'x-retry-count': 0,
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
                    reject(new Error(`Embedding timeout after ${this.config.timeoutMs}ms (queue=${this.config.queue})`));
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
