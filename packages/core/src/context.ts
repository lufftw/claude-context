import {
    Splitter,
    CodeChunk,
    AstCodeSplitter
} from './splitter';
import {
    Embedding,
    EmbeddingVector,
    OpenAIEmbedding,
    EmbedItemResult,
    EmbedReason,
    REAL_REASONS
} from './embedding';
import {
    getModelSpec,
    DEFAULT_PRIMARY_MODEL_ID,
} from './embedding/model-registry';
import {
    VectorDatabase,
    VectorDocument,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult
} from './vectordb';
import { SemanticSearchResult } from './types';
import { envManager } from './utils/env-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { FileSynchronizer } from './sync/synchronizer';

const DEFAULT_SUPPORTED_EXTENSIONS = [
    // Programming languages
    '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.cpp', '.c', '.h', '.hpp',
    '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.m', '.mm',
    '.dart', '.sol',
    // Text and markup files
    '.md', '.markdown', '.ipynb',
    // '.txt',  '.json', '.yaml', '.yml', '.xml', '.html', '.htm',
    // '.css', '.scss', '.less', '.sql', '.sh', '.bash', '.env'
];

const DEFAULT_IGNORE_PATTERNS = [
    // Common build output and dependency directories
    'node_modules/**',
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    'coverage/**',
    '.nyc_output/**',

    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '*.swp',
    '*.swo',

    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',

    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '.pytest_cache/**',

    // Logs and temporary files
    'logs/**',
    'tmp/**',
    'temp/**',
    '*.log',

    // Environment and config files
    '.env',
    '.env.*',
    '*.local',

    // Minified and bundled files
    '*.min.js',
    '*.min.css',
    '*.min.map',
    '*.bundle.js',
    '*.bundle.css',
    '*.chunk.js',
    '*.vendor.js',
    '*.polyfills.js',
    '*.runtime.js',
    '*.map', // source map files
    'node_modules', '.git', '.svn', '.hg', 'build', 'dist', 'out',
    'target', '.vscode', '.idea', '__pycache__', '.pytest_cache',
    'coverage', '.nyc_output', 'logs', 'tmp', 'temp'
];

export interface ContextConfig {
    embedding?: Embedding;
    /**
     * Optional secondary embedding instance (dual-embedding, Option B). When
     * present, indexing dual-targets a second per-model collection (LD-2/LD-5).
     * Constructed by the MCP factory ONLY when the secondary is configured;
     * absence ⇒ single-model byte-identical path.
     */
    secondaryEmbedding?: Embedding;
    /**
     * Optional per-(codebase × model) coverage-ratio reader (P4/LD-10).
     * Supplied by the MCP layer from the snapshot. Returns the distinct-PK
     * overlap ratio for a model's collection, or undefined when unknown. Core
     * must not import the mcp SnapshotManager — this callback is the only bridge
     * (mirrors how priorLedger crosses the boundary).
     */
    coverageReader?: (codebasePath: string, modelId: string) => number | undefined;
    vectorDatabase?: VectorDatabase;
    codeSplitter?: Splitter;
    supportedExtensions?: string[];
    ignorePatterns?: string[];
    customExtensions?: string[]; // New: custom extensions from MCP
    customIgnorePatterns?: string[]; // New: custom ignore patterns from MCP
    includeDotDirs?: string[]; // Dot-prefixed directories to include in indexing
}

/**
 * Result of processing a single chunk batch through the partial-tolerant
 * reducer (Commit 2/4).
 *
 * The reducer NEVER throws for per-slot embedding faults — it classifies them
 * into the three-way counter via these fields and lets the caller decide
 * whether to abort. (`processChunkBatch` only throws for genuinely unexpected
 * conditions.)
 *
 *  - `perFile`       — per-relativePath tally: chunks produced (every slot we
 *                      attempted) vs inserted (slots embedded AND confirmed
 *                      written to the vector DB). Accumulated into
 *                      processFileList's fileProgress; not yet read for
 *                      completeness (that is Commit 3).
 *  - `realFailures`  — slots whose reason ∈ REAL_REASONS
 *                      (worker-error | bad-dimension | malformed | insert-error).
 *                      A non-zero value advances the consecutive-error counter.
 *  - `waitFailures`  — slots whose reason ∈ WAIT class (after provider retry
 *                      exhaustion). Neutral for the abort counter.
 *  - `successes`     — slots embedded AND confirmed inserted.
 */
interface BatchOutcome {
    perFile: Map<string, { produced: number; inserted: number }>;
    realFailures: number;
    waitFailures: number;
    successes: number;
}

/**
 * A single (model × collection × embedding-instance) target for the inner index
 * loop (Option B — one collection per model). The outer Merkle scan + AST split
 * runs ONCE; each IndexTarget then embeds the already-split chunks with its own
 * embedding instance and upserts to its own collection. (LD-5.)
 *
 *  - modelId        — canonical registry id; ALSO the per-model ledger key. The
 *                     synthetic '__writable_shared__' key (C2) routes its
 *                     embedding/dim from the primary but keeps a distinct ledger
 *                     key so it never clobbers the primary's per-model ledger. It
 *                     is invisible to search/status, which enumerate canonical
 *                     model ids by name.
 *  - collectionName — resolved via getCollectionNameForModel (suffix '' ⇒ the
 *                     literal primary name, byte-identical to today).
 *  - embedding      — this target's Embedding instance (its getDimension() is the
 *                     expectedDim for the rogue-dimension guard AND the source of
 *                     embedBatchPartial — M7).
 *  - isHybrid       — process-wide getIsHybrid(); both targets share the same
 *                     sparse_vector shape so the 0.6B collection inherits hybrid
 *                     (M6 / R3-HYBRID-SPARSE).
 *  - priorLedger    — per-model completeness ledger captured at run start (the
 *                     resume read, M8). Keyed by relativePath. undefined ⇒ empty.
 *  - existingHashes — per-collection relativePath→fileHash loaded from Milvus
 *                     (M8). Populated by processFileList before the file loop.
 */
interface IndexTarget {
    modelId: string;
    collectionName: string;
    embedding: Embedding;
    isHybrid: boolean;
    priorLedger?: Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>;
    existingHashes?: Map<string, string>;
}

/** Synthetic IndexTarget ledger key for the writable-shared dual-write (C2). It is
 *  NOT a queryable model — search/status enumerate canonical model ids by name, so
 *  this key is invisible to them; it only keeps the shared collection's write-only
 *  bookkeeping ledger separate from the primary 8B ledger.
 *
 *  Ledger policy (Fix 1): because this key is never read back (the writable-shared
 *  target's priorLedger is seeded from the PRIMARY 8B ledger, see buildIndexTargets),
 *  firing onFileComplete for it would only grow write-only dead weight on the SHARED
 *  snapshot every run. We therefore SUPPRESS every onFileComplete for this key at the
 *  core; buffer/flush/abort accounting for the target still runs. */
const WRITABLE_SHARED_MODEL_ID = '__writable_shared__';

/**
 * Typed abort sentinel (Fix 4) thrown when a target hits
 * MAX_CONSECUTIVE_BATCH_ERRORS REAL-class chunk-batch failures in a row. Carries
 * a literal-`true` discriminant so {@link isIndexAbort} can narrow without `any`.
 * Per-target abort isolation (Fix 2) decides whether catching it drops a single
 * non-primary target or re-throws to fail the whole run (primary death).
 */
interface IndexAbortError extends Error {
    __isIndexAbort: true;
}

/** Type guard for the {@link IndexAbortError} sentinel (Fix 4 — replaces the
 *  `(err as any).__isIndexAbort` casts at the throw + both catch sites). */
function isIndexAbort(e: unknown): e is IndexAbortError {
    return !!e && typeof e === 'object' && (e as { __isIndexAbort?: unknown }).__isIndexAbort === true;
}

export class Context {
    private embedding: Embedding;
    private secondaryEmbedding?: Embedding;
    private coverageReader?: (codebasePath: string, modelId: string) => number | undefined;
    private vectorDatabase: VectorDatabase;
    private codeSplitter: Splitter;
    private supportedExtensions: string[];
    private ignorePatterns: string[];
    private includeDotDirs: string[];
    private synchronizers = new Map<string, FileSynchronizer>();

    constructor(config: ContextConfig = {}) {
        // Initialize services
        this.embedding = config.embedding || new OpenAIEmbedding({
            apiKey: envManager.get('OPENAI_API_KEY') || 'your-openai-api-key',
            model: 'text-embedding-3-small',
            ...(envManager.get('OPENAI_BASE_URL') && { baseURL: envManager.get('OPENAI_BASE_URL') })
        });

        // Optional secondary embedding instance (dual-embedding, Option B / LD-2).
        // undefined when no secondary is configured ⇒ buildIndexTargets() returns a
        // single target ⇒ the index/delete path is byte-identical to single-model.
        this.secondaryEmbedding = config.secondaryEmbedding;

        // P4 coverage-ratio bridge (LD-10). undefined ⇒ secondary models read as
        // "unknown coverage" ⇒ degraded (never silently search a possibly-incomplete
        // collection). The primary model never consults this reader.
        this.coverageReader = config.coverageReader;

        if (!config.vectorDatabase) {
            throw new Error('VectorDatabase is required. Please provide a vectorDatabase instance in the config.');
        }
        this.vectorDatabase = config.vectorDatabase;

        this.codeSplitter = config.codeSplitter || new AstCodeSplitter(2500, 300);

        // Load custom extensions from environment variables
        const envCustomExtensions = this.getCustomExtensionsFromEnv();

        // Combine default extensions with config extensions and env extensions
        const allSupportedExtensions = [
            ...DEFAULT_SUPPORTED_EXTENSIONS,
            ...(config.supportedExtensions || []),
            ...(config.customExtensions || []),
            ...envCustomExtensions
        ];
        // Remove duplicates
        this.supportedExtensions = [...new Set(allSupportedExtensions)];

        // Load custom ignore patterns from environment variables  
        const envCustomIgnorePatterns = this.getCustomIgnorePatternsFromEnv();

        // Start with default ignore patterns
        const allIgnorePatterns = [
            ...DEFAULT_IGNORE_PATTERNS,
            ...(config.ignorePatterns || []),
            ...(config.customIgnorePatterns || []),
            ...envCustomIgnorePatterns
        ];
        // Remove duplicates
        this.ignorePatterns = [...new Set(allIgnorePatterns)];

        // Initialize includeDotDirs from config
        this.includeDotDirs = (config.includeDotDirs || []).map(d => d.replace(/\/+$/, ''));

        console.log(`[Context] 🔧 Initialized with ${this.supportedExtensions.length} supported extensions and ${this.ignorePatterns.length} ignore patterns`);
        if (envCustomExtensions.length > 0) {
            console.log(`[Context] 📎 Loaded ${envCustomExtensions.length} custom extensions from environment: ${envCustomExtensions.join(', ')}`);
        }
        if (envCustomIgnorePatterns.length > 0) {
            console.log(`[Context] 🚫 Loaded ${envCustomIgnorePatterns.length} custom ignore patterns from environment: ${envCustomIgnorePatterns.join(', ')}`);
        }
    }

