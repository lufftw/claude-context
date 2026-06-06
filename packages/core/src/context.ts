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

export class Context {
    private embedding: Embedding;
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
     * Get the writable shared collection name from environment, if configured.
     * When set, indexing will dual-write to both private and shared collections
     * using a single embedding computation (no additional API cost).
     */
    public getWritableSharedCollectionName(): string | undefined {
        return envManager.get('MILVUS_WRITABLE_SHARED');
    }

    /**
     * Index a codebase for semantic search
     * @param codebasePath Codebase root path
     * @param progressCallback Optional progress callback function
     * @param forceReindex Whether to recreate the collection even if it exists
     * @returns Indexing statistics
     */
    async indexCodebase(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false
    ): Promise<{ indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        // Scope project-`.env` reads (MILVUS_COLLECTION_PRIVATE, _SHARED, _STRATEGY, etc.)
        // to this call only via AsyncLocalStorage. Critical for parallel safety:
        // sibling indexCodebase() calls must not see each other's project context.
        // Bug history: see docs/lufftw/bugfix-2026-05-04-envmanager-concurrency.md
        return envManager.runWithProject(codebasePath, () => this._indexCodebaseImpl(codebasePath, progressCallback, forceReindex));
    }

    private async _indexCodebaseImpl(
        codebasePath: string,
        progressCallback?: (progress: { phase: string; current: number; total: number; percentage: number }) => void,
        forceReindex: boolean = false
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
            }
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
        const collectionName = this.getCollectionName(codebasePath);
        const synchronizer = this.synchronizers.get(collectionName);

        if (!synchronizer) {
            // Load project-specific ignore patterns before creating FileSynchronizer
            await this.loadIgnorePatterns(codebasePath);

            // To be safe, let's initialize if it's not there.
            const newSynchronizer = new FileSynchronizer(codebasePath, this.ignorePatterns, this.includeDotDirs, this.supportedExtensions);
            await newSynchronizer.initialize();
            this.synchronizers.set(collectionName, newSynchronizer);
        }

        const currentSynchronizer = this.synchronizers.get(collectionName)!;

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

        // Handle removed files
        for (const file of removed) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Removed ${file}`);
        }

        // Handle modified files
        for (const file of modified) {
            await this.deleteFileChunks(collectionName, file);
            updateProgress(`Deleted old chunks for ${file}`);
        }

        // Handle added and modified files
        const filesToIndex = [...added, ...modified].map(f => path.join(codebasePath, f));

        if (filesToIndex.length > 0) {
            await this.processFileList(
                filesToIndex,
                codebasePath,
                (filePath, fileIndex, totalFiles) => {
                    updateProgress(`Indexed ${filePath} (${fileIndex}/${totalFiles})`);
                }
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
    async semanticSearch(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        // Scope project-`.env` reads to this call (parallel-safe via AsyncLocalStorage)
        return envManager.runWithProject(codebasePath, () => this._semanticSearchImpl(codebasePath, query, topK, threshold, filterExpr));
    }

    private async _semanticSearchImpl(codebasePath: string, query: string, topK: number = 5, threshold: number = 0.5, filterExpr?: string): Promise<SemanticSearchResult[]> {
        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid search' : 'semantic search';
        console.log(`[Context] 🔍 Executing ${searchType}: "${query}" in ${codebasePath}`);

        const collectionName = this.getCollectionName(codebasePath);
        const sharedCollectionName = this.getSharedCollectionName();
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

            // 1. Generate query vector (once, reused for all collections)
            console.log(`[Context] 🔍 Generating embeddings for query: "${query}"`);
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
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
            const queryEmbedding: EmbeddingVector = await this.embedding.embed(query);
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

        const collectionName = this.getCollectionName(codebasePath);
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        progressCallback?.({ phase: 'Removing index data...', current: 50, total: 100, percentage: 50 });

        if (collectionExists) {
            await this.vectorDatabase.dropCollection(collectionName);
        }

        // Delete snapshot file
        await FileSynchronizer.deleteSnapshot(codebasePath);

        progressCallback?.({ phase: 'Index cleared', current: 100, total: 100, percentage: 100 });
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
     * Prepare vector collection
     */
    private async prepareCollection(codebasePath: string, forceReindex: boolean = false): Promise<void> {
        const isHybrid = this.getIsHybrid();
        const collectionType = isHybrid === true ? 'hybrid vector' : 'vector';
        console.log(`[Context] 🔧 Preparing ${collectionType} collection for codebase: ${codebasePath}${forceReindex ? ' (FORCE REINDEX)' : ''}`);
        const collectionName = this.getCollectionName(codebasePath);

        // Check if collection already exists
        const collectionExists = await this.vectorDatabase.hasCollection(collectionName);

        if (collectionExists && !forceReindex) {
            console.log(`📋 Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        if (collectionExists && forceReindex) {
            console.log(`[Context] 🗑️  Dropping existing collection ${collectionName} for force reindex...`);
            await this.vectorDatabase.dropCollection(collectionName);
            console.log(`[Context] ✅ Collection ${collectionName} dropped successfully`);
        }

