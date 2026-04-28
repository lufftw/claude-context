import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import lockfile from "proper-lockfile";
import {
    CodebaseSnapshot,
    CodebaseSnapshotV1,
    CodebaseSnapshotV2,
    CodebaseInfo,
    CodebaseInfoIndexing,
    CodebaseInfoIndexed,
    CodebaseInfoIndexFailed
} from "./config.js";

export class SnapshotManager {
    private snapshotFilePath: string;
    private indexedCodebases: string[] = [];
    private indexingCodebases: Map<string, number> = new Map(); // Map of codebase path to progress percentage
    private codebaseFileCount: Map<string, number> = new Map(); // Map of codebase path to indexed file count
    private codebaseInfoMap: Map<string, CodebaseInfo> = new Map(); // Map of codebase path to complete info
    private removedCodebases: Set<string> = new Set(); // Tracks codebases explicitly removed by this session

    constructor() {
        // Initialize snapshot file path (supports CLAUDE_CONTEXT_HOME env override for multi-user sharing)
        const contextHome = process.env.CLAUDE_CONTEXT_HOME || path.join(os.homedir(), '.context');
        this.snapshotFilePath = path.join(contextHome, 'mcp-codebase-snapshot.json');
    }

    /**
     * Check if snapshot is v2 format
     */
    private isV2Format(snapshot: any): snapshot is CodebaseSnapshotV2 {
        return snapshot && snapshot.formatVersion === 'v2';
    }

    /**
     * Convert v1 format to internal state
     */
    private loadV1Format(snapshot: CodebaseSnapshotV1): void {
        console.log('[SNAPSHOT-DEBUG] Loading v1 format snapshot');

        // Validate that the codebases still exist
        const validCodebases: string[] = [];
        for (const codebasePath of snapshot.indexedCodebases) {
            if (fs.existsSync(codebasePath)) {
                validCodebases.push(codebasePath);
                console.log(`[SNAPSHOT-DEBUG] Validated codebase: ${codebasePath}`);
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
                // Track removal so the next merge-save deletes the ghost from disk
                this.removedCodebases.add(codebasePath);
            }
        }

        // Handle indexing codebases - treat them as not indexed since they were interrupted
        let indexingCodebasesList: string[] = [];
        if (Array.isArray(snapshot.indexingCodebases)) {
            // Legacy format: string[]
            indexingCodebasesList = snapshot.indexingCodebases;
            console.log(`[SNAPSHOT-DEBUG] Found legacy indexingCodebases array format with ${indexingCodebasesList.length} entries`);
        } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
            // New format: Record<string, number>
            indexingCodebasesList = Object.keys(snapshot.indexingCodebases);
            console.log(`[SNAPSHOT-DEBUG] Found new indexingCodebases object format with ${indexingCodebasesList.length} entries`);
        }

