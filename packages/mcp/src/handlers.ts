import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Context, COLLECTION_LIMIT_MESSAGE, FileSynchronizer, IndexAbortError, DEFAULT_PRIMARY_MODEL_ID, envManager } from "@zilliz/claude-context-core";
import { SnapshotManager } from "./snapshot.js";
import type { CodebaseIndexOptions, RequestSplitterType } from "./config.js";
import { createRequestSplitter, isRequestSplitterType } from "./splitter.js";
import { ensureAbsolutePath, truncateContent, trackCodebasePath } from "./utils.js";

export class ToolHandlers {
    private context: Context;
    private snapshotManager: SnapshotManager;
    private indexingStats: { indexedFiles: number; totalChunks: number } | null = null;
    private currentWorkspace: string;
    /**
     * Tracks active background indexing tasks per absolute codebase path so
     * clear_index can cancel and await them before dropping the collection.
     * Without this, a clear_index call returns "successfully cleared" while
     * the background task keeps embedding chunks and writing them into the
     * just-cleared collection (issue #199).
     */
    private indexingTasks: Map<string, { controller: AbortController; promise: Promise<void> }> = new Map();
    // Model-scoped index runs (index_codebase with embeddingModel) report progress here instead of
    // flipping the codebase to 'indexing', because the other models stay readable meanwhile.
    private scopedModelIndexing: Map<string, { modelId: string; percentage: number }> = new Map();

    constructor(context: Context, snapshotManager: SnapshotManager) {
        this.context = context;
        this.snapshotManager = snapshotManager;
        this.currentWorkspace = process.cwd();
        console.log(`[WORKSPACE] Current workspace: ${this.currentWorkspace}`);
    }

    /**
     * Query Milvus for the real row count of a codebase's collection.
     * Returns null if the count cannot be determined — callers must NOT write a
     * snapshot entry in that case. Writing { indexedFiles: 0, totalChunks: 0,
     * status: 'completed' } for an unknown-state collection poisons the client:
     * the client treats 0/0 as "not indexed" and triggers force reindex, which
     * deletes real data and rewrites 0/0 — an infinite loop. See Issue #295.
     */
    private async queryCollectionStats(codebasePath: string): Promise<{ indexedFiles: number; totalChunks: number } | null> {
        try {
            // Resolve inside the project's env scope: the fork's per-project .env
            // (MILVUS_COLLECTION_PRIVATE etc.) decides the collection name.
            const { collectionName, rowCount } = await envManager.runWithProject(codebasePath, async () => {
                const collectionName = this.context.getCollectionName(codebasePath);
                const rowCount = await this.context.getVectorDatabase().getCollectionRowCount(collectionName);
                return { collectionName, rowCount };
            });
            if (rowCount < 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Row count unknown for '${codebasePath}', skipping recovery write`);
                return null;
            }
            if (rowCount === 0) {
                console.warn(`[SNAPSHOT-RECOVERY] Collection '${collectionName}' truly empty — NOT writing recovered entry (would poison client)`);
                return null;
            }
            // rowCount is chunk count, not file count. Without a metadata query
            // we don't have the real file count; the snapshot will be corrected
            // on the next full index. Using rowCount for both is imprecise but
            // keeps the state non-zero so the client doesn't misread it as empty.
            return { indexedFiles: rowCount, totalChunks: rowCount };
        } catch (error) {
            console.warn(`[SNAPSHOT-RECOVERY] Failed to query stats for '${codebasePath}':`, error);
            return null;
        }
    }

    /**
     * One-shot startup validation: find any legacy 0/0+completed entries on disk
     * (left over from old MCP versions, v1 snapshot migrations, or pre-fix recovery
     * paths) and either heal them with the real Milvus row count or remove them
     * if the underlying collection is empty/missing. See Issue #295.
     *
     * Safe to call multiple times but intended to run once per server start after
     * loadCodebaseSnapshot(). Errors are caught and logged; never throws.
     */
    public async validateLegacyZeroEntries(): Promise<void> {
        try {
            const indexedCodebases = this.snapshotManager.getIndexedCodebases();
            let healed = 0, removed = 0, skipped = 0, checked = 0;

            for (const codebasePath of indexedCodebases) {
                const info = this.snapshotManager.getCodebaseInfo(codebasePath);
                if (!info || info.status !== 'indexed') continue;
                // Only validate suspiciously-zero entries
                if (info.indexedFiles !== 0 || info.totalChunks !== 0) continue;

                checked++;
                const collectionName = this.context.getCollectionName(codebasePath);
                const vdb = this.context.getVectorDatabase();

                // First probe: does the collection even exist? A "no" here is
                // authoritative (permanent orphan), while a throw is most likely
                // transient (Milvus unreachable) — keep those two cases distinct
                // so we don't destroy real state on a network blip.
                let collectionExists: boolean;
                try {
                    collectionExists = await vdb.hasCollection(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] hasCollection failed for '${codebasePath}' (likely transient), skipping:`, err);
                    skipped++;
                    continue;
                }

                if (!collectionExists) {
                    // Permanent orphan — no matching Milvus collection, so the
                    // 0/0+completed snapshot entry is a pure phantom. Remove it.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed orphan 0/0 entry '${codebasePath}' — no matching Milvus collection`);
                    continue;
                }

                // Collection exists — get an accurate row count.
                let rowCount: number;
                try {
                    rowCount = await vdb.getCollectionRowCount(collectionName);
                } catch (err) {
                    console.warn(`[SNAPSHOT-VALIDATE] getCollectionRowCount failed for '${codebasePath}', skipping:`, err);
                    skipped++;
                    continue;
                }

                if (rowCount > 0) {
                    // Heal: rewrite with real row count. rowCount is chunk count;
                    // without a cheap file-count query we reuse it for both fields.
                    // Imprecise but keeps the state non-zero and will be corrected
                    // on the next full index.
                    this.snapshotManager.setCodebaseIndexed(codebasePath, {
                        indexedFiles: rowCount,
                        totalChunks: rowCount,
                        status: 'completed' as const,
                    });
                    healed++;
                    console.log(`[SNAPSHOT-VALIDATE] Healed legacy 0/0 entry '${codebasePath}' → rows=${rowCount}`);
                } else if (rowCount === 0) {
                    // Collection exists but truly empty — the 0/0+completed entry
                    // is a phantom. Remove so the user must explicitly reindex.
                    this.snapshotManager.removeCodebaseCompletely(codebasePath);
                    removed++;
                    console.warn(`[SNAPSHOT-VALIDATE] Removed phantom 0/0 entry '${codebasePath}' — collection exists but empty`);
                } else {
                    // rowCount === -1 despite the collection existing: the count
                    // query failed after the existence probe succeeded. Treat as
                    // transient and leave the entry alone.
                    skipped++;
                    console.warn(`[SNAPSHOT-VALIDATE] Row count unavailable for existing collection '${codebasePath}', skipping`);
                }
            }