        console.log(`[Context] 🔍 Detecting embedding dimension for ${this.embedding.getProvider()} provider...`);
        const dimension = await this.embedding.detectDimension();
        console.log(`[Context] 📏 Detected dimension: ${dimension} for ${this.embedding.getProvider()}`);
        const dirName = path.basename(codebasePath);

        if (isHybrid === true) {
            await this.vectorDatabase.createHybridCollection(collectionName, dimension, `codebasePath:${codebasePath}`);
        } else {
            await this.vectorDatabase.createCollection(collectionName, dimension, `codebasePath:${codebasePath}`);
        }

        console.log(`[Context] ✅ Collection ${collectionName} created successfully (dimension: ${dimension})`);

        // Also prepare writable shared collection if configured (dual-write support)
        const writableShared = this.getWritableSharedCollectionName();
        if (writableShared && writableShared !== collectionName) {
            const sharedExists = await this.vectorDatabase.hasCollection(writableShared);
            if (!sharedExists) {
                console.log(`[Context] 🔧 Also preparing writable shared collection: ${writableShared}`);
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
        onFileProcessed?: (filePath: string, fileIndex: number, totalFiles: number) => void
    ): Promise<{ processedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }> {
        const isHybrid = this.getIsHybrid();
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

        // ── Incremental indexing: load existing file hashes ──
        const collectionName = this.getCollectionName(codebasePath);
        const existingHashes = await this.loadExistingFileHashes(collectionName);
        let skippedFiles = 0;
        let changedFiles = 0;
        let deletedChunkFiles = 0;

        let chunkBuffer: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }> = [];
        let processedFiles = 0;
        let totalChunks = 0;
        let limitReached = false;
        let consecutiveBatchErrors = 0;

        // Per-file accounting threaded through the batch reducer (Commit 2/4).
        //  - fileChunkTotals: how many chunks the splitter produced per file.
        //  - fileProgress:    cumulative produced/inserted as batches drain.
        // Both accumulate here but are NOT yet read for completeness; the
        // snapshot completeness ledger / onFileComplete wiring is Commit 3.
        const fileChunkTotals = new Map<string, number>();
        const fileProgress = new Map<string, { produced: number; inserted: number }>();

        for (let i = 0; i < filePaths.length; i++) {
            const filePath = filePaths[i];

            try {
                // ── File hash check: skip unchanged files ──
                const relativePath = path.relative(codebasePath, filePath);
                const fileHash = await this.computeFileHash(filePath);
                const existingHash = existingHashes.get(relativePath);

                if (existingHash === fileHash) {
                    skippedFiles++;
                    processedFiles++;
                    onFileProcessed?.(filePath, i + 1, filePaths.length);
                    continue;  // File unchanged — skip embedding entirely
                }

                // File is new or changed — delete old chunks if they exist
                if (existingHash) {
                    changedFiles++;
                    try {
                        const escapedPath = relativePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        await this.vectorDatabase.deleteByFilter(
                            collectionName,
                            `relativePath == "${escapedPath}"`
                        );
                        // Also delete from shared collection if dual-write is enabled
                        const writableShared = this.getWritableSharedCollectionName();
                        if (writableShared && writableShared !== collectionName) {
                            await this.vectorDatabase.deleteByFilter(
                                writableShared,
                                `relativePath == "${escapedPath}"`
                            );
                        }
                        deletedChunkFiles++;
                    } catch (delError) {
                        console.warn(`[Context] ⚠️  Failed to delete old chunks for ${relativePath}: ${delError}`);
                    }
                }

                const content = await fs.promises.readFile(filePath, 'utf-8');
                const language = this.getLanguageFromExtension(path.extname(filePath));
                const chunks = await this.codeSplitter.split(content, language, filePath);

                // Record how many chunks the splitter produced for this file so
                // a later completeness check (Commit 3) can compare against the
                // number actually inserted. Accumulated now; not yet read.
                fileChunkTotals.set(relativePath, chunks.length);

                // Inject fileHash into each chunk's metadata so future runs can skip
                for (const chunk of chunks) {
                    chunk.metadata = { ...chunk.metadata, fileHash };
                }

                // Log files with many chunks or large content
                if (chunks.length > 50) {
                    console.warn(`[Context] ⚠️  File ${filePath} generated ${chunks.length} chunks (${Math.round(content.length / 1024)}KB)`);
                } else if (content.length > 100000) {
                    console.log(`📄 Large file ${filePath}: ${Math.round(content.length / 1024)}KB -> ${chunks.length} chunks`);
                }

                // Add chunks to buffer
                for (const chunk of chunks) {
                    chunkBuffer.push({ chunk, codebasePath, relativePath });
                    totalChunks++;

                    // Process batch when buffer reaches EMBEDDING_BATCH_SIZE.
                    // The reducer no longer throws for per-slot embedding faults
                    // — it returns a BatchOutcome and we apply the three-way
                    // abort counter (REAL → ++/maybe-abort; clean+productive →
                    // reset; pure-WAIT → neutral). Only a thrown abort (or a
                    // genuinely unexpected infra error) escapes here.
                    if (chunkBuffer.length >= EMBEDDING_BATCH_SIZE) {
                        const r = await this.processChunkBuffer(chunkBuffer);
                        chunkBuffer = []; // ALWAYS reset, regardless of outcome
                        this.mergeFileProgress(fileProgress, r.perFile);
                        if (r.realFailures > 0) {
                            consecutiveBatchErrors++;
                            const searchType = isHybrid === true ? 'hybrid' : 'regular';
                            console.error(
                                `[Context] ❌ Chunk batch for ${searchType} had ${r.realFailures} ` +
                                `REAL-class slot failure(s) ` +
                                `(${consecutiveBatchErrors}/${MAX_CONSECUTIVE_BATCH_ERRORS} consecutive)`,
                            );
                            if (consecutiveBatchErrors >= MAX_CONSECUTIVE_BATCH_ERRORS) {
                                throw this.makeAbortError(MAX_CONSECUTIVE_BATCH_ERRORS);
                            }
                        } else if (r.successes > 0) {
                            // Clean, productive batch — a transient blip is forgiven.
                            consecutiveBatchErrors = 0;
                        }
                        // pure WAIT-class (realFailures===0 && successes===0):
                        // leave consecutiveBatchErrors UNCHANGED (neutral).
                    }

                    // Check if chunk limit is reached
                    if (totalChunks >= CHUNK_LIMIT) {
                        console.warn(`[Context] ⚠️  Chunk limit of ${CHUNK_LIMIT} reached. Stopping indexing.`);
                        limitReached = true;
                        break; // Exit the inner loop (over chunks)
                    }
                }

                processedFiles++;
                onFileProcessed?.(filePath, i + 1, filePaths.length);

                if (limitReached) {
                    break; // Exit the outer loop (over files)
                }

            } catch (error) {
                // The MAX-consecutive abort must NOT be swallowed by this
                // per-file skip handler — it has to propagate to the caller
                // (handlers.ts startBackgroundIndexing → indexfailed). Only
                // genuine per-file faults (unreadable file, splitter crash, an
                // unexpected infra error from a batch flush) are skipped.
                if (this.isAbortError(error)) {
                    throw error;
                }
                console.warn(`[Context] ⚠️  Skipping file ${filePath}: ${error}`);
            }
        }

        // Process any remaining chunks in the buffer.
        // Final batch is critical — if it fails we'd end up with a partial
        // index that the snapshot reports as 'completed', silently losing the
        // last EMBEDDING_BATCH_SIZE - 1 chunks. The same three-way classification
        // applies here (REAL → ++/maybe-abort; clean+productive → reset; pure-WAIT
        // → neutral). The final batch must NOT silently swallow a REAL failure.
        if (chunkBuffer.length > 0) {
            const searchType = isHybrid === true ? 'hybrid' : 'regular';
            console.log(`📝 Processing final batch of ${chunkBuffer.length} chunks for ${searchType}`);
            const r = await this.processChunkBuffer(chunkBuffer);
            chunkBuffer = [];
            this.mergeFileProgress(fileProgress, r.perFile);
            if (r.realFailures > 0) {
                consecutiveBatchErrors++;
                console.error(
                    `[Context] ❌ Final chunk batch for ${searchType} had ${r.realFailures} ` +
                    `REAL-class slot failure(s) ` +
                    `(${consecutiveBatchErrors}/${MAX_CONSECUTIVE_BATCH_ERRORS} consecutive)`,
                );
                if (consecutiveBatchErrors >= MAX_CONSECUTIVE_BATCH_ERRORS) {
                    throw this.makeAbortError(MAX_CONSECUTIVE_BATCH_ERRORS);
                }
            } else if (r.successes > 0) {
                consecutiveBatchErrors = 0;
            }
            // pure WAIT-class: neutral.
        }

        // ── Log incremental stats ──
        if (existingHashes.size > 0) {
            console.log(`[Context] 📊 Incremental indexing: ${skippedFiles} files unchanged (skipped), ${changedFiles} files changed (re-embedded), ${filePaths.length - skippedFiles - changedFiles} new files`);
            if (deletedChunkFiles > 0) {
                console.log(`[Context] 🗑️  Deleted old chunks for ${deletedChunkFiles} changed files`);
            }
        }

        return {
            processedFiles,
            totalChunks,
            status: limitReached ? 'limit_reached' : 'completed'
        };
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
    private makeAbortError(maxConsecutive: number): Error {
        const err = new Error(
            `Aborting indexing: ${maxConsecutive} consecutive REAL-class chunk-batch failures.`,
        );
        (err as any).__isIndexAbort = true;
        return err;
    }

    /**
     * Whether an error is the MAX-consecutive abort sentinel (must propagate
     * past the per-file skip handler to handlers.ts → indexfailed).
     */
    private isAbortError(error: unknown): boolean {
        return !!error && typeof error === 'object' && (error as any).__isIndexAbort === true;
    }

    /**
     * Process accumulated chunk buffer. Forwards the FULL tuple (including
     * relativePath) to processChunkBatch and returns its BatchOutcome so
     * per-file accounting survives. Does NOT throw for per-slot embedding faults
     * — those are classified inside the returned outcome.
     */
    private async processChunkBuffer(
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

        const isHybrid = this.getIsHybrid();
        const searchType = isHybrid === true ? 'hybrid' : 'regular';
        console.log(`[Context] 🔄 Processing batch of ${chunkBuffer.length} chunks (~${estimatedTokens} tokens) for ${searchType}`);
        return this.processChunkBatch(chunkBuffer);
    }

    /**
     * Process a batch of chunks with partial-tolerant embedding.
     *
     * Consumes embedBatchPartial's index-aligned per-item results, builds
     * documents from ONLY the succeeded slots (paired indices — never positional
     * re-index after dropping a slot), inserts them, and returns a BatchOutcome
     * that classifies each slot for the three-way abort counter. Per-slot
     * embedding faults and Milvus insert failures are recorded in the outcome
     * (never thrown); only genuinely unexpected conditions propagate.
     */
    private async processChunkBatch(
        items: Array<{ chunk: CodeChunk; codebasePath: string; relativePath: string }>,
    ): Promise<BatchOutcome> {
        const isHybrid = this.getIsHybrid();
        const codebasePath = items[0].codebasePath;
        const expectedDim = this.embedding.getDimension();

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

        const results: EmbedItemResult[] = await this.embedding.embedBatchPartial(
            items.map(it => it.chunk.content),
        );

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
                        `[Context] ❌ Rogue dimension on ok slot ${i}: got ${res.vector?.length}, expected ${expectedDim} (bad-dimension, REAL)`,
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
            const collectionName = this.getCollectionName(codebasePath);
            const writableShared = this.getWritableSharedCollectionName();
            try {
                // Commit 1 made insert/insertHybrid THROW on a non-Success
                // Milvus result. A throw here means NONE of these docs landed,
                // so the whole batch's docs count as REAL insert-error failures.
                if (isHybrid === true) {
                    await this.vectorDatabase.insertHybrid(collectionName, docs);
                    if (writableShared && writableShared !== collectionName) {
                        await this.vectorDatabase.insertHybrid(writableShared, docs);
                    }
                } else {
                    await this.vectorDatabase.insert(collectionName, docs);
                    if (writableShared && writableShared !== collectionName) {
                        await this.vectorDatabase.insert(writableShared, docs);
                    }
                }
                // Confirmed inserted — tally per file.
                for (const di of docItems) {
                    bump(di.relativePath, 'inserted');
                    successes++;
                }
            } catch (insertError) {
                // Classify the failed insert as REAL (insert-error) for every
                // doc and return the outcome so the three-way counter decides.
                console.error(`[Context] ❌ Insert failed for batch (${docs.length} docs), counting as REAL insert-error:`, insertError);
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