        for (const codebasePath of indexingCodebasesList) {
            if (fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Found interrupted indexing codebase: ${codebasePath}. Treating as not indexed.`);
                // Don't add to validIndexingCodebases - treat as not indexed
            } else {
                console.warn(`[SNAPSHOT-DEBUG] Interrupted indexing codebase no longer exists: ${codebasePath}`);
            }
        }

        // Restore state - only fully indexed codebases
        this.indexedCodebases = validCodebases;
        this.indexingCodebases = new Map(); // Reset indexing codebases since they were interrupted
        this.codebaseFileCount = new Map(); // No file count info in v1 format

        // Populate codebaseInfoMap for v1 indexed codebases (with minimal info)
        this.codebaseInfoMap = new Map();
        const now = new Date().toISOString();
        for (const codebasePath of validCodebases) {
            const info: CodebaseInfoIndexed = {
                status: 'indexed',
                indexedFiles: 0, // Unknown in v1 format
                totalChunks: 0,  // Unknown in v1 format
                indexStatus: 'completed', // Assume completed for v1 format
                lastUpdated: now
            };
            this.codebaseInfoMap.set(codebasePath, info);
        }
    }

    /**
 * Convert v2 format to internal state
 */
    private loadV2Format(snapshot: CodebaseSnapshotV2): void {
        console.log('[SNAPSHOT-DEBUG] Loading v2 format snapshot');

        const validIndexedCodebases: string[] = [];
        const validIndexingCodebases = new Map<string, number>();
        const validFileCount = new Map<string, number>();
        const validCodebaseInfoMap = new Map<string, CodebaseInfo>();

        for (const [codebasePath, info] of Object.entries(snapshot.codebases)) {
            if (!fs.existsSync(codebasePath)) {
                console.warn(`[SNAPSHOT-DEBUG] Codebase no longer exists, removing: ${codebasePath}`);
                // Track removal so the next merge-save deletes the ghost from disk
                // instead of silently re-emitting it from the read step.
                this.removedCodebases.add(codebasePath);
                continue;
            }

            // Store the complete info for this codebase
            validCodebaseInfoMap.set(codebasePath, info);

            if (info.status === 'indexed') {
                validIndexedCodebases.push(codebasePath);
                if ('indexedFiles' in info) {
                    validFileCount.set(codebasePath, info.indexedFiles);
                }
                console.log(`[SNAPSHOT-DEBUG] Validated indexed codebase: ${codebasePath} (${info.indexedFiles || 'unknown'} files, ${info.totalChunks || 'unknown'} chunks)`);
            } else if (info.status === 'indexing') {
                if ('indexingPercentage' in info) {
                    validIndexingCodebases.set(codebasePath, info.indexingPercentage);
                }
                console.warn(`[SNAPSHOT-DEBUG] Found interrupted indexing codebase: ${codebasePath} (${info.indexingPercentage || 0}%). Treating as not indexed.`);
                // Don't add to indexed - treat interrupted indexing as not indexed
            } else if (info.status === 'indexfailed') {
                console.warn(`[SNAPSHOT-DEBUG] Found failed indexing codebase: ${codebasePath}. Error: ${info.errorMessage}`);
                // Failed indexing codebases are not added to indexed or indexing lists
                // But we keep the info for potential retry
            }
        }

        // Restore state
        this.indexedCodebases = validIndexedCodebases;
        this.indexingCodebases = new Map(); // Reset indexing codebases since they were interrupted
        this.codebaseFileCount = validFileCount;
        this.codebaseInfoMap = validCodebaseInfoMap;
    }

    public getIndexedCodebases(): string[] {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexed')
                    .map(([path, _]) => path);
            } else {
                // V1 format
                return snapshot.indexedCodebases || [];
            }
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexed codebases from file:`, error);
            // Fallback to memory if file reading fails
            return [...this.indexedCodebases];
        }
    }

    public getIndexingCodebases(): string[] {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return [];
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                return Object.entries(snapshot.codebases)
                    .filter(([_, info]) => info.status === 'indexing')
                    .map(([path, _]) => path);
            } else {
                // V1 format - Handle both legacy array format and new object format
                if (Array.isArray(snapshot.indexingCodebases)) {
                    // Legacy format: return the array directly
                    return snapshot.indexingCodebases;
                } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
                    // New format: return the keys of the object
                    return Object.keys(snapshot.indexingCodebases);
                }
            }

            return [];
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading indexing codebases from file:`, error);
            // Fallback to memory if file reading fails
            return Array.from(this.indexingCodebases.keys());
        }
    }

    private isSameOrDescendantPath(candidatePath: string, codebasePath: string): boolean {
        const relativePath = path.relative(path.resolve(codebasePath), path.resolve(candidatePath));
        return relativePath === ''
            || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    private findBestMatchingCodebasePath(codebasePath: string, candidates: string[]): string | undefined {
        let bestMatch: string | undefined;
        let bestMatchLength = -1;

        for (const candidate of candidates) {
            const resolvedCandidate = path.resolve(candidate);
            if (!this.isSameOrDescendantPath(codebasePath, resolvedCandidate)) continue;

            if (resolvedCandidate.length > bestMatchLength) {
                bestMatch = candidate;
                bestMatchLength = resolvedCandidate.length;
            }
        }

        return bestMatch;
    }

    public findIndexedCodebasePath(codebasePath: string): string | undefined {
        return this.findBestMatchingCodebasePath(codebasePath, this.getIndexedCodebases());
    }

    public findIndexingCodebasePath(codebasePath: string): string | undefined {
        return this.findBestMatchingCodebasePath(codebasePath, this.getIndexingCodebases());
    }

    public findTrackedCodebasePath(codebasePath: string): string | undefined {
        return this.findBestMatchingCodebasePath(codebasePath, Array.from(this.codebaseInfoMap.keys()));
    }

    /**
     * @deprecated Use getCodebaseInfo() for individual codebases or iterate through codebases for v2 format support
     */
    public getIndexingCodebasesWithProgress(): Map<string, number> {
        return new Map(this.indexingCodebases);
    }

    public getIndexingProgress(codebasePath: string): number | undefined {
        // Read from JSON file to ensure consistency and persistence
        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                return undefined;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            if (this.isV2Format(snapshot)) {
                const info = snapshot.codebases[codebasePath];
                if (info && info.status === 'indexing') {
                    return info.indexingPercentage || 0;
                }
                return undefined;
            } else {
                // V1 format - Handle both legacy array format and new object format
                if (Array.isArray(snapshot.indexingCodebases)) {
                    // Legacy format: if path exists in array, assume 0% progress
                    return snapshot.indexingCodebases.includes(codebasePath) ? 0 : undefined;
                } else if (snapshot.indexingCodebases && typeof snapshot.indexingCodebases === 'object') {
                    // New format: return the actual progress percentage
                    return snapshot.indexingCodebases[codebasePath];
                }
            }

            return undefined;
        } catch (error) {
            console.warn(`[SNAPSHOT-DEBUG] Error reading progress from file for ${codebasePath}:`, error);
            // Fallback to memory if file reading fails
            return this.indexingCodebases.get(codebasePath);
        }
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public addIndexingCodebase(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Also update codebaseInfoMap for v2 compatibility
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * @deprecated Use setCodebaseIndexing() instead for v2 format support
     */
    public updateIndexingProgress(codebasePath: string, progress: number): void {
        if (this.indexingCodebases.has(codebasePath)) {
            this.indexingCodebases.set(codebasePath, progress);

            // Also update codebaseInfoMap for v2 compatibility
            const info: CodebaseInfoIndexing = {
                status: 'indexing',
                indexingPercentage: progress,
                lastUpdated: new Date().toISOString()
            };
            this.codebaseInfoMap.set(codebasePath, info);
        }
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexingCodebase(codebasePath: string): void {
        this.indexingCodebases.delete(codebasePath);
        // Also remove from codebaseInfoMap for v2 compatibility
        this.codebaseInfoMap.delete(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public addIndexedCodebase(codebasePath: string, fileCount?: number): void {
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }
        if (fileCount !== undefined) {
            this.codebaseFileCount.set(codebasePath, fileCount);
        }

        // Also update codebaseInfoMap for v2 compatibility
        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: fileCount || 0,
            totalChunks: 0, // Unknown in v1 method
            indexStatus: 'completed',
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * @deprecated Use removeCodebaseCompletely() or state-specific methods instead for v2 format support
     */
    public removeIndexedCodebase(codebasePath: string): void {
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);
        // Also remove from codebaseInfoMap for v2 compatibility
        this.codebaseInfoMap.delete(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() instead for v2 format support
     */
    public moveFromIndexingToIndexed(codebasePath: string, fileCount?: number): void {
        this.removeIndexingCodebase(codebasePath);
        this.addIndexedCodebase(codebasePath, fileCount);
    }

    /**
     * @deprecated Use getCodebaseInfo() and check indexedFiles property instead for v2 format support
     */
    public getIndexedFileCount(codebasePath: string): number | undefined {
        return this.codebaseFileCount.get(codebasePath);
    }

    /**
     * @deprecated Use setCodebaseIndexed() with complete stats instead for v2 format support
     */
    public setIndexedFileCount(codebasePath: string, fileCount: number): void {
        this.codebaseFileCount.set(codebasePath, fileCount);
    }

    /**
     * Set codebase to indexing status
     */
    public setCodebaseIndexing(codebasePath: string, progress: number = 0): void {
        this.indexingCodebases.set(codebasePath, progress);

        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // Update info map
        const info: CodebaseInfoIndexing = {
            status: 'indexing',
            indexingPercentage: progress,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Set codebase to indexed status with complete statistics
     */
    public setCodebaseIndexed(
        codebasePath: string,
        stats: { indexedFiles: number; totalChunks: number; status: 'completed' | 'limit_reached' }
    ): void {
        // Add to indexed list if not already there
        if (!this.indexedCodebases.includes(codebasePath)) {
            this.indexedCodebases.push(codebasePath);
        }

        // Remove from indexing state
        this.indexingCodebases.delete(codebasePath);

        // Update file count and info
        this.codebaseFileCount.set(codebasePath, stats.indexedFiles);

        const info: CodebaseInfoIndexed = {
            status: 'indexed',
            indexedFiles: stats.indexedFiles,
            totalChunks: stats.totalChunks,
            indexStatus: stats.status,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Set codebase to failed status
     */
    public setCodebaseIndexFailed(
        codebasePath: string,
        errorMessage: string,
        lastAttemptedPercentage?: number
    ): void {
        // Remove from other states
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.indexingCodebases.delete(codebasePath);
        this.codebaseFileCount.delete(codebasePath);

        // Update info map
        const info: CodebaseInfoIndexFailed = {
            status: 'indexfailed',
            errorMessage: errorMessage,
            lastAttemptedPercentage: lastAttemptedPercentage,
            lastUpdated: new Date().toISOString()
        };
        this.codebaseInfoMap.set(codebasePath, info);
    }

    /**
     * Get codebase status
     */
    public getCodebaseStatus(codebasePath: string): 'indexed' | 'indexing' | 'indexfailed' | 'not_found' {
        const info = this.codebaseInfoMap.get(codebasePath);
        if (!info) return 'not_found';
        return info.status;
    }

    /**
     * Get complete codebase information
     */
    public getCodebaseInfo(codebasePath: string): CodebaseInfo | undefined {
        return this.codebaseInfoMap.get(codebasePath);
    }

    /**
     * Get all failed codebases
     */
    public getFailedCodebases(): string[] {
        return Array.from(this.codebaseInfoMap.entries())
            .filter(([_, info]) => info.status === 'indexfailed')
            .map(([path, _]) => path);
    }

    /**
     * Completely remove a codebase from all tracking (for clear_index operation)
     */
    public removeCodebaseCompletely(codebasePath: string): void {
        // Remove from all internal state
        this.indexedCodebases = this.indexedCodebases.filter(path => path !== codebasePath);
        this.indexingCodebases.delete(codebasePath);
        this.codebaseFileCount.delete(codebasePath);
        this.codebaseInfoMap.delete(codebasePath);

        // Track removal so merge-save won't resurrect it from the existing file
        this.removedCodebases.add(codebasePath);

        console.log(`[SNAPSHOT-DEBUG] Completely removed codebase from snapshot: ${codebasePath}`);
    }

    public loadCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Loading codebase snapshot from:', this.snapshotFilePath);

        try {
            if (!fs.existsSync(this.snapshotFilePath)) {
                console.log('[SNAPSHOT-DEBUG] Snapshot file does not exist. Starting with empty codebase list.');
                return;
            }

            const snapshotData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const snapshot: CodebaseSnapshot = JSON.parse(snapshotData);

            console.log('[SNAPSHOT-DEBUG] Loaded snapshot:', snapshot);

            if (this.isV2Format(snapshot)) {
                this.loadV2Format(snapshot);
            } else {
                this.loadV1Format(snapshot);
            }

            // Always save in v2 format after loading (migration)
            this.saveCodebaseSnapshot();

        } catch (error: any) {
            console.error('[SNAPSHOT-DEBUG] Error loading snapshot:', error);
            console.log('[SNAPSHOT-DEBUG] Starting with empty codebase list due to snapshot error.');
        }
    }

    /**
     * Ensure the snapshot file exists (needed for proper-lockfile to lock on it).
     */
    private ensureSnapshotFileExists(): void {
        const snapshotDir = path.dirname(this.snapshotFilePath);
        if (!fs.existsSync(snapshotDir)) {
            fs.mkdirSync(snapshotDir, { recursive: true });
            console.log('[SNAPSHOT-DEBUG] Created snapshot directory:', snapshotDir);
        }
        if (!fs.existsSync(this.snapshotFilePath)) {
            // Create an empty v2 snapshot so the file exists for locking
            const empty: CodebaseSnapshotV2 = {
                formatVersion: 'v2',
                codebases: {},
                lastUpdated: new Date().toISOString()
            };
            fs.writeFileSync(this.snapshotFilePath, JSON.stringify(empty, null, 2));
            console.log('[SNAPSHOT-DEBUG] Created empty snapshot file for locking');
        }
    }

    /**
     * Perform the locked read-merge-write of the snapshot file.
     * This is the core logic extracted so it can be called within a lock.
     */
    private mergeAndWriteSnapshot(): void {
        // Read existing snapshot to merge with (prevents multi-session overwrites)
        let existingCodebases: Record<string, CodebaseInfo> = {};
        try {
            const existingData = fs.readFileSync(this.snapshotFilePath, 'utf8');
            const existingSnapshot = JSON.parse(existingData);
            if (existingSnapshot && existingSnapshot.formatVersion === 'v2' && existingSnapshot.codebases) {
                existingCodebases = existingSnapshot.codebases;
                console.log(`[SNAPSHOT-DEBUG] Loaded ${Object.keys(existingCodebases).length} existing codebases for merge`);
            }
        } catch (readError) {
            console.warn('[SNAPSHOT-DEBUG] Could not read existing snapshot for merge, will overwrite:', readError);
        }

        // Merge: start with existing codebases, then apply this session's entries on top.
        const codebases: Record<string, CodebaseInfo> = { ...existingCodebases };

        // Apply all codebases from this session's info map (overwrites same paths, preserves others)
        for (const [codebasePath, info] of this.codebaseInfoMap) {
            codebases[codebasePath] = info;
        }

        // Remove codebases that this session explicitly removed
        for (const removedPath of this.removedCodebases) {
            delete codebases[removedPath];
        }

        const snapshot: CodebaseSnapshotV2 = {
            formatVersion: 'v2',
            codebases: codebases,
            lastUpdated: new Date().toISOString()
        };

        // Atomic write: write to a temp file first, then rename. If we crash
        // mid-write, the canonical file stays intact; only the temp file is
        // left over (cleaned up on next save). The lock prevents two writers
        // from racing, but only an atomic rename prevents readers from seeing
        // a half-written file if a writer crashes between open() and final
        // flush. tmp file lives next to the target so the rename is on the
        // same filesystem (POSIX atomicity guarantee).
        const tmp = `${this.snapshotFilePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
        fs.renameSync(tmp, this.snapshotFilePath);

        const indexedCount = this.indexedCodebases.length;
        const indexingCount = this.indexingCodebases.size;
        const failedCount = this.getFailedCodebases().length;
        const totalInFile = Object.keys(codebases).length;

        console.log(`[SNAPSHOT-DEBUG] Snapshot saved (merged) in v2 format. This session - Indexed: ${indexedCount}, Indexing: ${indexingCount}, Failed: ${failedCount}. Total in file: ${totalInFile}`);
    }

    public saveCodebaseSnapshot(): void {
        console.log('[SNAPSHOT-DEBUG] Saving codebase snapshot to:', this.snapshotFilePath);

        try {
            this.ensureSnapshotFileExists();

            // Acquire file lock, then read-merge-write atomically.
            //
            // proper-lockfile@4 forbids `retries` on the sync API (adapter.js throws
            // ESYNC: "Cannot use retries with the sync api"). We need synchronous
            // semantics here because saveCodebaseSnapshot() is invoked by sync code
            // paths in handlers.ts, so we implement the retry loop ourselves and
            // sleep with Atomics.wait — Node's only native synchronous sleep that
            // works on the main thread (verified Node 20+).
            let release: (() => void) | undefined;
            const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
            const MAX_ATTEMPTS = 6; // 1 initial + 5 retries (matches former intent)
            let lastErr: any;
            for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
                try {
                    release = lockfile.lockSync(this.snapshotFilePath, {
                        stale: 10000, // Consider lock stale after 10s (handles crashed processes)
                    });
                    if (attempt > 0) {
                        console.log(`[SNAPSHOT-DEBUG] File lock acquired after ${attempt} retries`);
                    } else {
                        console.log('[SNAPSHOT-DEBUG] File lock acquired');
                    }
                    break;
                } catch (err: any) {
                    lastErr = err;
                    // Only retry on contention; any other error is a real problem.
                    if (err?.code !== 'ELOCKED') {
                        throw err;
                    }
                    if (attempt === MAX_ATTEMPTS - 1) {
                        throw err;
                    }
                    // Exponential backoff: 100, 200, 400, 800, then capped at 1000ms
                    const wait = Math.min(100 * (1 << attempt), 1000);
                    Atomics.wait(SLEEP_BUF, 0, 0, wait);
                }
            }

            try {
                this.mergeAndWriteSnapshot();
            } finally {
                if (release) {
                    release();
                    console.log('[SNAPSHOT-DEBUG] File lock released');
                }
            }
        } catch (error: any) {
            // If locking fails (e.g. permissions, filesystem doesn't support locks,
            // or contention exhausted retries), fall back to unlocked merge-write.
            // Better than refusing to save at all.
            console.warn('[SNAPSHOT-DEBUG] File lock failed, falling back to unlocked save:', error.message);
            try {
                this.mergeAndWriteSnapshot();
            } catch (fallbackError: any) {
                console.error('[SNAPSHOT-DEBUG] Error saving snapshot:', fallbackError);
            }
        }
    }
}