            if (healed > 0 || removed > 0) {
                this.snapshotManager.saveCodebaseSnapshot();
            }
            if (checked > 0) {
                console.log(`[SNAPSHOT-VALIDATE] Done — checked=${checked} healed=${healed} removed=${removed} skipped=${skipped}`);
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-VALIDATE] Unexpected error during legacy 0/0 validation (non-fatal):`, error);
        }
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
                                undefined as any, // Don't pass empty filter
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

            // FORK POLICY (2026-11-07): do NOT prune by default. The snapshot under CLAUDE_CONTEXT_HOME is
            // shared by every project's MCP process, and a process recognises only its OWN custom collection,
            // so another project's custom-named collection is skipped above as "non-code". Pruning "everything
            // not seen" therefore removed other projects' entries, per-model ledgers and merkle snapshots on
            // every search/status call. Per-path reconciliation still happens where it is safe: index_codebase
            // compares the snapshot with hasIndex() under the project's own env. Opt back in to the upstream
            // behaviour (single-project, unshared snapshot) with CLAUDE_CONTEXT_SYNC_PRUNE=true.
            const pruneEnabled = (envManager.get('CLAUDE_CONTEXT_SYNC_PRUNE') || '').toLowerCase() === 'true';
            for (const localCodebase of localCodebases) {
                if (!normalizedCloudPaths.has(normalizePath(localCodebase)) && !pruneEnabled) {
                    console.log(`[SYNC-CLOUD] ℹ️  Not seen by this process, kept (pruning disabled): ${localCodebase}`);
                    continue;
                }
                if (!normalizedCloudPaths.has(normalizePath(localCodebase))) {
                    this.snapshotManager.removeCodebaseCompletely(localCodebase);
                    hasChanges = true;

                    try {
                        await FileSynchronizer.deleteSnapshot(localCodebase);
                    } catch (error: any) {
                        console.warn(`[SYNC-CLOUD] ⚠️  Failed to delete local merkle snapshot for removed codebase '${localCodebase}':`, error?.message || error);
                    }

                    console.log(`[SYNC-CLOUD] ➖ Removed local codebase (not in cloud): ${localCodebase}`);
                }
            }

            // FORK POLICY: do NOT add cloud codebases that are missing locally. Milvus is
            // shared across machines/users here, so "cloud-only" collections are usually
            // another machine's codebases, not lost local state. (Upstream #295 added a
            // recovery loop at this point; intentionally not adopted.)
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
        const { path: codebasePath, force, splitter, customExtensions, ignorePatterns, embeddingModel } = args;
        const forceReindex = force || false;
        const requestedSplitter = splitter || 'ast'; // Default to AST
        const customFileExtensions = customExtensions || [];
        const customIgnorePatterns = ignorePatterns || [];

        try {
            // Sync indexed codebases from cloud first
            await this.syncIndexedCodebasesFromCloud();

            // Validate splitter parameter
            if (!isRequestSplitterType(requestedSplitter)) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: Invalid splitter type '${requestedSplitter}'. Must be 'ast' or 'langchain'.`
                    }],
                    isError: true
                };
            }
            const splitterType: RequestSplitterType = requestedSplitter;
            const indexOptions: CodebaseIndexOptions = {
                requestSplitter: splitterType,
                requestCustomExtensions: customFileExtensions,
                requestIgnorePatterns: customIgnorePatterns
            };
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

            // Model-scoped run: bring ONE model's collection up to date (no clearing, no change to the
            // shared change-tracking snapshot). Omitted embeddingModel keeps the all-models behaviour.
            if (typeof embeddingModel === 'string' && embeddingModel.trim().length > 0) {
                return await this.handleScopedModelIndex(
                    absolutePath, embeddingModel.trim(), forceReindex, splitterType,
                    customIgnorePatterns, customFileExtensions, indexOptions
                );
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
            const snapshotHasIndex = this.snapshotManager.getIndexedCodebases().includes(absolutePath);
            const vectorDbHasIndex = await this.context.hasIndex(absolutePath);
            if (snapshotHasIndex !== vectorDbHasIndex) {
                if (vectorDbHasIndex && !snapshotHasIndex) {
                    // Query Milvus for real row count. If unknown/empty, log and move on
                    // without writing 0/0+completed (which would trigger the force-reindex
                    // loop in Issue #295). The user is about to (re)index anyway.
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[INDEX-VALIDATION] Recovering missing snapshot for '${absolutePath}' (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                    } else {
                        console.warn(`[INDEX-VALIDATION] VectorDB reports index for '${absolutePath}' but row count unknown/zero — not writing snapshot entry`);
                    }
                } else if (!vectorDbHasIndex && snapshotHasIndex) {
                    console.warn(`[INDEX-VALIDATION] Clearing stale snapshot for '${absolutePath}'`);
                    this.snapshotManager.removeCodebaseCompletely(absolutePath);
                    this.snapshotManager.saveCodebaseSnapshot();
                }
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

            if (customFileExtensions.length > 0) {
                console.log(`[CUSTOM-EXTENSIONS] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }

            // Check current status and log if retrying after failure
            const currentStatus = this.snapshotManager.getCodebaseStatus(absolutePath);
            if (currentStatus === 'indexfailed') {
                const failedInfo = this.snapshotManager.getCodebaseInfo(absolutePath) as any;
                console.log(`[BACKGROUND-INDEX] Retrying indexing for previously failed codebase. Previous error: ${failedInfo?.errorMessage || 'Unknown error'}`);
            }

            // Set to indexing status and save snapshot immediately
            this.snapshotManager.setCodebaseIndexing(absolutePath, 0, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Track the codebase path for syncing
            trackCodebasePath(absolutePath);

            // Start background indexing - now safe to proceed.
            // Track the controller + promise so clear_index can cancel and
            // await us before dropping the underlying collection.
            const controller = new AbortController();
            const promise = this.startBackgroundIndexing(
                absolutePath,
                forceReindex,
                splitterType,
                customIgnorePatterns,
                customFileExtensions,
                indexOptions,
                controller.signal
            ).finally(() => {
                // Only clear the entry if it still points at this run — a
                // concurrent re-index may have replaced us.
                const current = this.indexingTasks.get(absolutePath);
                if (current && current.controller === controller) {
                    this.indexingTasks.delete(absolutePath);
                }
            });
            this.indexingTasks.set(absolutePath, { controller, promise });

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

    private async startBackgroundIndexing(
        codebasePath: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[] = [],
        customFileExtensions: string[] = [],
        indexOptions?: CodebaseIndexOptions,
        signal?: AbortSignal
    ): Promise<void> {
        const absolutePath = codebasePath;
        let lastSaveTime = 0; // Track last save timestamp

        try {
            console.log(`[BACKGROUND-INDEX] Starting background indexing for: ${absolutePath}`);

            // Note: If force reindex, collection was already cleared during validation phase
            if (forceReindex) {
                console.log(`[BACKGROUND-INDEX] ℹ️  Force reindex mode - collection was already cleared during validation`);
            }

            const requestSplitter = createRequestSplitter(splitterType);

            // Load ignore patterns from files first (including .ignore, .gitignore, etc.)
            // and merge them with this request's custom ignore patterns without
            // relying on shared Context state for this background indexing task.
            const ignorePatterns = await this.context.getEffectiveIgnorePatterns(absolutePath, customIgnorePatterns);
            const supportedExtensions = this.context.getEffectiveSupportedExtensions(customFileExtensions);

            // Initialize file synchronizer with proper ignore patterns (including project-specific patterns)
            // FileSynchronizer is imported at top of file (968cce6 made it a static import).
            // includeDotDirs (fork) is (re)loaded from .contextinclude by getEffectiveIgnorePatterns above.
            const includeDotDirs = this.context.getIncludeDotDirs() || [];
            console.log(`[BACKGROUND-INDEX] Using ignore patterns: ${ignorePatterns.join(', ')}`);
            if (includeDotDirs.length > 0) {
                console.log(`[BACKGROUND-INDEX] Including dot directories: ${includeDotDirs.join(', ')}`);
            }
            if (customFileExtensions.length > 0) {
                console.log(`[BACKGROUND-INDEX] Using ${customFileExtensions.length} request-scoped custom extensions: ${customFileExtensions.join(', ')}`);
            }
            const synchronizer = new FileSynchronizer(absolutePath, ignorePatterns, includeDotDirs, supportedExtensions);
            await synchronizer.initialize();

            // Store synchronizer in the context (let context manage collection names)
            await this.context.getPreparedCollection(absolutePath);
            const collectionName = this.context.getCollectionName(absolutePath);
            this.context.setSynchronizer(collectionName, synchronizer);

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
            // active canonical model ids — this.context.getActiveModelIds() —
            // instead of a hardcoded ['qwen3-embedding-8b','qwen3-embedding-0.6b'].
            // It returns just the 8B primary when no secondary embedding is
            // configured, and adds the 0.6B (or RABBITMQ_SECONDARY_MODEL) id only
            // when one is. The synthetic '__writable_shared__' key is intentionally
            // NOT in this list — it is not a queryable model and never reads a ledger.
            const priorLedgersByModel = new Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>();
            for (const modelId of this.context.getActiveModelIds()) {
                priorLedgersByModel.set(modelId, this.snapshotManager.getFileLedgerForModel(absolutePath, modelId));
            }

            // Start indexing with the appropriate context and progress tracking
            console.log(`[BACKGROUND-INDEX] 🚀 Beginning codebase indexing process...`);
            const stats = await this.context.indexCodebase(absolutePath, (progress) => {
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
            }, false /* forceReindex — collection already cleared during validation */, priorLedgersByModel,
               customIgnorePatterns, customFileExtensions, requestSplitter, signal);
            console.log(`[BACKGROUND-INDEX] ✅ Indexing completed successfully! Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);

            // Set codebase to indexed status with complete statistics
            this.snapshotManager.setCodebaseIndexed(absolutePath, stats, indexOptions);
            this.snapshotManager.refreshCoverageFromLedgers(absolutePath, this.context.getActiveModelIds());
            this.indexingStats = { indexedFiles: stats.indexedFiles, totalChunks: stats.totalChunks };

            // Save snapshot after updating codebase lists
            this.snapshotManager.saveCodebaseSnapshot();

            let message = `Background indexing completed for '${absolutePath}' using ${splitterType.toUpperCase()} splitter.\nIndexed ${stats.indexedFiles} files, ${stats.totalChunks} chunks.`;
            if (stats.status === 'limit_reached') {
                message += `\n⚠️  Warning: Indexing stopped because the chunk limit (450,000) was reached. The index may be incomplete.`;
            }

            console.log(`[BACKGROUND-INDEX] ${message}`);

        } catch (error: any) {
            // Cooperative cancel from clear_index — clear_index is responsible
            // for tearing down the snapshot/collection right after, so do not
            // overwrite the snapshot with an "indexfailed" entry that would
            // race the clear and leave a tombstone behind.
            if (error instanceof IndexAbortError) {
                console.log(`[BACKGROUND-INDEX] Indexing for ${absolutePath} was cancelled: ${error.message}`);
                return;
            }

            console.error(`[BACKGROUND-INDEX] Error during indexing for ${absolutePath}:`, error);

            // Get the last attempted progress
            const lastProgress = this.snapshotManager.getIndexingProgress(absolutePath);

            // Set codebase to failed status with error information
            const errorMessage = error.message || String(error);
            this.snapshotManager.setCodebaseIndexFailed(absolutePath, errorMessage, lastProgress, indexOptions);
            this.snapshotManager.saveCodebaseSnapshot();

            // Log error but don't crash MCP service - indexing errors are handled gracefully
            console.error(`[BACKGROUND-INDEX] Indexing failed for ${absolutePath}: ${errorMessage}`);
        }
    }

    /** Validate an optional embeddingModel argument against the models this server has active. */
    private resolveScopedModel(embeddingModel: unknown): { modelId?: string; error?: { content: { type: "text"; text: string }[]; isError: true } } {
        if (typeof embeddingModel !== 'string' || embeddingModel.trim().length === 0) {
            return {};
        }
        try {
            return { modelId: this.context.resolveScopedModelIds(embeddingModel.trim())[0] };
        } catch (e: any) {
            return { error: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } };
        }
    }

    private async handleScopedModelIndex(
        absolutePath: string,
        embeddingModel: string,
        forceReindex: boolean,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[],
        customFileExtensions: string[],
        _indexOptions: CodebaseIndexOptions
    ) {
        const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true as const });
        const scoped = this.resolveScopedModel(embeddingModel);
        if (scoped.error) return scoped.error;
        const modelId = scoped.modelId!;

        if (forceReindex) {
            return fail(`Error: force=true cannot be combined with embeddingModel. A forced rebuild drops every model's collection; to redo one model, run clear_index with embeddingModel='${modelId}' and then index_codebase with embeddingModel='${modelId}'.`);
        }
        if (!this.snapshotManager.getIndexedCodebases().includes(absolutePath)) {
            return fail(`Error: '${absolutePath}' is not indexed yet. Run index_codebase without embeddingModel first (it indexes every configured model); embeddingModel only refreshes one model of an already indexed codebase.`);
        }
        if (this.indexingTasks.has(absolutePath)) {
            return fail(`Codebase '${absolutePath}' is already being indexed in the background. Please wait for completion.`);
        }

        const controller = new AbortController();
        this.scopedModelIndexing.set(absolutePath, { modelId, percentage: 0 });
        const promise = this.startBackgroundModelIndexing(
            absolutePath, modelId, splitterType, customIgnorePatterns, customFileExtensions, controller.signal
        ).finally(() => {
            this.scopedModelIndexing.delete(absolutePath);
            const current = this.indexingTasks.get(absolutePath);
            if (current && current.controller === controller) {
                this.indexingTasks.delete(absolutePath);
            }
        });
        this.indexingTasks.set(absolutePath, { controller, promise });

        return {
            content: [{
                type: "text" as const,
                text: `Started bringing model '${modelId}' up to date for '${absolutePath}' in the background. Other models stay searchable and the change-tracking snapshot is untouched. Use get_indexing_status with embeddingModel='${modelId}' to follow it.`
            }]
        };
    }

    private async startBackgroundModelIndexing(
        absolutePath: string,
        modelId: string,
        splitterType: RequestSplitterType,
        customIgnorePatterns: string[],
        customFileExtensions: string[],
        signal: AbortSignal
    ): Promise<void> {
        try {
            console.log(`[SCOPED-INDEX] Bringing '${modelId}' up to date for: ${absolutePath}`);
            const requestSplitter = createRequestSplitter(splitterType);
            const priorLedgersByModel = new Map<string, Map<string, { complete: boolean; fileHash: string; chunkCount?: number }>>();
            priorLedgersByModel.set(modelId, this.snapshotManager.getFileLedgerForModel(absolutePath, modelId));

            const stats = await this.context.indexCodebase(
                absolutePath,
                (progress) => {
                    this.scopedModelIndexing.set(absolutePath, { modelId, percentage: progress.percentage });
                },
                (mid, relativePath, info) => {
                    this.snapshotManager.setFileCompleteForModel(absolutePath, mid, relativePath, info);
                },
                false,
                priorLedgersByModel,
                customIgnorePatterns,
                customFileExtensions,
                requestSplitter,
                signal,
                modelId
            );
            this.snapshotManager.refreshCoverageFromLedgers(absolutePath, this.context.getActiveModelIds());
            this.snapshotManager.saveCodebaseSnapshot();
            console.log(`[SCOPED-INDEX] ✅ '${modelId}' up to date for ${absolutePath}. Files: ${stats.indexedFiles}, Chunks: ${stats.totalChunks}`);
        } catch (error: any) {
            if (error instanceof IndexAbortError) {
                console.log(`[SCOPED-INDEX] Cancelled for ${absolutePath}: ${error.message}`);
                return;
            }
            console.error(`[SCOPED-INDEX] ❌ Failed for ${absolutePath} (model ${modelId}): ${error?.message || error}`);
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
            const indexedCodebasePath = this.snapshotManager.findIndexedCodebasePath(absolutePath);
            const indexingCodebasePath = this.snapshotManager.findIndexingCodebasePath(absolutePath);
            const matchedCodebase = [indexedCodebasePath, indexingCodebasePath]
                .filter((codebase): codebase is string => codebase !== undefined)
                .sort((a, b) => b.length - a.length)[0];
            let searchCodebasePath = matchedCodebase || absolutePath;
            let isIndexed = indexedCodebasePath === searchCodebasePath;
            const isIndexing = indexingCodebasePath === searchCodebasePath;

            if (!isIndexed && !isIndexing) {
                // Fallback: check VectorDB directly in case snapshot is out of sync.
                // Only recover the snapshot when we can confirm a real row count —
                // writing 0/0+completed for an unverifiable collection poisons the
                // client into a force-reindex loop (Issue #295).
                const hasVectorIndex = await this.context.hasIndex(absolutePath);
                if (hasVectorIndex) {
                    const stats = await this.queryCollectionStats(absolutePath);
                    if (stats) {
                        console.warn(`[SEARCH] Snapshot missing but VectorDB has index for '${absolutePath}', recovering snapshot (rows=${stats.totalChunks})`);
                        this.snapshotManager.setCodebaseIndexed(absolutePath, { ...stats, status: 'completed' as const });
                        this.snapshotManager.saveCodebaseSnapshot();
                        searchCodebasePath = absolutePath;
                        isIndexed = true;
                        // Continue with search (don't return error)
                    } else {
                        return {
                            content: [{
                                type: "text",
                                text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                            }],
                            isError: true
                        };
                    }
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `Error: Codebase '${absolutePath}' is not indexed. Please index it first using the index_codebase tool.`
                        }],
                        isError: true
                    };
                }
            }

            // Show indexing status if codebase is being indexed
            let indexingStatusMessage = '';
            if (isIndexing) {
                indexingStatusMessage = `\n⚠️  **Indexing in Progress**: This codebase is currently being indexed in the background. Search results may be incomplete until indexing completes.`;
            }

            console.log(`[SEARCH] Searching in codebase: ${searchCodebasePath}`);
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
                const readable = await this.context.isModelReadable(searchCodebasePath, resolvedModel);
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
                searchCodebasePath,
                query,
                Math.min(resultLimit, 50),
                0.3,
                filterExpr,
                resolvedModel
            );

            console.log(`[SEARCH] ✅ Search completed! Found ${searchResults.length} results using ${embeddingProvider.getProvider()} embeddings`);

            if (searchResults.length === 0) {
                // Check if collection was lost (indexed locally but missing in Milvus).
                // I1: probe the PER-MODEL collection for the SAME resolved model the
                // search used — NOT the always-primary getCollectionName. For a 0.6B
                // search this resolves the `_0p6b` collection, so a healthy 0.6B index
                // is never wrongly reported as "lost" just because a secondary became
                // readable-but-empty. `resolvedModel` is the exact value passed to
                // semanticSearch above; default to the primary id when unset.
                if (isIndexed && !isIndexing) {
                    const collectionName = this.context.getCollectionNameForModel(searchCodebasePath, resolvedModel ?? DEFAULT_PRIMARY_MODEL_ID);
                    const hasCollection = await this.context.getVectorDatabase().hasCollection(collectionName);
                    if (!hasCollection) {
                        return {
                            content: [{ type: "text", text: `Error: Index data for '${searchCodebasePath}' has been lost (collection not found in Milvus). Please re-index using index_codebase with force=true.` }],
                            isError: true
                        };
                    }
                }

                let noResultsMessage = `No results found for query: "${query}" in codebase '${searchCodebasePath}'`;
                if (searchCodebasePath !== absolutePath) {
                    noResultsMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
                }
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
                const codebaseInfo = path.basename(searchCodebasePath);
                const sourceLabel = result.sourceProject
                    ? `[${codebaseInfo}] (from: ${result.sourceProject})`
                    : `[${codebaseInfo}]`;

                return `${index + 1}. Code snippet (${result.language}) ${sourceLabel}\n` +
                    `   Location: ${location}\n` +
                    `   Rank: ${index + 1}\n` +
                    `   Context: \n\`\`\`${result.language}\n${context}\n\`\`\`\n`;
            }).join('\n');

            let resultMessage = `Found ${searchResults.length} results for query: "${query}" in codebase '${searchCodebasePath}'${indexingStatusMessage}`;
            if (searchCodebasePath !== absolutePath) {
                resultMessage += `\nRequested path '${absolutePath}' is covered by indexed codebase '${searchCodebasePath}'.`;
            }
            resultMessage += `\n\n${formattedResults}`;

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
        const { path: codebasePath, embeddingModel } = args;
        const scopedClear = this.resolveScopedModel(embeddingModel);
        if (scopedClear.error) return scopedClear.error;
        const scopedClearModelId = scopedClear.modelId;

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

            // Cancel any in-flight background indexing for this codebase and
            // wait for it to wind down before we drop the collection.
            // Otherwise the background task keeps embedding chunks and writes
            // them into the just-cleared collection (issue #199).
            const activeTask = this.indexingTasks.get(absolutePath);
            if (activeTask) {
                console.log(`[CLEAR] Cancelling in-flight background indexing for: ${absolutePath}`);
                activeTask.controller.abort();
                try {
                    await activeTask.promise;
                } catch (waitError: any) {
                    // startBackgroundIndexing already logs and never re-throws,
                    // so this catch only guards against future refactors.
                    console.warn(`[CLEAR] Background indexing wind-down reported: ${waitError?.message || waitError}`);
                }
                this.indexingTasks.delete(absolutePath);
            }

            try {
                await this.context.clearIndex(absolutePath, undefined, scopedClearModelId);
                console.log(`[CLEAR] Successfully cleared index for: ${absolutePath}${scopedClearModelId ? ` (model ${scopedClearModelId} only)` : ''}`);
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

            if (scopedClearModelId) {
                // Scoped clear: keep the codebase entry and the other models' ledgers; forget only this model's.
                this.snapshotManager.clearFileLedgerForModel(absolutePath, scopedClearModelId);
                this.snapshotManager.saveCodebaseSnapshot();
                return {
                    content: [{
                        type: "text",
                        text: `Cleared the '${scopedClearModelId}' collection for '${absolutePath}'. Other models and change tracking were left untouched. Repopulate it with index_codebase embeddingModel='${scopedClearModelId}'.`
                    }]
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
        const { path: codebasePath, embeddingModel } = args;
        const scopedStatus = this.resolveScopedModel(embeddingModel);
        if (scopedStatus.error) return scopedStatus.error;
        const scopedStatusModelId = scopedStatus.modelId;

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
            const statusCodebasePath = this.snapshotManager.findTrackedCodebasePath(absolutePath) || absolutePath;
            const status = this.snapshotManager.getCodebaseStatus(statusCodebasePath);
            const info = this.snapshotManager.getCodebaseInfo(statusCodebasePath);

            let statusMessage = '';

            switch (status) {
                case 'indexed': {
                    // Verify the PRIMARY collection still exists in Milvus (may be lost after restart/cleanup).
                    // isModelReadable for the primary == today's hasCollection check (coverage 1.0, configured true),
                    // so status and search derive readability from the SAME predicate (P3 — they never disagree).
                    const primaryReadable = await this.context.isModelReadable(statusCodebasePath, DEFAULT_PRIMARY_MODEL_ID);

                    if (!primaryReadable) {
                        statusMessage = `⚠️ Codebase '${statusCodebasePath}' was indexed but the index data has been lost (collection not found in Milvus).`;
                        statusMessage += `\n🔄 Please re-index using index_codebase with force=true.`;
                        break;
                    }

                    if (info && 'indexedFiles' in info) {
                        const indexedInfo = info as any;
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                        statusMessage += `\n📊 Statistics: ${indexedInfo.indexedFiles} files, ${indexedInfo.totalChunks} chunks`;
                        statusMessage += `\n📅 Status: ${indexedInfo.indexStatus}`;
                        statusMessage += `\n🕐 Last updated: ${new Date(indexedInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `✅ Codebase '${statusCodebasePath}' is fully indexed and ready for search.`;
                    }

                    // Per-model readability for SECONDARY models (only surfaced when configured).
                    // Enumerate active models via the ONE enumerator (SEAM-2) and report each
                    // non-primary model's readability through the shared isModelReadable
                    // predicate, so status and search stay in lock-step (P3).
                    const modelIdsToReport = scopedStatusModelId ? [scopedStatusModelId] : this.context.getActiveModelIds();
                    for (const modelId of modelIdsToReport) {
                        if (modelId === DEFAULT_PRIMARY_MODEL_ID && !scopedStatusModelId) continue;
                        const label = modelId === DEFAULT_PRIMARY_MODEL_ID ? 'Primary' : 'Secondary';
                        const modelReadable = await this.context.isModelReadable(statusCodebasePath, modelId);
                        statusMessage += modelReadable
                            ? `\n🟢 ${label} model '${modelId}' is readable.`
                            : `\n🟡 ${label} model '${modelId}' is configured but NOT yet readable (collection missing or coverage below threshold — searches with it return a degraded notice).`;
                    }
                    const scopedRun = this.scopedModelIndexing.get(statusCodebasePath) ?? this.scopedModelIndexing.get(absolutePath);
                    if (scopedRun) {
                        statusMessage += `\n🔄 Model '${scopedRun.modelId}' is being brought up to date: ${scopedRun.percentage.toFixed(1)}%`;
                    }
                    break;
                }

                case 'indexing':
                    if (info && 'indexingPercentage' in info) {
                        const indexingInfo = info as any;
                        const progressPercentage = indexingInfo.indexingPercentage || 0;
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed. Progress: ${progressPercentage.toFixed(1)}%`;

                        // Add more detailed status based on progress
                        if (progressPercentage < 10) {
                            statusMessage += ' (Preparing and scanning files...)';
                        } else if (progressPercentage < 100) {
                            statusMessage += ' (Processing files and generating embeddings...)';
                        }
                        statusMessage += `\n🕐 Last updated: ${new Date(indexingInfo.lastUpdated).toLocaleString()}`;
                    } else {
                        statusMessage = `🔄 Codebase '${statusCodebasePath}' is currently being indexed.`;
                    }
                    break;

                case 'indexfailed':
                    if (info && 'errorMessage' in info) {
                        const failedInfo = info as any;
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed.`;
                        statusMessage += `\n🚨 Error: ${failedInfo.errorMessage}`;
                        if (failedInfo.lastAttemptedPercentage !== undefined) {
                            statusMessage += `\n📊 Failed at: ${failedInfo.lastAttemptedPercentage.toFixed(1)}% progress`;
                        }
                        statusMessage += `\n🕐 Failed at: ${new Date(failedInfo.lastUpdated).toLocaleString()}`;
                        statusMessage += `\n💡 You can retry indexing by running the index_codebase command again.`;
                    } else {
                        statusMessage = `❌ Codebase '${statusCodebasePath}' indexing failed. You can retry indexing.`;
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
            const matchedPathInfo = statusCodebasePath !== absolutePath
                ? `\nRequested path '${absolutePath}' is covered by tracked codebase '${statusCodebasePath}'.`
                : '';

            return {
                content: [{
                    type: "text",
                    text: statusMessage + pathInfo + matchedPathInfo
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