    /**
     * Get embedding instance
     */
    getEmbedding(): Embedding {
        return this.embedding;
    }

    /**
     * Resolve the configured Embedding instance for a canonical model id (M4).
     *
     * The PRIMARY id always maps to `this.embedding` (byte-identical default).
     * A non-primary id maps to `this.secondaryEmbedding` IFF it was configured;
     * if not configured we THROW a clear configuration error rather than fall
     * back to the wrong-dimension primary instance (never a wrong-dim ANN call).
     * Throws on an unknown model id (registry SSOT).
     */
    public getEmbeddingForModel(modelId: string): Embedding {
        getModelSpec(modelId); // validates id; throws on unknown
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) {
            return this.embedding;
        }
        if (!this.secondaryEmbedding) {
            throw new Error(
                `embedding model '${modelId}' not configured (no secondary embedding instance)`,
            );
        }
        return this.secondaryEmbedding;
    }

    /**
     * Whether an Embedding instance is configured for the given model id.
     * Used by search routing to decide between routing vs. a clear notice
     * WITHOUT ever issuing a mismatched-dimension query.
     */
    public hasEmbeddingForModel(modelId: string): boolean {
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) return true;
        return this.secondaryEmbedding !== undefined;
    }

    /**
     * P4 coverage gate (LD-10). The PRIMARY model is the source of truth and is
     * always sufficient. For a SECONDARY model, the model's collection is readable
     * only when its persisted distinct-PK overlap ratio meets the threshold
     * (COVERAGE_READABLE_THRESHOLD, default 0.85). Unknown ratio (no reader, or
     * reader returns undefined) ⇒ DEGRADED — never silently search a possibly
     * incomplete backfill.
     *
     * Synchronous (reads the in-memory snapshot via the injected reader) so both
     * the search hot-path and isModelReadable can call it without an extra await.
     */
    public isCoverageSufficientForModel(codebasePath: string, modelId: string): boolean {
        if (modelId === DEFAULT_PRIMARY_MODEL_ID) return true;
        const thresholdRaw = envManager.get('COVERAGE_READABLE_THRESHOLD');
        const threshold = thresholdRaw !== undefined && thresholdRaw !== null && thresholdRaw !== ''
            ? parseFloat(thresholdRaw)
            : 0.85;
        const ratio = this.coverageReader?.(codebasePath, modelId);
        if (ratio === undefined || Number.isNaN(ratio)) return false;
        return ratio >= threshold;
    }

    /**
     * Single readability predicate shared by get_indexing_status AND search (P3,
     * RG-6/RG-7) so the two can never disagree about a model.
     *
     * A model is readable for a codebase when:
     *   (1) its embedding instance is configured (hasEmbeddingForModel), AND
     *   (2) its per-model collection exists in the vector DB, AND
     *   (3) its coverage ratio meets the readable threshold
     *       (always true for the primary; the P4 gate for secondaries).
     *
     * The primary model stays byte-identical to today's status check: configured
     * (true), collection-exists (the same hasCollection call status already runs),
     * coverage 1.0 (true).
     */
    public async isModelReadable(codebasePath: string, modelId: string): Promise<boolean> {
        getModelSpec(modelId); // validate id
        if (!this.hasEmbeddingForModel(modelId)) return false;
        const collectionName = this.getCollectionNameForModel(codebasePath, modelId);
        const exists = await this.vectorDatabase.hasCollection(collectionName);
        if (!exists) return false;
        return this.isCoverageSufficientForModel(codebasePath, modelId);
    }

    /**
     * Get vector database instance
     */
    getVectorDatabase(): VectorDatabase {
        return this.vectorDatabase;
    }

    /**
     * Get code splitter instance
     */
    getCodeSplitter(): Splitter {
        return this.codeSplitter;
    }

    /**
     * Get supported extensions
     */
    getSupportedExtensions(): string[] {
        return [...this.supportedExtensions];
    }

    /**
     * Get ignore patterns
     */
    getIgnorePatterns(): string[] {
        return [...this.ignorePatterns];
    }

    /**
     * Get include dot directories
     */
    getIncludeDotDirs(): string[] {
        return [...this.includeDotDirs];
    }

    /**
     * Get synchronizers map
     */
    getSynchronizers(): Map<string, FileSynchronizer> {
        return new Map(this.synchronizers);
    }

    /**
     * Set synchronizer for a collection
     */
    setSynchronizer(collectionName: string, synchronizer: FileSynchronizer): void {
        this.synchronizers.set(collectionName, synchronizer);
    }

    /**
     * Public wrapper for loadIgnorePatterns private method
     */
    async getLoadedIgnorePatterns(codebasePath: string): Promise<void> {
        return this.loadIgnorePatterns(codebasePath);
    }

    /**
     * Public wrapper for prepareCollection private method
     */
    async getPreparedCollection(codebasePath: string): Promise<void> {
        return this.prepareCollection(codebasePath);
    }

    /**
     * Get isHybrid setting from environment variable with default true
     */
    private getIsHybrid(): boolean {
        const isHybridEnv = envManager.get('HYBRID_MODE');
        if (isHybridEnv === undefined || isHybridEnv === null) {
            return true; // Default to true
        }
        return isHybridEnv.toLowerCase() === 'true';
    }

    /**
     * Generate collection name based on codebase path and hybrid mode.
     * If MILVUS_COLLECTION_PRIVATE is set, use it directly (custom naming).
     */
    public getCollectionName(codebasePath: string): string {
        const customName = envManager.get('MILVUS_COLLECTION_PRIVATE');
        if (customName) {
            return customName;
        }
        const isHybrid = this.getIsHybrid();
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const prefix = isHybrid === true ? 'hybrid_code_chunks' : 'code_chunks';
        return `${prefix}_${hash.substring(0, 8)}`;
    }

    /**
     * Get the shared collection name from environment, if configured.
     * Returns undefined if no shared collection is set or strategy is 'private'.
     */
    public getSharedCollectionName(): string | undefined {
        const strategy = envManager.get('MILVUS_STRATEGY');
        if (strategy === 'private') return undefined;
        return envManager.get('MILVUS_COLLECTION_SHARED');
    }

    /**
     * Model-aware shared-collection resolver (M5).
     *
     * The shared collection (`MILVUS_COLLECTION_SHARED`) is a fixed-dimension
     * space created at the PRIMARY model's dimension (4096 for qwen3-8b). A
     * secondary-model (1024-dim) query vector ANN-searched against that 4096-dim
     * space is a guaranteed dimension mismatch on the FIRST secondary search of
     * any hybrid/shared project — including the MVP target (claude-context,
     * strategy=hybrid, shared=dev_infra_shared).
     *
     * Therefore the shared arm is appended ONLY for the primary model. Any model
     * that lacks a same-dimension shared collection returns undefined; the caller
     * (_semanticSearchImpl) then searches the model's private collection only.
     * Throws on an unknown model id (registry SSOT — fail fast, never wrong-dim).
     */
    public getSharedCollectionNameForModel(modelId: string): string | undefined {
        getModelSpec(modelId); // validates the id; throws on unknown
        if (modelId !== DEFAULT_PRIMARY_MODEL_ID) {
            // No same-dim shared collection exists for non-primary models in the MVP.
            return undefined;
        }
        return this.getSharedCollectionName();
    }

    /**
     * Get the writable shared collection name from environment, if configured.
     * When set, indexing will dual-write to both private and shared collections
     * using a single embedding computation (no additional API cost).
     */
    public getWritableSharedCollectionName(): string | undefined {
        return envManager.get('MILVUS_WRITABLE_SHARED');
    }

    /**
     * The CANONICAL model ids active for this run (SEAM-2 / R-C4 single
     * enumerator). Always the primary (8B); the secondary (0.6B) is added only
     * when a secondary embedding instance is configured. The synthetic
     * '__writable_shared__' target is NOT a model and is intentionally excluded —
     * status/clear/search enumerate models by name via this helper, so the shared
     * collection's write-only bookkeeping never leaks into those surfaces.
     */
    public getActiveModelIds(): string[] {
        const ids: string[] = [DEFAULT_PRIMARY_MODEL_ID];
        if (this.secondaryEmbedding) {
            ids.push(envManager.get('RABBITMQ_SECONDARY_MODEL') || 'qwen3-embedding-0.6b');
        }
        return ids;
    }

    /**
     * Resolve the Milvus collection name for a specific embedding model
     * (Option B — one collection per model). Mirrors the MILVUS_COLLECTION_PRIVATE
     * override pattern in getCollectionName.
     *
     *  - Primary (collectionSuffix === '') ⇒ the EXISTING getCollectionName result,
     *    byte-identical to single-model today (LD-3).
     *  - Secondary ⇒ MILVUS_COLLECTION_PRIVATE_0P6B verbatim if set, else
     *    base + registry suffix (e.g. claude_context_own ⇒ claude_context_own_0p6b).
     *  - Unknown model id ⇒ getModelSpec throws (fail-closed, LD-1).
     */
    public getCollectionNameForModel(codebasePath: string, modelId: string): string {
        const spec = getModelSpec(modelId);
        if (spec.collectionSuffix === '') {
            return this.getCollectionName(codebasePath);
        }
        const override = envManager.get('MILVUS_COLLECTION_PRIVATE_0P6B');
        if (override) {
            return override;
        }
        return this.getCollectionName(codebasePath) + spec.collectionSuffix;
    }

    /**
     * Enumerate the set of collection names that are ACTIVE for a codebase under
     * the current model configuration (P3 shared sweep). Used by clear (and any
     * other per-model sweep) so it can never miss a model's collection.
     *
     * Model ids come from the ONE enumerator getActiveModelIds() (SEAM-2 / R-C4) —
     * never re-derived inline. For each active model: its per-model collection. The
     * PRIMARY additionally contributes its writable-shared sibling when configured
     * (M5: only the primary has a same-dim shared space; the secondary has none).
     *
     * De-duplicated; safe when only the primary is configured (returns the single
     * primary collection — byte-identical to today's clear).
     */
    private getActiveModelCollectionNames(codebasePath: string): string[] {
        const names = new Set<string>();
        for (const modelId of this.getActiveModelIds()) {
            names.add(this.getCollectionNameForModel(codebasePath, modelId));
            // Writable-shared sibling only for the primary (M5: 0.6B has none).
            if (modelId === DEFAULT_PRIMARY_MODEL_ID) {
                const ws = this.getWritableSharedCollectionName();
                if (ws) names.add(ws);
            }
        }
        return [...names];
    }

    /**
     * Build the per-run IndexTarget array (the SHARED owner used by
     * prepareCollection, processFileList, the per-target delete, and the syncer —
     * Residual-Risk-1's "one IndexTarget-array builder").
     *
     * Emits the primary (8B) target FIRST = { DEFAULT_PRIMARY_MODEL_ID,
     * getCollectionName, this.embedding }. Then (C2) appends the writable-shared
     * target — a SAME-INSTANCE target (same embedding/dimension as the primary,
     * distinct collection, synthetic '__writable_shared__' ledger key) — replacing
     * the old inline dual-write (P1: a chunk is written to the shared collection
     * exactly once, as this target, never inline). Finally, when a secondary
     * embedding instance is configured, appends the 0.6B target { secondary model
     * id, *_0p6b, this.secondaryEmbedding }.
     *
     * Single-model with no writable-shared ⇒ length 1, collectionName ===
     * getCollectionName(path), embedding === this.embedding ⇒ the whole inner loop
     * is byte-identical.
     */
    private buildIndexTargets(
        codebasePath: string,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>,
    ): IndexTarget[] {
        const isHybrid = this.getIsHybrid();

        // Fix 3 (R-C4 single enumerator): the canonical model ids come from the ONE
        // definition — getActiveModelIds() — never re-derived inline here. The
        // primary embedding instance is this.embedding; each non-primary id maps to
        // this.secondaryEmbedding (only the 0.6B secondary is non-primary today).
        const activeModelIds = this.getActiveModelIds();
        const primaryCollectionName = this.getCollectionNameForModel(codebasePath, DEFAULT_PRIMARY_MODEL_ID);
        const targets: IndexTarget[] = [];

        for (const modelId of activeModelIds) {
            const isPrimary = modelId === DEFAULT_PRIMARY_MODEL_ID;
            targets.push({
                modelId,
                collectionName: isPrimary ? primaryCollectionName : this.getCollectionNameForModel(codebasePath, modelId),
                embedding: isPrimary ? this.embedding : this.secondaryEmbedding!,
                isHybrid,
            });

            // C2 (rev1.2): writable-shared is a SAME-INSTANCE target (same dim as
            // primary), NOT inline. Inserted immediately AFTER the primary (and
            // before any secondary), so its dimension is the primary's, it is
            // written exactly once, and targets[0] stays the primary for the
            // prepareCollection primary-dim path. The synthetic key is kept OUT of
            // getActiveModelIds (it is not a queryable model) — see Fix 3.
            if (isPrimary) {
                const ws = this.getWritableSharedCollectionName();
                if (ws && ws !== primaryCollectionName) {
                    targets.push({
                        modelId: WRITABLE_SHARED_MODEL_ID,        // synthetic key; never a queryable model
                        collectionName: ws,
                        embedding: this.embedding,                // same instance/dimension as primary
                        isHybrid,
                        priorLedger: priorLedgersByModel?.get(DEFAULT_PRIMARY_MODEL_ID) ?? new Map(),
                    });
                }
            }
        }
        return targets;
    }

    /**
     * Index a codebase for semantic search
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param onFileComplete Optional per-(file × model) completeness callback (M8).
     *        Fires once per produced (file × IndexTarget): complete:true ⇔ every
     *        chunk the splitter produced for that file was embedded AND inserted FOR
     *        THAT MODEL; complete:false otherwise (failed chunk, chunk-limit
     *        truncation, delete-on-change failure recovery). The first arg is the
     *        modelId (canonical id, or the synthetic '__writable_shared__' key for
     *        the dual-write target). Drives the per-model snapshot completeness
     *        ledger. Core never imports the mcp package — this callback is the only
     *        bridge.
     * @param forceReindex Whether to recreate the collection even if it exists
     * @param priorLedgersByModel Optional per-MODEL prior-run completeness ledgers
     *        (the snapshot loaded at MCP startup), keyed by modelId → (relativePath
     *        → { complete, fileHash, chunkCount? }). Read by the per-target resume
     *        skip (M8): a target skips a file ONLY when its OWN collection has it at
     *        the same hash AND its OWN ledger says complete:true at that same hash.
     *        A target whose ledger disagrees re-embeds even if another target is
     *        complete (NOT all-or-nothing). Defined inline — core must NOT import
     *        mcp's FileCompleteness.
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        forceReindex: boolean = false,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        // Scope project-`.env` reads (MILVUS_COLLECTION_PRIVATE, _SHARED, _STRATEGY, etc.)
        // to this call only via AsyncLocalStorage. Critical for parallel safety:
        // sibling indexCodebase() calls must not see each other's project context.
        // Bug history: see docs/lufftw/bugfix-2026-05-04-envmanager-concurrency.md
        return envManager.runWithProject(codebasePath, () => this._indexCodebaseImpl(codebasePath, progressCallback, onFileComplete, forceReindex, priorLedgersByModel));
    }

    private async _indexCodebaseImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        forceReindex: boolean = false,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🚀 Starting to index codebase with ${searchType}: ${codebasePath}`);

        // 1. Load ignore patterns from various ignore files
        await this.loadIgnorePatterns(codebasePath);

        // 2. Check and prepare vector collection
        progressCallback?.({ phase: 'Preparing collection...', current: 0, total: 100, percentage: 0 });
        console.log(`Debug2: Preparing vector collection for codebase${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        await this.prepareCollection(codebasePath, forceReindex);

        // 3. Recursively traverse codebase to get all supported files
        progressCallback?.({ phase: 'Scanning files...', current: 5, total: 100, percentage: 5 });
        const codeFiles = await this.getCodeFiles(codebasePath);
        console.log(`[Context] 📁 Found ${codeFiles.length} code files`);

        if (codeFiles.length === 0) {
            progressCallback?.({ phase: 'No files to index', current: 100, total: 100, percentage: 100 });
            return { indexedFiles: 0, totalChunks: 0, status: 'completed' };
        }

        // 3. Process each file with streaming chunk processing
        // Reserve 10% for preparation, 90% for actual indexing
        const indexingStartPercentage = 10;
        const indexingEndPercentage = 100;
        const indexingRange = indexingEndPercentage - indexingStartPercentage;

        const result = await this.processFileList(
            codeFiles,
            codebasePath,
            (filePath, fileIndex, totalFiles) => {
                // Calculate progress percentage
                const progressPercentage = indexingStartPercentage + (fileIndex / totalFiles) * indexingRange;

                console.log(`[Context] 📊 Processed ${fileIndex}/${totalFiles} files`);
                progressCallback?.({
                    phase: `Processing files (${fileIndex}/${totalFiles})...`,
                    current: fileIndex,
                    total: totalFiles,
                    percentage: Math.round(progressPercentage)
                });
            },
            onFileComplete,
            priorLedgersByModel
        );

        console.log(`[Context] ✅ Codebase indexing completed! Processed ${result.processedFiles} files in total, generated ${result.totalChunks} code chunks`);

        progressCallback?.({
            phase: 'Indexing complete!',
            current: result.processedFiles,
            total: codeFiles.length,
            percentage: 100
        });

        return {
            indexedFiles: result.processedFiles,
            totalChunks: result.totalChunks,
            status: result.status
        };
    }

    async reindexByChange(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<{ added: number, removed: number, modified: number }> {
        return envManager.runWithProject(codebasePath, () => this._reindexByChangeImpl(codebasePath, progressCallback));
    }

    private async _reindexByChangeImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<{ added: number, removed: number, modified: number }> {
        // P2: the syncer is the SECOND live entry point — bring it under the same
        // IndexTarget abstraction so a user edit can't desync the secondary _0p6b.
        const targets = this.buildIndexTargets(codebasePath);
        const primaryCollection = targets[0].collectionName;   // synchronizer key (filesystem-tracked, model-blind)
        const synchronizer = this.synchronizers.get(primaryCollection);

        if (!synchronizer) {
            // Load project-specific ignore patterns before creating FileSynchronizer
            await this.loadIgnorePatterns(codebasePath);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(codebasePath, this.ignorePatterns, this.includeDotDirs, this.supportedExtensions);
            await newSynchronizer.initialize();
            this.synchronizers.set(primaryCollection, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(primaryCollection)!;

        progressCallback?.({ phase: 'Checking for file changes...', current: 0, total: 100, percentage: 0 });
        const { added, removed, modified } = await currentSynchronizer.checkForChanges();
        const totalChanges = added.length + removed.length + modified.length;

        if (totalChanges === 0) {
            progressCallback?.({ phase: 'No changes detected', current: 100, total: 100, percentage: 100 });
            console.log('[Context] ✅ No file changes detected.');
            return { added: 0, removed: 0, modified: 0 };
        }

        console.log(`[Context] 🔄 Found changes: ${added.length} added, ${removed.length} removed, ${modified.length} modified.`);

        let processedChanges = 0;
        const updateProgress = (phase: string) => {
            processedChanges++;
            const percentage = Math.round((processedChanges / (removed.length + modified.length + added.length)) * 100);
            progressCallback?.({ phase, current: processedChanges, total: totalChanges, percentage });
        };

        // Removed + modified files: delete stale chunks from EVERY target's
        // collection (P2 — else _0p6b keeps orphaned rows for the edited path).
        for (const file of removed) {
            for (const target of targets) {
                await this.deleteFileChunks(target.collectionName, file);
            }
            updateProgress(`Removed ${file}`);
        }
        for (const file of modified) {
            for (const target of targets) {
                await this.deleteFileChunks(target.collectionName, file);
            }
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Added + modified files: re-embed for ALL targets via processFileList.
        // Empty per-model prior ledgers ⇒ every target re-embeds the changed set
        // (we already deleted stale rows above; upsert is idempotent by PK). The
        // syncer does not persist the completeness ledger (snapshot writes happen
        // in the index path); pass a no-op onFileComplete so processFileList's new
        // arity is satisfied.
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));
        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => { updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`); },
                undefined,                 // syncer does not write the per-model ledger here
                new Map(),                 // empty per-model prior ledgers ⇒ re-embed the changed set for every target
            );
        }

        console.log(`[Context] ✅ Re-indexing complete. Added: ${added.length}, Removed: ${removed.length}, Modified: ${modified.length}`);
        progressCallback?.({ phase: 'Re-indexing complete!', current: totalChanges, total: totalChanges, percentage: 100 });

        return { added: added.length, removed: removed.length, modified: modified.length };
    }

    private async deleteFileChunks(collectionName: string, relativePath: string): Promise<void> {
        // Escape backslashes for Milvus query expression (Windows path compatibility)
        const escapedPath = relativePath.replace(/\\/g, '\\\\');
        const results = await this.vectorDatabase.query(
            collectionName,
            `relativePath == "${escapedPath}"`,
            ['id']
        );

        if (results.length > 0) {
            const ids = results.map(r => r.id as string).filter(id => id);
            if (ids.length > 0) {
                await this.vectorDatabase.delete(collectionName, ids);
                console.log(`[Context] Deleted ${ids.length} chunks for file ${relativePath}`);
            }
        }
    }

    /**
     * Semantic search with unified implementation
     * @param codebasePath Codebase path to search in
     * @param query Search query
     * @param topK Number of results to return
     * @param threshold Similarity threshold
     */
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string, embeddingModel?: string): Promise<SemanticSearchResult[]> {
        // Scope project-`.env` reads to this call (parallel-safe via AsyncLocalStorage)
        return envManager.runWithProject(codebasePath, () => this._semanticSearchImpl(codebasePath, query, topK, threshold, filterExpr, embeddingModel));
    }

    private async _semanticSearchImpl(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string, embeddingModel?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';

        // ── Model resolution (M4 / R-C5): explicit param > SEARCH_EMBEDDING_MODEL env > primary 8B.
        // This is the SINGLE authoritative resolution site. It runs inside
        // runWithProject (see semanticSearch), so envManager.get() reads the project
        // `.env` value — project scope WINS over user scope (fork rule). The handler
        // passes either the explicit arg or `undefined`; it never reads process.env
        // itself, so a project `.env` SEARCH_EMBEDDING_MODEL is honored here.
        const requestedModel = embeddingModel
            ?? envManager.get('SEARCH_EMBEDDING_MODEL')
            ?? DEFAULT_PRIMARY_MODEL_ID;
        getModelSpec(requestedModel); // validate id; throws on unknown
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath} [model=${requestedModel}]`);

        // Requested-but-unconfigured model → clear notice, NEVER a wrong-dim ANN call (M4/LD-8/D7).
        if (!this.hasEmbeddingForModel(requestedModel)) {
            console.log(`[Context] ⚠️  Embedding model '${requestedModel}' is not configured — returning no results (configure the secondary model to search it).`);
            return [];
        }

        // Resolve the query-embedding instance and the model's collection (Phase 2 resolver).
        const queryEmbedder = this.getEmbeddingForModel(requestedModel);
        const collectionName = this.getCollectionNameForModel(codebasePath, requestedModel);

        // P4 coverage gate (secondary models only): if the model's collection
        // coverage is below threshold (or unknown), return the degraded notice
        // WITHOUT issuing the ANN call. Primary model is always sufficient.
        if (!this.isCoverageSufficientForModel(codebasePath, requestedModel)) {
            console.log(`[Context] ⚠️  Coverage for model '${requestedModel}' on ${codebasePath} is below the readable threshold — returning no results (degraded; backfill incomplete).`);
            return [];
        }

        // ── Shared arm is model-aware (M5): only the primary model has a same-dim shared space.
        const sharedCollectionName = this.getSharedCollectionNameForModel(requestedModel);
        const collectionsToSearch: string[] = [collectionName];

        if (sharedCollectionName && sharedCollectionName !== collectionName) {
            const hasShared = await this.vectorDatabase.hasCollection(sharedCollectionName);
            if (hasShared) {
                collectionsToSearch.push(sharedCollectionName);
                console.log(`[Context] 🔍 Multi-collection search: private=${collectionName}, shared=${sharedCollectionName}`);
            } else {
                console.log(`[Context] ⚠️  Shared collection '${sharedCollectionName}' does not exist, searching private only`);
            }
        } else {
            console.log(`[Context] 🔍 Using collection: ${collectionName}`);
        }

        // Check if primary collection exists
        const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
        if (!hasCollection) {
            console.log(`[Context] ⚠️  Collection '${collectionName}' does not exist. Please index the codebase first.`);
            return [];
        }

        if (isHybrid === true) {
            try {
                const stats = await this.vectorDatabase.query(collectionName, '', ['id'], 1);
                console.log(`[Context] 🔍 Collection '${collectionName}' exists and appears to have data`);
            } catch (error) {
                console.log(`[Context] ⚠️  Collection '${collectionName}' exists but may be empty or not properly indexed:`, error);
            }

            // 1. Generate query vector (once, reused for all collections) via the RESOLVED model instance.
            console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
            const queryEmbedding: EmbeddingVector = await queryEmbedder.embed(query);
            console.log(`[Context] ✅ Generated embedding vector with dimension: ${queryEmbedding.vector.length}`);

            // 2. Search all collections and merge results
            let allResults: SemanticSearchResult[] = [];

            for (const collection of collectionsToSearch) {
                const searchRequests: HybridSearchRequest[] = [
                    {
                        data: queryEmbedding.vector,
                        anns_field: "vector",
                        param: { "nprobe": 10 },
                        limit: topK
                    },
                    {
                        data: query,
                        anns_field: "sparse_vector",
                        param: { "drop_ratio_search": 0.2 },
                        limit: topK
                    }
                ];

                console.log(`[Context] 🔍 Searching collection: ${collection}`);
                const searchResults: HybridSearchResult[] = await this.vectorDatabase.hybridSearch(
                    collection,
                    searchRequests,
                    {
                        rerank: {
                            strategy: 'rrf',
                            params: { k: 100 }
                        },
                        limit: topK,
                        filterExpr
                    }
                );

                const isShared = collection !== collectionName;
                const results: SemanticSearchResult[] = searchResults.map(result => ({
                    content: result.document.content,
                    relativePath: isShared
                        ? `[shared] ${result.document.relativePath}`
                        : result.document.relativePath,
                    startLine: result.document.startLine,
                    endLine: result.document.endLine,
                    language: result.document.metadata.language || 'unknown',
                    score: result.score,
                    ...(isShared && result.document.metadata.codebasePath ? {
                        sourceProject: path.basename(result.document.metadata.codebasePath)
                    } : {})
                }));

                console.log(`[Context] 🔍 Found ${results.length} results from ${collection}`);
                allResults.push(...results);
            }

            // 3. Sort merged results by score and take topK
            allResults.sort((a, b) => b.score - a.score);
            allResults = allResults.slice(0, topK);

            console.log(`[Context] ✅ Found ${allResults.length} relevant hybrid results (from ${collectionsToSearch.length} collection(s))`);
            if (allResults.length > 0) {
                console.log(`[Context] 🔍 Top result score: ${allResults[0].score}, path: ${allResults[0].relativePath}`);
            }

            return allResults;
        } else {
            // Regular semantic search — also supports multi-collection
            const queryEmbedding: EmbeddingVector = await queryEmbedder.embed(query);
            let allResults: SemanticSearchResult[] = [];

            for (const collection of collectionsToSearch) {
                const searchResults: VectorSearchResult[] = await this.vectorDatabase.search(
                    collection,
                    queryEmbedding.vector,
                    { topK, threshold, filterExpr }
                );

                const isShared = collection !== collectionName;
                const results: SemanticSearchResult[] = searchResults.map(result => ({
                    content: result.document.content,
                    relativePath: isShared
                        ? `[shared] ${result.document.relativePath}`
                        : result.document.relativePath,
                    startLine: result.document.startLine,
                    endLine: result.document.endLine,
                    language: result.document.metadata.language || 'unknown',
                    score: result.score,
                    ...(isShared && result.document.metadata.codebasePath ? {
                        sourceProject: path.basename(result.document.metadata.codebasePath)
                    } : {})
                }));

                allResults.push(...results);
            }

            allResults.sort((a, b) => b.score - a.score);
            allResults = allResults.slice(0, topK);

            console.log(`[Context] ✅ Found ${allResults.length} relevant results (from ${collectionsToSearch.length} collection(s))`);
            return allResults;
        }
    }

    /**
     * Check if index exists for codebase
     * @param codebasePath Codebase path to check
     * @returns Whether index exists
     */
    async hasIndex(codebasePath: string): Promise<boolean> {
        return envManager.runWithProject(codebasePath, async () => {
            const collectionName = this.getCollectionName(codebasePath);
            return await this.vectorDatabase.hasCollection(collectionName);
        });
    }

    /**
     * Clear index
     * @param codebasePath Codebase path to clear index for
     * @param progressCallback Optional progress callback function
     */
    async clearIndex(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        return envManager.runWithProject(codebasePath, () => this._clearIndexImpl(codebasePath, progressCallback));
    }

    private async _clearIndexImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void
    ): Promise<void> {
        console.log(`[Context] 🧹 Cleaning index data for ${codebasePath}...`);

        progressCallback?.({ phase: 'Checking existing index...', current: 0, total: 100, percentage: 0 });

        // Drop EVERY active model collection (primary + secondary + writable-shared
        // sibling) via the one shared enumerator (P3). A single-model config yields
        // exactly the primary collection — byte-identical to the prior behavior.
        const collectionNames = this.getActiveModelCollectionNames(codebasePath);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        const dropFailures: string[] = [];
        for (const collectionName of collectionNames) {
            try {
                const collectionExists = await this.vectorDatabase.hasCollection(collectionName);
                if (collectionExists) {
                    await this.vectorDatabase.dropCollection(collectionName);
                    console.log(`[Context] 🗑️  Dropped collection ${collectionName}`);
                }
            } catch (dropErr) {
                // Pair the abort with recovery: record and keep sweeping the other
                // collections, then re-throw an aggregate so the caller never
                // believes a partial clear fully succeeded.
                console.error(`[Context] ❌ Failed to drop collection ${collectionName}: ${dropErr}`);
                dropFailures.push(collectionName);
            }
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
        if (dropFailures.length > 0) {
            throw new Error(`clearIndex partially failed: could not drop ${dropFailures.join(', ')} (re-run clear_index to retry; snapshot was still cleared).`);
        }
        console.log('[Context] ✅ Index data cleaned');
    }

    /**
     * Update ignore patterns (merges with default patterns and existing patterns)
     * @param ignorePatterns Array of ignore patterns to add to defaults
     */
    updateIgnorePatterns(ignorePatterns: string[]): void {
        // Merge with default patterns and any existing custom patterns, avoiding duplicates
        const mergedPatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];
        const uniquePatterns: string[] = [];
        const patternSet = new Set(mergedPatterns);
        patternSet.forEach(pattern => uniquePatterns.push(pattern));
        this.ignorePatterns = uniquePatterns;
        console.log(`[Context] 🚫 Updated ignore patterns: ${ignorePatterns.length} new + ${DEFAULT_IGNORE_PATTERNS.length} default = ${this.ignorePatterns.length} total patterns`);
    }

    /**
     * Add custom ignore patterns (from MCP or other sources) without replacing existing ones
     * @param customPatterns Array of custom ignore patterns to add
     */
    addCustomIgnorePatterns(customPatterns: string[]): void {
        if (customPatterns.length === 0) return;

        // Merge current patterns with new custom patterns, avoiding duplicates
        const mergedPatterns = [...this.ignorePatterns, ...customPatterns];
        const uniquePatterns: string[] = [];
        const patternSet = new Set(mergedPatterns);
        patternSet.forEach(pattern => uniquePatterns.push(pattern));
        this.ignorePatterns = uniquePatterns;
        console.log(`[Context] 🚫 Added ${customPatterns.length} custom ignore patterns. Total: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Reset ignore patterns to defaults only
     */
    resetIgnorePatternsToDefaults(): void {
        this.ignorePatterns = [...DEFAULT_IGNORE_PATTERNS];
        console.log(`[Context] 🔄 Reset ignore patterns to defaults: ${this.ignorePatterns.length} patterns`);
    }

    /**
     * Update embedding instance
     * @param embedding New embedding instance
     */
    updateEmbedding(embedding: Embedding): void {
        this.embedding = embedding;
        console.log(`[Context] 🔄 Updated embedding provider: ${embedding.getProvider()}`);
    }

    /**
     * Update vector database instance
     * @param vectorDatabase New vector database instance
     */
    updateVectorDatabase(vectorDatabase: VectorDatabase): void {
        this.vectorDatabase = vectorDatabase;
        console.log(`[Context] 🔄 Updated vector database`);
    }

    /**
     * Update splitter instance
     * @param splitter New splitter instance
     */
    updateSplitter(splitter: Splitter): void {
        this.codeSplitter = splitter;
        console.log(`[Context] 🔄 Updated splitter instance`);
    }

    /**
     * Prepare vector collection(s) — one per active IndexTarget (M6, Option B).
     *
     * For each canonical-model target: hasCollection(target.collectionName); if
     * missing, create with target.embedding.detectDimension() (4096 for 8B, 1024
     * for 0.6B) using the SAME hybrid/non-hybrid branch — the secondary inherits
     * the process-wide getIsHybrid(), so the _0p6b collection gets the same
     * sparse_vector shape and per-target hybrid upsert populates the sparse field
     * (R3-HYBRID-SPARSE).
     *
     * The writable-shared target (synthetic '__writable_shared__' key, C2) is
     * skipped in this loop and prepared ONCE below at the PRIMARY target's
     * dimension — a 1024-dim 0.6B vector must never be written into the 4096-dim
     * shared space (M5/M6 dimension-lock), and we keep the descriptive create
     * message for the shared collection.
     *
     * Single-model (no secondary, no writable-shared) ⇒ targets.length === 1 ⇒
     * the create path is byte-identical.
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        const targets = this.buildIndexTargets(codebasePath);
        const dirName = path.basename(codebasePath);

        for (const target of targets) {
            if (target.modelId === WRITABLE_SHARED_MODEL_ID) {
                continue; // handled once below at primary dim
            }
            console.log(`[Context] 🔧 Preparing ${collectionType} collection '${target.collectionName}' for model ${target.modelId}${forceReindex ? ' (FORCE REINDEX)' : ''}`);

            const collectionExists = await this.vectorDatabase.hasCollection(target.collectionName);

            if (collectionExists && !forceReindex) {
                console.log(`📋 Collection ${target.collectionName} already exists, skipping creation`);
                continue;
            }

            if (collectionExists && forceReindex) {
                console.log(`[Context] 🗑️  Dropping existing collection ${target.collectionName} for force reindex...`);
                await this.vectorDatabase.dropCollection(target.collectionName);
                console.log(`[Context] ✅ Collection ${target.collectionName} dropped successfully`);
            }

            console.log(`[Context] 🔍 Detecting embedding dimension for ${target.embedding.getProvider()} provider (model ${target.modelId})...`);
            const dimension = await target.embedding.detectDimension();
            console.log(`[Context] 📏 Detected dimension: ${dimension} for ${target.embedding.getProvider()}`);

            if (target.isHybrid === true) {
                await this.vectorDatabase.createHybridCollection(target.collectionName, dimension, `codebasePath:${codebasePath}`);
            } else {
                await this.vectorDatabase.createCollection(target.collectionName, dimension, `codebasePath:${codebasePath}`);
            }
            console.log(`[Context] ✅ Collection ${target.collectionName} created successfully (dimension: ${dimension})`);
        }

        // Writable shared collection (dual-write) — prepared ONCE at the PRIMARY
        // target's dimension. The primary is targets[0] by construction.
        const primary = targets[0];
        const writableShared = this.getWritableSharedCollectionName();
        if (writableShared && writableShared !== primary.collectionName) {
            const sharedExists = await this.vectorDatabase.hasCollection(writableShared);
            if (!sharedExists) {
                const dimension = await primary.embedding.detectDimension();
                console.log(`[Context] 🔧 Also preparing writable shared collection: ${writableShared} (dim ${dimension})`);
                if (isHybrid === true) {
                    await this.vectorDatabase.createHybridCollection(writableShared, dimension, `Shared hybrid index (writable from ${dirName})`);
                } else {
                    await this.vectorDatabase.createCollection(writableShared, dimension, `Shared index (writable from ${dirName})`);
                }
                console.log(`[Context] ✅ Shared collection ${writableShared} created successfully`);
            } else {
                console.log(`[Context] 📋 Shared collection ${writableShared} already exists, will dual-write during indexing`);
            }
        }
    }

    /**
     * Recursively get all code files in the codebase
     */
    private async getCodeFiles(codebasePath: string): Promise<string[]> {
        const files: string[] = [];

        const traverseDirectory = async (currentPath: string) => {
            const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);

                // Check if path matches ignore patterns
                if (this.matchesIgnorePattern(fullPath, codebasePath)) {
                    continue;
                }

                if (entry.isDirectory()) {
                    await traverseDirectory(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        };

        await traverseDirectory(codebasePath);
        return files;
    }

    /**
 * Process a list of files with streaming chunk processing
 * @param filePaths Array of file paths to process
 * @param codebasePath Base path for the codebase
 * @param onFileProcessed Callback called when each file is processed
 * @returns Object with processed file count and total chunk count
 */
    /**
     * Compute SHA-256 hash of file content for incremental indexing.
     */
    private async computeFileHash(filePath: string): Promise<string> {
        const content = await fs.promises.readFile(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Load existing fileHash values from Milvus for a collection.
     * Returns a Map of relativePath -> fileHash for all indexed files.
     * Uses pagination to handle collections with >16384 unique files.
     */
    private async loadExistingFileHashes(collectionName: string): Promise<Map<string, string>> {
        const hashMap = new Map<string, string>();
        try {
            const hasCollection = await this.vectorDatabase.hasCollection(collectionName);
            if (!hasCollection) return hashMap;

            // Query all chunks' relativePath + metadata (which contains fileHash)
            // We only need one chunk per file to get the fileHash.
            // Full-scan (no 16384 truncation) so resume sees every indexed file.
            const results = await this.vectorDatabase.queryAll(
                collectionName,
                ['relativePath', 'metadata'],
                ''  // all rows
            );

            for (const row of results) {
                const rp = row.relativePath;
                if (!rp || hashMap.has(rp)) continue;  // one per file is enough
                const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
                if (meta?.fileHash) {
                    hashMap.set(rp, meta.fileHash);
                }
            }
            console.log(`[Context] 📋 Loaded ${hashMap.size} existing file hashes from ${collectionName}`);
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not load existing hashes (first index?): ${error}`);
        }
        return hashMap;
    }

    private async processFileList(
        filePaths: string[],
        codebasePath: string,
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void,
        onFileComplete?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
        priorLedgersByModel?: Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>,
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const EMBEDDING_BATCH_SIZE = Math.max(1, parseInt(envManager.get('EMBEDDING_BATCH_SIZE') || '100', 10));
        const CHUNK_LIMIT = 450000;
        // 2026-05-05 deepinfra-rogue-worker incident: silently absorbing every
        // batch failure let a zombie indexer keep firing embeddings for ~50K
        // chunks after its target collection was dropped, wasting GPU + risking
        // dimension-mismatch insert failures that nobody noticed. We now abort
        // the whole indexing run after MAX_CONSECUTIVE_BATCH_ERRORS in a row.
        // Successful batches reset the counter so a single transient blip is
        // still tolerated. Override threshold via INDEX_MAX_CONSECUTIVE_ERRORS.
        const MAX_CONSECUTIVE_BATCH_ERRORS = Math.max(
            1,
            parseInt(envManager.get('INDEX_MAX_CONSECUTIVE_ERRORS') || '3', 10),
        );
        console.log(`[Context] 🔧 Using EMBEDDING_BATCH_SIZE: ${EMBEDDING_BATCH_SIZE}`);

        // ── Build the per-run targets and hydrate each with its OWN existingHashes
        //    (loadExistingFileHashes is already collection-parameterized) and its
        //    OWN priorLedger (M8 — per-(codebase × model) resume state). ──
        const targets = this.buildIndexTargets(codebasePath, priorLedgersByModel);
        for (const target of targets) {
            target.existingHashes = await this.loadExistingFileHashes(target.collectionName);
            // The writable-shared target shares the primary 8B ledger key by design
            // (buildIndexTargets already seeded its priorLedger); for canonical
            // targets, pull the per-model ledger from the map (empty when absent).
            if (target.priorLedger === undefined) {
                target.priorLedger = priorLedgersByModel?.get(target.modelId) ?? new Map();
            }
        }

        // Per-target accounting (M8 — each target tracks its own progress so
        // completeness is per (file × model)).
        type Acc = {
            fileChunkTotals: Map<string, number>;
            fileProgress: Map<string, { produced: number; inserted: number }>;
            fileHashByPath: Map<string, string>;
            firedComplete: Set<string>;
            buffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>;
            consecutiveBatchErrors: number;
            // Fix 2 (per-target abort isolation): once a NON-primary target hits
            // MAX_CONSECUTIVE_BATCH_ERRORS it is DROPPED — no more buffering/flushing
            // for the rest of the run — while the primary (and any healthy target)
            // continues. The primary never sets this; its abort fails the whole run.
            dropped: boolean;
        };
        const acc = new Map<string, Acc>();
        for (const t of targets) {
            acc.set(t.modelId, {
                fileChunkTotals: new Map(), fileProgress: new Map(), fileHashByPath: new Map(),
                firedComplete: new Set(), buffer: [], consecutiveBatchErrors: 0, dropped: false,
            });
        }

        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let skippedAllTargets = 0;
        let changedAnyTarget = 0;

        // Fix 1: the SINGLE ledger-fire gate. The synthetic writable-shared target
        // STILL participates in all buffer/flush/abort accounting, but its ledger is
        // never read back (its priorLedger is seeded from the primary 8B ledger), so
        // firing onFileComplete for it would only grow write-only dead weight on the
        // SHARED snapshot. Every onFileComplete call in this method routes through
        // here so the synthetic key is suppressed in exactly one place.
        const fireLedger = (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => {
            if (modelId === WRITABLE_SHARED_MODEL_ID) return;   // Fix 1: never write a ledger for the synthetic key
            onFileComplete?.(modelId, relativePath, info);
        };

        // Fire complete:true for files whose FULL splitter output has been embedded
        // AND inserted FOR A GIVEN TARGET. Per target (M8). The local firedComplete
        // bookkeeping is kept for ALL targets (incl. writable-shared) so the end-of-
        // run sweep does not re-evaluate them; only the onFileComplete LEDGER write
        // is gated by fireLedger (Fix 1).
        const fireCompletedFor = (target: IndexTarget) => {
            if (!onFileComplete) return;
            const a = acc.get(target.modelId)!;
            for (const [rp, p] of a.fileProgress) {
                if (a.firedComplete.has(rp)) continue;
                const total = a.fileChunkTotals.get(rp);
                if (total !== undefined && p.produced === p.inserted && p.produced === total) {
                    fireLedger(target.modelId, rp, { complete: true, fileHash: a.fileHashByPath.get(rp) ?? '', chunkCount: p.inserted });
                    a.firedComplete.add(rp);
                }
            }
        };

        // Fix 2 (per-target abort isolation) — DROP a single NON-primary target.
        // Mark its accumulator dropped (so it is excluded from needers/flush for the
        // rest of the run), then write complete:false for every file it had started
        // but not yet completed (in-flight + this-file's chunks), so a LATER run
        // resumes it. For the synthetic writable-shared key fireLedger is a no-op
        // (Fix 1), so this is just a "drop + clear buffer + log" with no ledger
        // write. The PRIMARY is NEVER passed here — its abort fails the whole run.
        const dropTarget = (target: IndexTarget, reason: string) => {
            const a = acc.get(target.modelId)!;
            a.dropped = true;
            a.buffer = [];   // stop flushing this target
            // Recovery: any file this target produced chunks for but did NOT fire
            // complete:true for is now incomplete → complete:false (next run resumes
            // it). The sweep is skipped for dropped targets, so do it here.
            for (const [rp] of a.fileChunkTotals) {
                if (a.firedComplete.has(rp)) continue;
                fireLedger(target.modelId, rp, { complete: false, fileHash: a.fileHashByPath.get(rp) ?? '', chunkCount: 0 });
                a.firedComplete.add(rp);
            }
            console.error(
                `[Context] ⚠️  [${target.modelId}] DROPPED non-primary target after ${reason}; ` +
                `the primary (and any healthy target) continue. Files in-flight for this target ` +
                `marked complete:false for resume on a later run.`,
            );
        };

        // Flush one target's buffer through processChunkBuffer with that target's
        // OWN three-way abort counter. Per-target abort ISOLATION (Fix 2):
        //   - PRIMARY (DEFAULT_PRIMARY_MODEL_ID) hits MAX → throw the typed
        //     IndexAbortError sentinel; the outer per-file catch re-throws it and the
        //     WHOLE run aborts (no point continuing if the primary is dead).
        //   - ANY NON-primary target (0.6B secondary AND the synthetic writable-
        //     shared) hits MAX → DROP only that target (dropTarget) and return
        //     WITHOUT throwing, so the primary and any other healthy target run to
        //     completion. 0.6B is the optional/resilient path — its death must never
        //     take the 8B index down.
        // A dropped target is skipped before it ever reaches here (guarded at the
        // buffer/flush call sites), but the early-return below is belt-and-braces.
        const flushTarget = async (target: IndexTarget, isFinal: boolean) => {
            const a = acc.get(target.modelId)!;
            if (a.dropped) return;            // Fix 2: dropped targets do not flush
            if (a.buffer.length === 0) return;
            const r = await this.processChunkBuffer(target, a.buffer);
            a.buffer = [];
            this.mergeFileProgress(a.fileProgress, r.perFile);
            fireCompletedFor(target);
            if (r.realFailures > 0) {
                a.consecutiveBatchErrors++;
                const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
                console.error(
                    `[Context] ❌ [${target.modelId}] ${isFinal ? 'Final ' : ''}chunk batch for ${searchType} had ${r.realFailures} ` +
                    `REAL-class slot failure(s) (${a.consecutiveBatchErrors}/${MAX_CONSECUTIVE_BATCH_ERRORS} consecutive)`,
                );
                if (a.consecutiveBatchErrors >= MAX_CONSECUTIVE_BATCH_ERRORS) {
                    if (target.modelId === DEFAULT_PRIMARY_MODEL_ID) {
                        throw this.makeAbortError(MAX_CONSECUTIVE_BATCH_ERRORS);   // primary death aborts the whole run
                    }
                    // Non-primary: isolate — drop this target, keep the run alive.
                    dropTarget(target, `${MAX_CONSECUTIVE_BATCH_ERRORS} consecutive REAL-class chunk-batch failures`);
                    return;
                }
            } else if (r.successes > 0) {
                a.consecutiveBatchErrors = 0;
            }
            // pure WAIT-class: neutral.
        };

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];
            try {
                const relativePath = path.relative(codebasePath, filePath);
                const fileHash = await this.computeFileHash(filePath);

                // ── Per-target skip decision (M8) ──
                // A target "needs" the file unless Milvus has it at this hash AND
                // that target's ledger says complete:true at the SAME hash.
                const needers: IndexTarget[] = [];
                for (const target of targets) {
                    // Fix 2: a DROPPED non-primary target is out for the rest of the
                    // run — never a needer, no re-fire (its ledger must NOT be
                    // falsely re-asserted complete after the drop).
                    if (acc.get(target.modelId)!.dropped) continue;
                    const existingHash = target.existingHashes!.get(relativePath);
                    const led = target.priorLedger!.get(relativePath);
                    const verifiedComplete = existingHash === fileHash && led?.complete === true && led.fileHash === fileHash;
                    if (verifiedComplete) {
                        // Re-fire so the per-model ledger entry survives this run's
                        // snapshot rewrite (P46, now per target). Routed through
                        // fireLedger so the synthetic writable-shared key writes no
                        // ledger (Fix 1).
                        fireLedger(target.modelId, relativePath, { complete: true, fileHash, chunkCount: led!.chunkCount ?? 0 });
                        acc.get(target.modelId)!.firedComplete.add(relativePath);
                    } else {
                        needers.push(target);
                    }
                }

                if (needers.length === 0) {
                    // Every target already has this file complete at this hash.
                    skippedAllTargets++;
                    processedFiles++;
                    onFileProcessed?.(filePath, i + 1, filePaths.length);
                    continue;
                }
                changedAnyTarget++;

                // ── Per-target delete-on-change (LD-6 / P1) ──
                // Each NEEDING target deletes from its OWN collection only when its
                // OWN existingHash !== fileHash; on a delete failure that target's
                // ledger is marked complete:false for recovery. Pass fireLedger (not
                // raw onFileComplete) so the synthetic writable-shared key is gated
                // out of the recovery ledger write too (Fix 1).
                await this.deleteChangedForTargets(needers, relativePath, fileHash, fireLedger);

                // ── AST split ONCE (model-independent) ──
                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);

                // Inject fileHash into each chunk's metadata (model-blind; both
                // targets reuse the same chunk objects — embedBatchPartial only
                // reads .content). Record per-target totals/hash for needing targets.
                for (const chunk of chunks) {
                    chunk.metadata = { ...chunk.metadata, fileHash };
                }
                for (const target of needers) {
                    const a = acc.get(target.modelId)!;
                    a.fileChunkTotals.set(relativePath, chunks.length);
                    a.fileHashByPath.set(relativePath, fileHash);
                }

                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Push chunks into EACH needing target's buffer; flush per target
                // when that target's buffer fills. totalChunks counts splitter work
                // ONCE (chunk-limit guard is model-independent).
                // Fix 2: a target dropped mid-file (by a flush within THIS loop) is
                // skipped for all remaining chunks — no more buffering for it. Only a
                // PRIMARY flush throws (whole-run abort); a non-primary flush returns
                // after dropping, so the loop keeps feeding the healthy targets.
                // KNOWN FOLLOW-UP (deferred): the targets are flushed sequentially in
                // this per-chunk loop, so a slow 0.6B flush latency is coupled into
                // the 8B path. A future change could flush targets concurrently /
                // decouple buffers per target. Not addressed here (Phase 2+3 quality).
                for (const chunk of chunks) {
                    for (const target of needers) {
                        const a = acc.get(target.modelId)!;
                        if (a.dropped) continue;                 // Fix 2: stop buffering a dropped target
                        a.buffer.push({ chunk, codebasePath, relativePath });
                        if (a.buffer.length >= EMBEDDING_BATCH_SIZE) {
                            await flushTarget(target, false);
                        }
                    }
                    totalChunks++;
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break;
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);
                if (limitReached) break;

            } catch (error) {
                if (this.isAbortError(error)) {
                    // Fix 2: ONLY a PRIMARY abort reaches here (flushTarget throws the
                    // sentinel only for DEFAULT_PRIMARY_MODEL_ID; non-primary targets
                    // are dropped in place and never throw). Re-throw so the whole run
                    // unwinds to handlers.ts → indexfailed.
                    throw error;
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Final per-target buffer flush.
        for (const target of targets) {
            const a = acc.get(target.modelId)!;
            if (a.buffer.length > 0) {
                const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
                console.log(`📝 [${target.modelId}] Processing final batch of ${a.buffer.length} chunks for ${searchType}`);
                await flushTarget(target, true);
            }
        }

        // End-of-run completeness sweep, per target (covers 0-chunk files and
        // partial/truncated files; iterate fileChunkTotals not fileProgress).
        // Fix 1: routed through fireLedger so the synthetic writable-shared key
        // writes no ledger. Fix 2: DROPPED non-primary targets are skipped — the
        // drop handler already marked their in-flight/remaining files complete:false
        // for recovery, so re-sweeping here would re-fire (and could mask the drop).
        if (onFileComplete) {
            for (const target of targets) {
                const a = acc.get(target.modelId)!;
                if (a.dropped) continue;
                for (const [rp, total] of a.fileChunkTotals) {
                    if (a.firedComplete.has(rp)) continue;
                    const p = a.fileProgress.get(rp) ?? { produced: 0, inserted: 0 };
                    const complete = p.produced === p.inserted && p.produced === total;
                    fireLedger(target.modelId, rp, { complete, fileHash: a.fileHashByPath.get(rp) ?? '', chunkCount: p.inserted });
                    a.firedComplete.add(rp);
                }
            }
        }

        const anyExisting = targets.some(t => (t.existingHashes?.size ?? 0) > 0);
        if (anyExisting) {
            console.log(`[Context] 📊 Incremental indexing: ${skippedAllTargets} files complete in ALL targets (skipped), ${changedAnyTarget} files needed ≥1 target, ${filePaths.length - skippedAllTargets - changedAnyTarget} files new`);
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
    }

    /**
     * Per-target delete-on-change with recovery (LD-6 + P1). Called inside the
     * per-file loop for the NEEDING targets only. Each target deletes from its OWN
     * collection only when its OWN existingHash !== fileHash (a CHANGED file's PKs
     * rotate, orphaning the old rows). The writable-shared target (if present) is
     * just another IndexTarget here, so it deletes from the shared collection in
     * its own iteration — there is no monolithic private+shared delete (P1).
     *
     * On a target delete FAILURE: write a complete:false ledger entry for THAT
     * target so the next run re-sweeps that target (pair every abort with
     * recovery — no silent warn-and-continue). The other targets are unaffected.
     *
     * The recovery write is routed through the caller's `fireLedger` closure, NOT
     * the raw onFileComplete, so the synthetic writable-shared key writes no ledger
     * (Fix 1) — a delete failure on the shared collection just gets retried next
     * run via the primary's ledger, never a synthetic-key entry.
     */
    private async deleteChangedForTargets(
        targets: IndexTarget[],
        relativePath: string,
        fileHash: string,
        fireLedger?: (modelId: string, relativePath: string, info: { complete: boolean; fileHash: string; chunkCount: number }) => void,
    ): Promise<void> {
        // TODO(dual-embedding follow-up): qualify shared-collection delete by
        // codebasePath. The writable-shared delete filter uses relativePath alone,
        // so two projects with the same relativePath alias each other's rows in the
        // shared collection. Pre-existing behavior — documented, not changed here.
        const escapedPath = relativePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        for (const target of targets) {
            const existingHash = target.existingHashes?.get(relativePath);
            if (existingHash && existingHash !== fileHash) {
                try {
                    await this.vectorDatabase.deleteByFilter(
                        target.collectionName,
                        `relativePath == "${escapedPath}"`,
                    );
                    console.log(`[Context] 🗑️  [${target.modelId}] Deleted stale chunks for ${relativePath} from ${target.collectionName}`);
                } catch (delError) {
                    // Recovery, not silent warn: mark this file incomplete in THIS
                    // target's ledger so the next run re-embeds it for this target.
                    console.error(`[Context] ❌ [${target.modelId}] Delete-on-change FAILED for ${relativePath} in ${target.collectionName}; marking complete:false for recovery:`, delError);
                    fireLedger?.(target.modelId, relativePath, { complete: false, fileHash, chunkCount: 0 });
                }
            }
        }
    }

    /**
     * Merge a BatchOutcome.perFile tally into a running accumulator, keyed by
     * relativePath. Used by processFileList to thread per-file accounting
     * across batches (the fileProgress map). Accumulated now; not yet read for
     * completeness (Commit 3).
     */
    private mergeFileProgress(
        acc: Map<string, { produced: number; inserted: number }>,
        perFile: Map<string, { produced: number; inserted: number }>,
    ): void {
        for (const [rp, { produced, inserted }] of perFile) {
            const cur = acc.get(rp) || { produced: 0, inserted: 0 };
            cur.produced += produced;
            cur.inserted += inserted;
            acc.set(rp, cur);
        }
    }

    /**
     * Build the sentinel abort error thrown when MAX_CONSECUTIVE_BATCH_ERRORS
     * REAL-class chunk-batch failures occur in a row. Tagged so the per-file
     * skip handler in processFileList re-throws it instead of swallowing it.
     */
    private makeAbortError(maxConsecutive: number): IndexAbortError {
        const err = new Error(
            `Aborting indexing: ${maxConsecutive} consecutive REAL-class chunk-batch failures.`,
        ) as IndexAbortError;
        err.__isIndexAbort = true;
        return err;
    }

    /**
     * Whether an error is the MAX-consecutive abort sentinel (must propagate
     * past the per-file skip handler to handlers.ts → indexfailed). Delegates to
     * the typed {@link isIndexAbort} guard (Fix 4).
     */
    private isAbortError(error: unknown): error is IndexAbortError {
        return isIndexAbort(error);
    }

    /**
     * Process accumulated chunk buffer for a SINGLE IndexTarget (M7). Forwards
     * the FULL tuple plus the target to processChunkBatch and returns its
     * BatchOutcome so per-file accounting survives. Does NOT throw for per-slot
     * embedding faults — those are classified inside the returned outcome.
     */
    private async processChunkBuffer(
        target: IndexTarget,
        chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>,
    ): Promise<BatchOutcome> {
        if (chunkBuffer.length === 0) {
            return { perFile: new Map(), realFailures: 0, waitFailures: 0, successes: 0 };
        }

        // Estimate tokens (rough estimation: 1 token ≈ 4 characters)
        const estimatedTokens = chunkBuffer.reduce(
            (sum, item) => sum + Math.ceil(item.chunk.content.length / 4),
            0,
        );

        const searchType = target.isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 [${target.modelId}] Processing batch of ${chunkBuffer.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        return this.processChunkBatch(target, chunkBuffer);
    }

    /**
     * Process a batch of chunks for ONE IndexTarget with partial-tolerant
     * embedding (M7 + P1).
     *
     * Reads target.embedding for BOTH the expectedDim rogue-dimension guard AND
     * embedBatchPartial, and target.collectionName for the upsert. The
     * BatchOutcome / REAL-vs-WAIT classification is unchanged and is per target,
     * so the three-way abort counter is evaluated per target by the caller
     * (per-target abort isolation: an 8B REAL-abort throws only inside the 8B
     * target's loop; the 0.6B pass runs in its own loop iteration — see
     * processFileList M7/M8). The residual inline writable-shared upsert is GONE:
     * writable-shared is written ONLY as its own same-instance IndexTarget (added
     * by buildIndexTargets when MILVUS_WRITABLE_SHARED is set), so a chunk is
     * never double-written into one collection (P1 — else duplicate-PK).
     */
    private async processChunkBatch(
        target: IndexTarget,
        items: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>,
    ): Promise<BatchOutcome> {
        const isHybrid = target.isHybrid;
        const codebasePath = items[0].codebasePath;
        const expectedDim = target.embedding.getDimension();

        const perFile = new Map<string, { produced: number; inserted: number }>();
        const bump = (rp: string, key: 'produced' | 'inserted', n = 1) => {
            const cur = perFile.get(rp) || { produced: 0, inserted: 0 };
            cur[key] += n;
            perFile.set(rp, cur);
        };

        // Every item is "produced" — we attempted to embed it.
        for (const item of items) {
            bump(item.relativePath, 'produced');
        }

        let realFailures = 0;
        let waitFailures = 0;

        // Base providers (OpenAI/Voyage/Gemini/Ollama) use the default embedBatchPartial,
        // which wraps an all-or-nothing embedBatch — a whole-batch embed failure throws here.
        // Catch it and convert to a REAL batch failure (symmetric with the insert-throw path
        // below) so (a) the three-way abort counter still advances for non-RabbitMQ providers
        // — otherwise a melting-down provider would be swallowed file-by-file forever, the exact
        // zombie-indexer failure mode the MAX-consecutive guard exists to prevent — and (b) the
        // caller's unconditional `chunkBuffer = []` reset always runs (processChunkBatch returns
        // instead of throwing).
        let results: EmbedItemResult[];
        try {
            results = await target.embedding.embedBatchPartial(items.map(it => it.chunk.content));
        } catch (embedErr) {
            console.error(
                `[Context] ❌ [${target.modelId}] Whole-batch embed failed (REAL): ${embedErr instanceof Error ? embedErr.message : String(embedErr)}`,
            );
            return { perFile, realFailures: items.length, waitFailures: 0, successes: 0 };
        }

        // Partition into succeeded slots (paired with their source item) and
        // classify failed slots. Build docs ONLY from succeeded slots using
        // paired indices — the document shape is identical to the pre-Commit-2
        // hybrid / non-hybrid mapping.
        const docs: VectorDocument[] = [];
        const docItems: Array<{ relativePath: string }> = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const res = results[i];

            if (res && res.ok === true) {
                // Defense-in-depth: a rogue worker can return ok=true with a
                // wrong-dimension vector (2026-05-05 incident). Treat that as a
                // REAL bad-dimension fault and do NOT insert it.
                if (!Array.isArray(res.vector) || res.vector.length !== expectedDim) {
                    console.error(
                        `[Context] ❌ [${target.modelId}] Rogue dimension on ok slot ${i}: got ${res.vector?.length}, expected ${expectedDim} (bad-dimension, REAL)`,
                    );
                    realFailures++;
                    continue;
                }

                const chunk = item.chunk;
                if (!chunk.metadata.filePath) {
                    throw new Error(`Missing filePath in chunk metadata at index ${i}`);
                }

                const relativePath = path.relative(codebasePath, chunk.metadata.filePath);
                const fileExtension = path.extname(chunk.metadata.filePath);
                const { filePath, startLine, endLine, ...restMetadata } = chunk.metadata;

                const doc: VectorDocument = {
                    id: this.generateId(relativePath, chunk.metadata.startLine || 0, chunk.metadata.endLine || 0, chunk.content),
                    content: chunk.content, // Full text content for BM25 and storage
                    vector: res.vector, // Dense vector (paired, not positional re-index)
                    relativePath,
                    startLine: chunk.metadata.startLine || 0,
                    endLine: chunk.metadata.endLine || 0,
                    fileExtension,
                    metadata: {
                        ...restMetadata,
                        codebasePath,
                        language: chunk.metadata.language || 'unknown',
                        chunkIndex: i
                    }
                };
                docs.push(doc);
                docItems.push({ relativePath: item.relativePath });
            } else {
                const reason: EmbedReason = res && res.ok === false ? res.reason : 'worker-error';
                if (REAL_REASONS.has(reason)) {
                    realFailures++;
                } else {
                    waitFailures++;
                }
            }
        }

        let successes = 0;

        if (docs.length > 0) {
            try {
                // Idempotent native upsert into THIS target's collection only
                // (insert-or-overwrite by deterministic PK). upsert/upsertHybrid
                // THROW on a non-Success Milvus result; a throw means NONE of these
                // docs landed, so the whole batch's docs count as REAL upsert-error
                // failures. (P1: no inline writable-shared dual-write here —
                // writable-shared is its own IndexTarget when configured.)
                if (isHybrid === true) {
                    await this.vectorDatabase.upsertHybrid(target.collectionName, docs);
                } else {
                    await this.vectorDatabase.upsert(target.collectionName, docs);
                }
                // Confirmed upserted — tally per file.
                for (const di of docItems) {
                    bump(di.relativePath, 'inserted');
                    successes++;
                }
            } catch (insertError) {
                // Classify the failed upsert as REAL (insert-error) for every
                // doc and return the outcome so the three-way counter decides.
                console.error(`[Context] ❌ [${target.modelId}] Upsert failed for batch (${docs.length} docs) into ${target.collectionName}, counting as REAL insert-error:`, insertError);
                realFailures += docs.length;
            }
        }

        return { perFile, realFailures, waitFailures, successes };
    }

    /**
     * Get programming language based on file extension
     */
    private getLanguageFromExtension(ext: string): string {
        const languageMap: Record<string, string> = {
            '.ts': 'typescript',
            '.tsx': 'typescript',
            '.js': 'javascript',
            '.jsx': 'javascript',
            '.py': 'python',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
            '.h': 'c',
            '.hpp': 'cpp',
            '.cs': 'csharp',
            '.go': 'go',
            '.rs': 'rust',
            '.php': 'php',
            '.rb': 'ruby',
            '.swift': 'swift',
            '.kt': 'kotlin',
            '.scala': 'scala',
            '.m': 'objective-c',
            '.mm': 'objective-c',
            '.dart': 'dart',
            '.sol': 'solidity',
            '.ipynb': 'jupyter'
        };
        return languageMap[ext] || 'text';
    }

    /**
     * Generate unique ID based on chunk content and location
     * @param relativePath Relative path to the file
     * @param startLine Start line number
     * @param endLine End line number
     * @param content Chunk content
     * @returns Hash-based unique ID
     */
    private generateId(relativePath: string, startLine: number, endLine: number, content: string): string {
        const combinedString = `${relativePath}:${startLine}:${endLine}:${content}`;
        const hash = crypto.createHash('sha256').update(combinedString, 'utf-8').digest('hex');
        return `chunk_${hash.substring(0, 16)}`;
    }

    /**
     * Read ignore patterns from file (e.g., .gitignore)
     * @param filePath Path to the ignore file
     * @returns Array of ignore patterns
     */
    static async getIgnorePatternsFromFile(filePath: string): Promise<string[]> {
        try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Filter out empty lines and comments
        } catch (error) {
            console.warn(`[Context] ⚠️  Could not read ignore file ${filePath}: ${error}`);
            return [];
        }
    }

    /**
     * Load ignore patterns from various ignore files in the codebase
     * This method preserves any existing custom patterns that were added before
     * @param codebasePath Path to the codebase
     */
    private async loadIgnorePatterns(codebasePath: string): Promise<void> {
        try {
            let fileBasedPatterns: string[] = [];

            // Load all .xxxignore files in codebase directory
            const ignoreFiles = await this.findIgnoreFiles(codebasePath);
            for (const ignoreFile of ignoreFiles) {
                const patterns = await this.loadIgnoreFile(ignoreFile, path.basename(ignoreFile));
                fileBasedPatterns.push(...patterns);
            }

            // Load global ~/.context/.contextignore
            const globalIgnorePatterns = await this.loadGlobalIgnoreFile();
            fileBasedPatterns.push(...globalIgnorePatterns);

            // Merge file-based patterns with existing patterns (which may include custom MCP patterns)
            if (fileBasedPatterns.length > 0) {
                this.addCustomIgnorePatterns(fileBasedPatterns);
                console.log(`[Context] 🚫 Loaded total ${fileBasedPatterns.length} ignore patterns from all ignore files`);
            } else {
                console.log('📄 No ignore files found, keeping existing patterns');
            }

            // Load .contextinclude for dot-directory inclusion
            await this.loadIncludeDotDirs(codebasePath);
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to load ignore patterns: ${error}`);
            // Continue with existing patterns on error - don't reset them
        }
    }

    /**
     * Load .contextinclude file to find dot-prefixed directories to include in indexing.
     * Each line in the file specifies a dot-prefixed directory name (e.g., .opencode).
     */
    private async loadIncludeDotDirs(codebasePath: string): Promise<void> {
        const includeFilePath = path.join(codebasePath, '.contextinclude');
        try {
            await fs.promises.access(includeFilePath);
            const content = await fs.promises.readFile(includeFilePath, 'utf-8');
            const dirs = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'))
                .map(d => d.replace(/\/+$/, ''));

            if (dirs.length > 0) {
                // Merge with existing includeDotDirs (dedup)
                const combined = new Set([...this.includeDotDirs, ...dirs]);
                this.includeDotDirs = [...combined];
                console.log(`[Context] 📂 Loaded ${dirs.length} include-dot-dirs from .contextinclude: ${dirs.join(', ')}`);
            }
        } catch {
            // .contextinclude is optional
        }
    }

    /**
     * Find all .xxxignore files in the codebase directory
     * @param codebasePath Path to the codebase
     * @returns Array of ignore file paths
     */
    private async findIgnoreFiles(codebasePath: string): Promise<string[]> {
        // Skip ignore files that are not relevant to code indexing
        const SKIP_IGNORE_FILES = new Set(['.dockerignore']);

        try {
            const entries = await fs.promises.readdir(codebasePath, { withFileTypes: true });
            const ignoreFiles: string[] = [];

            for (const entry of entries) {
                if (entry.isFile() &&
                    entry.name.startsWith('.') &&
                    entry.name.endsWith('ignore') &&
                    !SKIP_IGNORE_FILES.has(entry.name)) {
                    ignoreFiles.push(path.join(codebasePath, entry.name));
                }
            }

            if (ignoreFiles.length > 0) {
                console.log(`📄 Found ignore files: ${ignoreFiles.map(f => path.basename(f)).join(', ')}`);
            }

            return ignoreFiles;
        } catch (error) {
            console.warn(`[Context] ⚠️ Failed to scan for ignore files: ${error}`);
            return [];
        }
    }

    /**
     * Load global ignore file from ~/.context/.contextignore
     * @returns Array of ignore patterns
     */
    private async loadGlobalIgnoreFile(): Promise<string[]> {
        try {
            const homeDir = require('os').homedir();
            const globalIgnorePath = path.join(homeDir, '.context', '.contextignore');
            return await this.loadIgnoreFile(globalIgnorePath, 'global .contextignore');
        } catch (error) {
            // Global ignore file is optional, don't log warnings
            return [];
        }
    }

    /**
     * Load ignore patterns from a specific ignore file
     * @param filePath Path to the ignore file
     * @param fileName Display name for logging
     * @returns Array of ignore patterns
     */
    private async loadIgnoreFile(filePath: string, fileName: string): Promise<string[]> {
        try {
            await fs.promises.access(filePath);
            console.log(`📄 Found ${fileName} file at: ${filePath}`);

            const ignorePatterns = await Context.getIgnorePatternsFromFile(filePath);

            if (ignorePatterns.length > 0) {
                console.log(`[Context] 🚫 Loaded ${ignorePatterns.length} ignore patterns from ${fileName}`);
                return ignorePatterns;
            } else {
                console.log(`📄 ${fileName} file found but no valid patterns detected`);
                return [];
            }
        } catch (error) {
            if (fileName.includes('global')) {
                console.log(`📄 No ${fileName} file found`);
            }
            return [];
        }
    }

    /**
     * Check if a path matches any ignore pattern
     * @param filePath Path to check
     * @param basePath Base path for relative pattern matching
     * @returns True if path should be ignored
     */
    private matchesIgnorePattern(filePath: string, basePath: string): boolean {
        const relativePath = path.relative(basePath, filePath);

        // Always ignore dotfiles/dotdirs to stay aligned with
        // FileSynchronizer.shouldIgnore. If these traversals diverge, files
        // indexed here are never hashed by the synchronizer and their stale
        // chunks linger in Milvus forever.
        if (relativePath.split(path.sep).some(part => part.startsWith('.'))) {
            return true;
        }

        if (this.ignorePatterns.length === 0) {
            return false;
        }

        const normalizedPath = relativePath.replace(/\\/g, '/'); // Normalize path separators

        for (const pattern of this.ignorePatterns) {
            if (this.isPatternMatch(normalizedPath, pattern)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Simple glob pattern matching
     * @param filePath File path to test
     * @param pattern Glob pattern
     * @returns True if pattern matches
     */
    private isPatternMatch(filePath: string, pattern: string): boolean {
        // Handle directory patterns (ending with /)
        if (pattern.endsWith('/')) {
            const dirPattern = pattern.slice(0, -1);
            const pathParts = filePath.split('/');
            return pathParts.some(part => this.simpleGlobMatch(part, dirPattern));
        }

        // Handle file patterns
        if (pattern.includes('/')) {
            // Pattern with path separator - match exact path
            return this.simpleGlobMatch(filePath, pattern);
        } else {
            // Pattern without path separator - match filename in any directory
            const fileName = path.basename(filePath);
            return this.simpleGlobMatch(fileName, pattern);
        }
    }

    /**
     * Simple glob matching supporting * wildcard
     * @param text Text to test
     * @param pattern Pattern with * wildcards
     * @returns True if pattern matches
     */
    private simpleGlobMatch(text: string, pattern: string): boolean {
        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
            .replace(/\*/g, '.*'); // Convert * to .*

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(text);
    }

    /**
     * Get custom extensions from environment variables
     * Supports CUSTOM_EXTENSIONS as comma-separated list
     * @returns Array of custom extensions
     */
    private getCustomExtensionsFromEnv(): string[] {
        const envExtensions = envManager.get('CUSTOM_EXTENSIONS');
        if (!envExtensions) {
            return [];
        }

        try {
            const extensions = envExtensions
                .split(',')
                .map(ext => ext.trim())
                .filter(ext => ext.length > 0)
                .map(ext => ext.startsWith('.') ? ext : `.${ext}`); // Ensure extensions start with dot

            return extensions;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_EXTENSIONS: ${error}`);
            return [];
        }
    }

    /**
     * Get custom ignore patterns from environment variables  
     * Supports CUSTOM_IGNORE_PATTERNS as comma-separated list
     * @returns Array of custom ignore patterns
     */
    private getCustomIgnorePatternsFromEnv(): string[] {
        const envIgnorePatterns = envManager.get('CUSTOM_IGNORE_PATTERNS');
        if (!envIgnorePatterns) {
            return [];
        }

        try {
            const patterns = envIgnorePatterns
                .split(',')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0);

            return patterns;
        } catch (error) {
            console.warn(`[Context] ⚠️  Failed to parse CUSTOM_IGNORE_PATTERNS: ${error}`);
            return [];
        }
    }

    /**
     * Add custom extensions (from MCP or other sources) without replacing existing ones
     * @param customExtensions Array of custom extensions to add
     */
    addCustomExtensions(customExtensions: string[]): void {
        if (customExtensions.length === 0) return;

        // Ensure extensions start with dot
        const normalizedExtensions = customExtensions.map(ext =>
            ext.startsWith('.') ? ext : `.${ext}`
        );

        // Merge current extensions with new custom extensions, avoiding duplicates
        const mergedExtensions = [...this.supportedExtensions, ...normalizedExtensions];
        const uniqueExtensions: string[] = [...new Set(mergedExtensions)];
        this.supportedExtensions = uniqueExtensions;
        console.log(`[Context] 📎 Added ${customExtensions.length} custom extensions. Total: ${this.supportedExtensions.length} extensions`);
    }

    /**
     * Get current splitter information
     */
    getSplitterInfo(): { type: string; hasBuiltinFallback: boolean; supportedLanguages?: string[] } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return {
                type: 'ast',
                hasBuiltinFallback: true,
                supportedLanguages: AstCodeSplitter.getSupportedLanguages()
            };
        } else {
            return {
                type: 'langchain',
                hasBuiltinFallback: false
            };
        }
    }

    /**
     * Check if current splitter supports a specific language
     * @param language Programming language
     */
    isLanguageSupported(language: string): boolean {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            return AstCodeSplitter.isLanguageSupported(language);
        }

        // LangChain splitter supports most languages
        return true;
    }

    /**
     * Get which strategy would be used for a specific language
     * @param language Programming language
     */
    getSplitterStrategyForLanguage(language: string): { strategy: 'ast' | 'langchain'; reason: string } {
        const splitterName = this.codeSplitter.constructor.name;

        if (splitterName === 'AstCodeSplitter') {
            const { AstCodeSplitter } = require('./splitter/ast-splitter');
            const isSupported = AstCodeSplitter.isLanguageSupported(language);

            return {
                strategy: isSupported ? 'ast' : 'langchain',
                reason: isSupported
                    ? 'Language supported by AST parser'
                    : 'Language not supported by AST, will fallback to LangChain'
            };
        } else {
            return {
                strategy: 'langchain',
                reason: 'Using LangChain splitter directly'
            };
        }
    }
}
