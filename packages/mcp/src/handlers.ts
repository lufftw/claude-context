import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE, FileSynchronizer, DEFAULT_PRIMARY_MODEL_ID } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Sync indexed codebases from Zilliz Cloud collections
     * This method fetches all collections from the vector database,
     * extracts codebasePath from collection description (preferred) or falls back
     * to querying document metadata for old collections,
     * and updates the snapshot with discovered codebases.
     *
     * Logic: Compare mcp-codebase-snapshot.json with zilliz cloud collections
     * - If local snapshot has extra directories (not in cloud), remove them
     * - If local snapshot is missing directories (exist in cloud), ignore them
     */
    private async syncIndexedCodebasesFromCloud(): Promise<void> {
        try {
            console.log(`[SYNC-CLOUD] 🔄 Syncing indexed codebases from Zilliz Cloud...`);

            // Get all collections using the interface method
            const vectorDb = this.context.getVectorDatabase();

            // Use the new listCollections method from the interface
            const collections = await vectorDb.listCollections();

            console.log(`[SYNC-CLOUD] 📋 Found ${collections.length} collections in Zilliz Cloud`);

            if (collections.length === 0) {
                console.log(`[SYNC-CLOUD] ✅ No collections found in cloud. Skipping deletion of local codebases to avoid data loss from transient errors.`);
                return;
            }

            const cloudCodebases = new Set<string>();
            let codeCollectionsChecked = 0;
            let successfulExtractions = 0;

            // Build set of known custom collection names (from env config)
            const knownCustomCollections = new Set<string>();
            const privateCol = this.context.getCollectionName('');
            if (privateCol) knownCustomCollections.add(privateCol);
            const sharedCol = this.context.getWritableSharedCollectionName();
            if (sharedCol) knownCustomCollections.add(sharedCol);
            const readSharedCol = this.context.getSharedCollectionName();
            if (readSharedCol) knownCustomCollections.add(readSharedCol);

            // Check each collection for codebase path
            for (const collectionName of collections) {
                try {
                    // Skip collections that don't match code_chunks pattern AND are not known custom collections
                    const isCodeChunks = collectionName.startsWith('code_chunks_') || collectionName.startsWith('hybrid_code_chunks_');
                    const isKnownCustom = knownCustomCollections.has(collectionName);
                    if (!isCodeChunks && !isKnownCustom) {
                        console.log(`[SYNC-CLOUD] ⏭️  Skipping non-code collection: ${collectionName}`);
                        continue;
                    }

                    codeCollectionsChecked++;
                    console.log(`[SYNC-CLOUD] 🔍 Checking collection: ${collectionName}`);

                    // Try to extract codebasePath from collection description first (new format)
                    let extracted = false;
                    try {
                        const description = await vectorDb.getCollectionDescription(collectionName);
                        if (description && description.startsWith('codebasePath:')) {
                            const codebasePath = description.substring('codebasePath:'.length);
                            if (codebasePath.length > 0) {
                                console.log(`[SYNC-CLOUD] 📍 Found codebase path from description: ${codebasePath} in collection: ${collectionName}`);
                                cloudCodebases.add(codebasePath);
                                successfulExtractions++;
                                extracted = true;
                            }
                        }
                    } catch (descError: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to get description for collection ${collectionName}:`, descError.message || descError);
                    }

                    // Fallback: query document metadata for old collections without new description format
                    if (!extracted) {
                        console.log(`[SYNC-CLOUD] 🔄 Falling back to query-based extraction for collection: ${collectionName}`);
                        try {
                            const results = await vectorDb.query(
                                collectionName,
                                '', // Empty filter to get all results
                                ['metadata'], // Only fetch metadata field
                                1 // Only need one result to extract codebasePath
                            );

                            if (results && results.length > 0) {
                                const firstResult = results[0];
                                const metadataStr = firstResult.metadata;

                                if (metadataStr) {
                                    const metadata = JSON.parse(metadataStr);
                                    const codebasePath = metadata.codebasePath;

                                    if (codebasePath && typeof codebasePath === 'string') {
                                        console.log(`[SYNC-CLOUD] 📍 Found codebase path from query: ${codebasePath} in collection: ${collectionName}`);
                                        cloudCodebases.add(codebasePath);
                                        successfulExtractions++;
                                    } else {
                                        console.warn(`[SYNC-CLOUD] ⚠️  No codebasePath found in metadata for collection: ${collectionName}`);
                                    }
                                } else {
                                    console.warn(`[SYNC-CLOUD] ⚠️  No metadata found in collection: ${collectionName}`);
                                }
                            } else {
                                console.log(`[SYNC-CLOUD] ℹ️  Collection ${collectionName} is empty`);
                            }
                        } catch (queryError: any) {
                            console.warn(`[SYNC-CLOUD] ⚠️  Fallback query failed for collection ${collectionName}:`, queryError.message || queryError);
                        }
                    }
                } catch (collectionError: any) {
                    console.warn(`[SYNC-CLOUD] ⚠️  Error checking collection ${collectionName}:`, collectionError.message || collectionError);
                    // Continue with next collection
                }
            }

            console.log(`[SYNC-CLOUD] 📊 Found ${cloudCodebases.size} valid codebases in cloud (checked ${codeCollectionsChecked} code collections, ${successfulExtractions} successfully extracted)`);

            // Safety guard: if we checked code collections but none returned results,
            // treat this as an extraction failure rather than "cloud is empty".
            // This prevents deleting all local codebases due to transient errors.
            if (codeCollectionsChecked > 0 && successfulExtractions === 0) {
                console.warn(`[SYNC-CLOUD] ⚠️  All ${codeCollectionsChecked} code collection extractions failed. Skipping sync to avoid accidental deletion of local codebases.`);
                return;
            }

            // Normalize path for cross-platform comparison (backslash vs forward slash)
            const normalizePath = (p: string) => p.replace(/\\/g, '/').toLowerCase();

            // Build normalized cloud path set for comparison
            const normalizedCloudPaths = new Set<string>();
            for (const cp of cloudCodebases) {
                normalizedCloudPaths.add(normalizePath(cp));
            }

            // Get current local codebases
            const localCodebases = new Set(this.snapshotManager.getIndexedCodebases());
            console.log(`[SYNC-CLOUD] 📊 Found ${localCodebases.size} local codebases in snapshot`);

            let hasChanges = false;

            // Remove local codebases that don't exist in cloud (using normalized path comparison)
            for (const localCodebase of localCodebases) {
                if (!normalizedCloudPaths.has(normalizePath(localCodebase))) {
                    this.snapshotManager.removeIndexedCodebase(localCodebase);
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localCodebase);
                    } catch (error: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to delete local merkle snapshot for removed codebase '${localCodebase}':`, error?.message || error);
                    }

                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // Note: We don't add cloud codebases that are missing locally (as per user requirement)
            console.log(`[SYNC-CLOUD] ℹ️  Skipping addition of cloud codebases not present locally (per sync policy)`);

            if (hasChanges) {
                this.snapshotManager.saveCodebaseSnapshot();
                console.log(`[SYNC-CLOUD] 💾 Updated snapshot to match cloud state`);
            } else {
                console.log(`[SYNC-CLOUD] ✅ Local snapshot already matches cloud state`);
            }

            console.log(`[SYNC-CLOUD] ✅ Cloud sync completed successfully`);
        } catch (error: any) {
            console.error(`[SYNC-CLOUD] ❌ Error syncing codebases from cloud:`, error.message || error);
            // Don't throw - this is not critical for the main functionality
        }
    }

    public async handleIndexCodebase(args: any) {
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns } = args;
        const forceReindex = force || false;
        const splitterType = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (splitterType !== 'ast' && splitterType !== 'langchain') {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${splitterType}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if already indexing
            if (this.snapshotManager.getIndexingCodebases().includes(absolutePath)) {
                if (forceReindex) {
                    console.log(`[FORCE-REINDEX] Clearing stale indexing state for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`
                        }],
                        isError: true
                    };
                }
            }

            //Check if the snapshot and cloud index are in sync
            if (this.snapshotManager.getIndexedCodebases().includes(absolutePath) !== await this.context.hasIndex(absolutePath)) {
                console.warn(`[INDEX-VALIDATION] ❌ Snapshot and cloud index mismatch: ${absolutePath}`);
            }

            // Check if already indexed (unless force is true)
            if (!forceReindex && this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Codebase '${absolutePath}' is already indexed. Use force=true to re-index.`
                    }],
                    isError: true
                };
            }

            // If force reindex and codebase is already indexed, remove it
            if (forceReindex) {
                this.snapshotManager.removeCodebaseCompletely(absolutePath);
                this.snapshotManager.saveCodebaseSnapshot();
                if (await this.context.hasIndex(absolutePath)) {
                    console.log(`[FORCE-REINDEX] 🔄 Clearing index for '${absolutePath}'`);
                    await this.context.clearIndex(absolutePath);
                }
            }

            // CRITICAL: Pre-index collection creation validation
            try {
                console.log(`[INDEX-VALIDATION] 🔍 Validating collection creation capability`);
                const canCreateCollection = await this.context.getVectorDatabase().checkCollectionLimit();

                if (!canCreateCollection) {
                    console.error(`[INDEX-VALIDATION] ❌ Collection limit validation failed: ${absolutePath}`);

                    // CRITICAL: Immediately return the COLLECTION_LIMIT_MESSAGE to MCP client
                    return {
                        content: [{
                            type: "text",
                            text: COLLECTION_LIMIT_MESSAGE
                        }],
                        isError: true
                    };
                }

                console.log(`[INDEX-VALIDATION] ✅  Collection creation validation completed`);
            } catch (validationError: any) {
                // Handle other collection creation errors
                console.error(`[INDEX-VALIDATION] ❌ Collection creation validation failed:`, validationError);
                return {
                    content: [{
                        type: "text",
                        text: `Error validating collection creation: ${validationError.message || validationError}`
                    }],
                    isError: true
                };
            }

            // Add custom extensions if provided
            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Adding ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`);
                this.context.addCustomExtensions(customFileExtensions);
            }

            // Add custom ignore patterns if provided (before loading file-based patterns)
            if (customIgnorePatterns.length > 0) {
                console.log(`[IGNORE-PATTERNS] Adding ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`);
                this.context.addCustomIgnorePatterns(customIgnorePatterns);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed
            this.startBackgroundIndexing(absolutePath, forceReindex, splitterType);

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            const extensionInfo = customFileExtensions.length > 0
                ? `\nUsing ${customFileExtensions.length} custom extensions: ${customFileExtensions.join(', ')}`
                : '';

            const ignoreInfo = customIgnorePatterns.length > 0
                ? `\nUsing ${customIgnorePatterns.length} custom ignore patterns: ${customIgnorePatterns.join(', ')}`
                : '';

            return {
                content: [{
                    type: "text",
                    text: `Started background indexing for codebase '${absolutePath}' using ${splitterType.toUpperCase()} splitter.${pathInfo}${extensionInfo}${ignoreInfo}\n\nIndexing is running in the background. You can search the codebase while indexing is in progress, but results may be incomplete until indexing completes.`
                }]
            };

        } catch (error: any) {
            // Enhanced error handling to prevent MCP service crash
            console.error('Error in handleIndexCodebase:', error);

            // Ensure we always return a proper MCP response, never throw
            return {
                content: [{
                    type: "text",
                    text: `Error starting indexing: ${error.message || error}`
                }],
                isError: true
            };
        }
    }

    private async startBackgroundIndexing(codebasePath: string, forceReindex: boolean, splitterType: string) {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            // Use the existing Context instance for indexing.
            let contextForThisTask = this.context;
            if (splitterType !== 'ast') {
                console.warn(`[BACKGROUND-INDEX] Non-AST splitter '${splitterType}' requested; falling back to AST splitter`);
            }

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            await this.context.getLoadedIgnorePatterns(absolutePath);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            // FileSynchronizer is imported at top of file (968cce6 made it a static import)
            const ignorePatterns = this.context.getIgnorePatterns() || [];
            const includeDotDirs = this.context.getIncludeDotDirs() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            if (includeDotDirs.length > 0) {
                console.log(`[BACKGROUND-INDEX] Including dot directories: ${includeDotDirs.join(', ')}`);
            }
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, includeDotDirs, this.context.getSupportedExtensions());
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);
            if (contextForThisTask !== this.context) {
                contextForThisTask.setSynchronizer(collectionName, synchronizer);
            }

            console.log(`[BACKGROUND-INDEX] Starting indexing with ${splitterType} splitter for: ${absolutePath}`);

            // Log embedding provider information before indexing
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[BACKGROUND-INDEX] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} with dimension: ${embeddingProvider.getDimension()}`);

            // Capture the per-MODEL prior-run completeness ledgers BEFORE indexing
            // mutates the live snapshot entry (M8 — the resume read, per target).
            // getFileLedgerForModel returns a COPY, so in-run setFileCompleteForModel
            // mutations don't perturb what the resume read sees. Building the map for
            // BOTH known models keeps the 0.6B target from re-embedding fully on every
            // MCP restart (R2-HANDLER-PRIORLEDGER).
            // Fix 3 (R-C4 single enumerator): consume the ONE definition of the
            // active canonical model ids — contextForThisTask.getActiveModelIds() —
            // instead of a hardcoded ['qwen3-embedding-8b','qwen3-embedding-0.6b'].
            // It returns just the 8B primary when no secondary embedding is
            // configured, and adds the 0.6B (or RABBITMQ_SECONDARY_MODEL) id only
            // when one is. The synthetic '__writable_shared__' key is intentionally
            // NOT in this list — it is not a queryable model and never reads a ledger.
            const priorLedgersByModel = new Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>();
            for (const modelId of contextForThisTask.getActiveModelIds()) {
                priorLedgersByModel.set(modelId, this.snapshotManager.getFileLedgerForModel(absolutePath, modelId));
            }

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await contextForThisTask.indexCodebase(absolutePath, (progress) => {
                // Update progress in snapshot manager using new method
                this.snapshotManager.setCodebaseIndexing(absolutePath, progress.percentage);

                // Save snapshot periodically (every 2 seconds to avoid too frequent saves)
                const currentTime = Date.now();
                if (currentTime - lastSaveTime >= 2000) { // 2 seconds = 2000ms
                    this.snapshotManager.saveCodebaseSnapshot();
                    lastSaveTime = currentTime;
                    console.log(`[BACKGROUND-INDEX] 💾 Saved progress snapshot at ${progress.percentage.toFixed(1)}%`);
                }

                console.log(`[BACKGROUND-INDEX] Progress: ${progress.phase} - ${progress.percentage}% (${progress.current}/${progress.total})`);
            }, (modelId, relativePath, info) => {
                // Per-(file × model) completeness ledger (M8). Writes the 8B path
                // into the legacy top-level `files` (byte-identical) and the 0.6B
                // path into filesByModel[modelId] (snapshot v2-additive). The
                // synthetic '__writable_shared__' key NEVER reaches here: the core
                // gates it out at every onFileComplete fire site (Fix 1, the
                // fireLedger closure in processFileList), so this callback only ever
                // sees canonical, queryable model ids. (Note: assertSafeModelId in
                // setFileCompleteForModel only blocks '__proto__'/'constructor'/
                // 'prototype' — it would NOT have filtered '__writable_shared__';
                // the suppression is the core's responsibility, done above.)
                this.snapshotManager.setFileCompleteForModel(absolutePath, modelId, relativePath, info);
            }, undefined /* forceReindex — keep default */, priorLedgersByModel);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats);
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    public async handleSearchCode(args: any) {
        const { path: codebasePath, query, limit = 10, extensionFilter, embeddingModel } = args;
        const resultLimit = limit || 10;
        // Resolution precedence (M4 / R-C5 single-site): pass the explicit arg or
        // `undefined`. DO NOT read process.env here — the SINGLE authoritative
        // resolution (explicit arg > project-`.env` SEARCH_EMBEDDING_MODEL > 8B) lives
        // in Context._semanticSearchImpl, which runs inside runWithProject so the
        // project `.env` wins (the fork's project-scope rule). A user-scope
        // process.env read here would shadow the project value and silently break
        // the per-session model trigger.
        const resolvedModel: string | undefined =
            (typeof embeddingModel === 'string' && embeddingModel.length > 0) ? embeddingModel : undefined;

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            trackCodebasePath(absolutePath);

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                    }],
                    isError: true
                };
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${absolutePath}`);
            console.log(`[SEARCH] Query: "${query}"`);
            console.log(`[SEARCH] Indexing status: ${isIndexing ? 'In Progress' : 'Completed'}`);

            // Log embedding provider information before search
            const embeddingProvider = this.context.getEmbedding();
            console.log(`[SEARCH] 🧠 Using embedding provider: ${embeddingProvider.getProvider()} for search`);
            console.log(`[SEARCH] 🔍 Generating embeddings for query using ${embeddingProvider.getProvider()}...`);

            // Build filter expression from extensionFilter list
            let filterExpr: string | undefined = undefined;
            if (Array.isArray(extensionFilter) && extensionFilter.length > 0) {
                const cleaned = extensionFilter
                    .filter((v: any) => typeof v === 'string')
                    .map((v: string) => v.trim())
                    .filter((v: string) => v.length > 0);
                const invalid = cleaned.filter((e: string) => !(e.startsWith('.') && e.length > 1 && !/\s/.test(e)));
                if (invalid.length > 0) {
                    return {
                        content: [{ type: 'text', text: `Error: Invalid file extensions in extensionFilter: ${JSON.stringify(invalid)}. Use proper extensions like '.ts', '.py'.` }],
                        isError: true
                    };
                }
                const quoted = cleaned.map((e: string) => `'${e}'`).join(', ');
                filterExpr = `fileExtension in [${quoted}]`;
            }

            // Structured degraded short-circuit (C4 / D7): when a SECONDARY model is
            // explicitly requested but it is not configured or not yet readable
            // (collection missing / coverage below threshold), return a STRUCTURED
            // JSON object — never a wrong-dim ANN call. The Phase-6 D7 gate parses
            // this JSON (degraded/reason), never substring-matches.
            if (resolvedModel && resolvedModel !== DEFAULT_PRIMARY_MODEL_ID) {
                if (!this.context.hasEmbeddingForModel(resolvedModel)) {
                    console.log(`[SEARCH] 🟡 Requested model '${resolvedModel}' is not configured — returning structured degraded notice (secondary-not-configured)`);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({ degraded: true, reason: 'secondary-not-configured', results: [] })
                        }]
                    };
                }
                const readable = await this.context.isModelReadable(absolutePath, resolvedModel);
                if (!readable) {
                    console.log(`[SEARCH] 🟡 Requested model '${resolvedModel}' is configured but not yet readable — returning structured degraded notice (secondary-coverage-below-threshold)`);
                    return {
                        content: [{
                            type: "text",
                            text: JSON.stringify({ degraded: true, reason: 'secondary-coverage-below-threshold', results: [] })
                        }]
                    };
                }
            }

            // Search in the specified codebase (route the query embedding + collection by model).
            console.log(`[SEARCH] 🧭 Routing search via embedding model: ${resolvedModel ?? '(default/project-scope)'}`);
            const searchResults = await this.context.semanticSearch(
                absolutePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr,
                resolvedModel
            );

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                // Check if collection was lost (indexed locally but missing in Milvus)
                if (isIndexed && !isIndexing) {
                    const collectionName = this.context.getCollectionName(absolutePath);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [{ type: "text", text: `Error: Index data for '${absolutePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.` }],
                            isError: true
                        };
                    }
                }

                let noResultsMessage = `No results found for query: "${query}" in codebase '${absolutePath}'`;
                if (isIndexing) {
                    noResultsMessage += `\n\nNote: This codebase is still being indexed. Try searching again after indexing completes, or the query may not match any indexed content.`;
                }
                return {
                    content: [{
                        type: "text",
                        text: noResultsMessage
                    }]
                };
            }

            // Format results
            const formattedResults = searchResults.map((result: any, index: number) => {
                const location = `${result.relativePath}:${result.startLine}-${result.endLine}`;
                const context = truncateContent(result.content, 5000);
                const codebaseInfo = path.basename(absolutePath);
                const sourceLabel = result.sourceProject
                    ? `[${codebaseInfo}] (from: ${result.sourceProject})`
                    : `[${codebaseInfo}]`;

                return `${index + 1}. Code snippet (${result.language}) ${sourceLabel}\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${absolutePath}'${indexingStatusMessage}\n\n${formattedResults}`;

            if (isIndexing) {
                resultMessage += `\n\n💡 **Tip**: This codebase is still being indexed. More results may become available as indexing progresses.`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultMessage
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error searching code: ${errorMessage} Please check if the codebase has been indexed first.`
                }],
                isError: true
            };
        }
    }

    public async handleClearIndex(args: any) {
        const { path: codebasePath } = args;

        if (this.snapshotManager.getIndexedCodebases().length === 0 && this.snapshotManager.getIndexingCodebases().length === 0) {
            return {
                content: [{
                    type: "text",
                    text: "No codebases are currently indexed or being indexed."
                }]
            };
        }

        try {
            // Force absolute path resolution - warn if relative path provided
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            // Check if this codebase is indexed or being indexed
            const isIndexed = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const isIndexing = this.snapshotManager.getIndexingCodebases().includes(absolutePath);

            if (!isIndexed && !isIndexing) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Codebase '${absolutePath}' is not indexed or being indexed.`
                    }],
                    isError: true
                };
            }

            console.log(`[CLEAR] Clearing codebase: ${absolutePath}`);

            try {
                await this.context.clearIndex(absolutePath);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}`);
            } catch (error: any) {
                const errorMsg = `Failed to clear ${absolutePath}: ${error.message}`;
                console.error(`[CLEAR] ${errorMsg}`);
                return {
                    content: [{
                        type: "text",
                        text: errorMsg
                    }],
                    isError: true
                };
            }

            // Completely remove the cleared codebase from snapshot
            this.snapshotManager.removeCodebaseCompletely(absolutePath);

            // Reset indexing stats if this was the active codebase
            this.indexingStats = null;

            // Save snapshot after clearing index
            this.snapshotManager.saveCodebaseSnapshot();

            let resultText = `Successfully cleared codebase '${absolutePath}'`;

            const remainingIndexed = this.snapshotManager.getIndexedCodebases().length;
            const remainingIndexing = this.snapshotManager.getIndexingCodebases().length;

            if (remainingIndexed > 0 || remainingIndexing > 0) {
                resultText += `\n${remainingIndexed} other indexed codebase(s) and ${remainingIndexing} indexing codebase(s) remain`;
            }

            return {
                content: [{
                    type: "text",
                    text: resultText
                }]
            };
        } catch (error) {
            // Check if this is the collection limit error
            // Handle both direct string throws and Error objects containing the message
            const errorMessage = typeof error === 'string' ? error : (error instanceof Error ? error.message : String(error));

            if (errorMessage === COLLECTION_LIMIT_MESSAGE || errorMessage.includes(COLLECTION_LIMIT_MESSAGE)) {
                // Return the collection limit message as a successful response
                // This ensures LLM treats it as final answer, not as retryable error
                return {
                    content: [{
                        type: "text",
                        text: COLLECTION_LIMIT_MESSAGE
                    }]
                };
            }

            return {
                content: [{
                    type: "text",
                    text: `Error clearing index: ${errorMessage}`
                }],
                isError: true
            };
        }
    }

    public async handleGetIndexingStatus(args: any) {
        const { path: codebasePath } = args;

        try {
            // Force absolute path resolution
            const absolutePath = ensureAbsolutePath(codebasePath);

            // Validate path exists
            if (!fs.existsSync(absolutePath)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' does not exist. Original input: '${codebasePath}'`
                    }],
                    isError: true
                };
            }

            // Check if it's a directory
            const stat = fs.statSync(absolutePath);
            if (!stat.isDirectory()) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Path '${absolutePath}' is not a directory`
                    }],
                    isError: true
                };
            }

            await this.syncIndexedCodebasesFromCloud();

            // Check indexing status using new status system
            const status = this.snapshotManager.getCodebaseStatus(absolutePath);
            const info = this.snapshotManager.getCodebaseInfo(absolutePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed': {
                    // Verify the PRIMARY collection still exists in Milvus (may be lost after restart/cleanup).
                    // isModelReadable for the primary == today's hasCollection check (coverage 1.0, configured true),
                    // so status and search derive readability from the SAME predicate (P3 — they never disagree).
                    const primaryReadable = await this.context.isModelReadable(absolutePath, 'qwen3-embedding-8b');

                    if (!primaryReadable) {
                        statusMessage = `⚠️ Codebase '${absolutePath}' was indexed but the index data has been lost (collection not found in Milvus).`;
                        statusMessage += `\n🔄 Please re-index using index_codebase with force=true.`;
                        break;
                    }

                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${absolutePath}' is fully indexed and ready for search.`;
                    }

                    // Per-model readability for SECONDARY models (only surfaced when configured).
                    // Enumerate active models via the ONE enumerator (SEAM-2) and report each
                    // non-primary model's readability through the shared isModelReadable
                    // predicate, so status and search stay in lock-step (P3).
                    for (const modelId of this.context.getActiveModelIds()) {
                        if (modelId === DEFAULT_PRIMARY_MODEL_ID) continue;
                        const secondaryReadable = await this.context.isModelReadable(absolutePath, modelId);
                        statusMessage += secondaryReadable
                            ? `\n🟢 Secondary model '${modelId}' is readable.`
                            : `\n🟡 Secondary model '${modelId}' is configured but NOT yet readable (collection missing or coverage below threshold — searches with it return a degraded notice).`;
                    }
                    break;
                }

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${absolutePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${absolutePath}' indexing failed. You can retry indexing.`;
                    }
                    break;

                case 'not_found':
                default:
                    statusMessage = `❌ Codebase '${absolutePath}' is not indexed. Please use the index_codebase tool to index it first.`;
                    break;
            }

            const pathInfo = codebasePath !== absolutePath
                ? `\nNote: Input path '${codebasePath}' was resolved to absolute path '${absolutePath}'`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo
                }]
            };

        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Error getting indexing status: ${error.message || error}`
                }],
                isError: true
            };
        }
    }
} 
