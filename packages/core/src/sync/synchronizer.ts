import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { MerkleDAG } from './merkle';
import * as os from 'os';
import { IgnoreMatcher } from '../utils/ignore-matcher';

// A file's size and modification time at the moment it was last hashed. When both are unchanged on the
// next scan, the stored hash is reused instead of reading the file again: re-reading and hashing every
// file of every indexed codebase on each periodic sync kept the MCP at ~0.7 CPU cores continuously on
// a 20-codebase / ~23k-file index (2026-10-04).
interface FileStat {
    mtimeMs: number;
    size: number;
}

// Racy-timestamp guard (as in git): a file modified this close to the scan may be written again within
// the same timestamp tick without its size changing, so its stat cannot vouch for its content.
const RACY_WINDOW_MS = 2000;

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private fileStats: Map<string, FileStat>;
    private merkleDAG: MerkleDAG;
    // A scan whose work has not finished yet. It becomes the saved baseline only through commitChanges().
    private pendingBaseline: { fileHashes: Map<string, string>; fileStats: Map<string, FileStat>; merkleDAG: MerkleDAG } | null = null;
    private rootDir: string;
    private snapshotPath: string;
    private includeDotDirs: string[];
    private supportedExtensions: string[];
    private ignoreMatcher: IgnoreMatcher;

    constructor(rootDir: string, ignorePatterns: string[] = [], includeDotDirs: string[] = [], supportedExtensions: string[] = []) {
        this.rootDir = rootDir;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.fileStats = new Map();
        this.merkleDAG = new MerkleDAG();
        // Normalize: ensure entries have no trailing slashes
        this.includeDotDirs = includeDotDirs.map(d => d.replace(/\/+$/, ''));
        this.supportedExtensions = supportedExtensions;
        // Upstream's gitignore-compatible matcher (negation, root anchoring) plus the fork's
        // includeDotDirs allow-list for otherwise-hidden dot directories.
        this.ignoreMatcher = new IgnoreMatcher(ignorePatterns, this.includeDotDirs);
    }

    private getSnapshotPath(codebasePath: string): string {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');

        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');

        return path.join(merkleDir, `${hash}.json`);
    }

    private async hashFile(filePath: string): Promise<string> {
        // Double-check that this is actually a file, not a directory
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            throw new Error(`Attempted to hash a directory: ${filePath}`);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Hash every supported file under `dir`. When `stats` is given, it is filled with each file's size and
     * mtime, and a file whose size and mtime match `this.fileStats` (and which is outside the racy window)
     * reuses its hash from `this.fileHashes` instead of being read again.
     */
    private async generateFileHashes(dir: string, stats?: Map<string, FileStat>, scanStartMs: number = Date.now()): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error: any) {
            console.warn(`[Synchronizer] Cannot read directory ${dir}: ${error.message}`);
            return fileHashes;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.rootDir, fullPath);

            // Check if this path should be ignored BEFORE any file system operations
            if (this.shouldIgnore(relativePath, entry.isDirectory())) {
                continue; // Skip completely - no access at all
            }

            // Double-check with fs.stat to be absolutely sure about file type
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (error: any) {
                console.warn(`[Synchronizer] Cannot stat ${fullPath}: ${error.message}`);
                continue;
            }

            if (stat.isDirectory()) {
                // Verify it's really a directory and not ignored
                if (!this.shouldIgnore(relativePath, true)) {
                    const subHashes = await this.generateFileHashes(fullPath, stats, scanStartMs);
                    const entries = Array.from(subHashes.entries());
                    for (let i = 0; i < entries.length; i++) {
                        const [p, h] = entries[i];
                        fileHashes.set(p, h);
                    }
                }
            } else if (stat.isFile()) {
                // Verify it's really a file and not ignored
                if (!this.shouldIgnore(relativePath, false)) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.length > 0 && !this.supportedExtensions.includes(ext)) {
                        continue;
                    }
                    try {
                        const current: FileStat = { mtimeMs: stat.mtimeMs, size: stat.size };
                        const known = this.fileStats.get(relativePath);
                        const knownHash = this.fileHashes.get(relativePath);
                        const unchanged = known !== undefined && knownHash !== undefined
                            && known.mtimeMs === current.mtimeMs && known.size === current.size
                            && scanStartMs - current.mtimeMs > RACY_WINDOW_MS;
                        const hash = unchanged ? knownHash! : await this.hashFile(fullPath);
                        fileHashes.set(relativePath, hash);
                        stats?.set(relativePath, current);
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
                        continue;
                    }
                }
            }
            // Skip other types (symlinks, etc.)
        }
        return fileHashes;
    }

    private shouldIgnore(relativePath: string, isDirectory: boolean): boolean {
        return this.ignoreMatcher.ignores(relativePath, isDirectory);
    }

    private buildMerkleDAG(fileHashes: Map<string, string>): MerkleDAG {
        const dag = new MerkleDAG();
        const keys = Array.from(fileHashes.keys());
        const sortedPaths = keys.slice().sort(); // Create a sorted copy

        // Create a root node for the entire directory
        let valuesString = "";
        sortedPaths.forEach(key => {
            valuesString += fileHashes.get(key);
        });
        const rootNodeData = "root:" + valuesString;
        const rootNodeId = dag.addNode(rootNodeData);

        // Add each file as a child of the root
        for (const path of sortedPaths) {
            const fileData = path + ":" + fileHashes.get(path);
            dag.addNode(fileData, rootNodeId);
        }

        return dag;
    }

    public async initialize() {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        await this.loadSnapshot();
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} file hashes.`);
    }

    /**
     * Hold what is on disk now as the baseline a full index is about to read. Taken before the index walks the tree, so
     * a file edited during the index differs from it and the next check finds that file. Nothing is saved until
     * commitChanges(): a failed index must leave the previous baseline in place.
     */
    public async captureBaseline(): Promise<void> {
        const fileStats = new Map<string, FileStat>();
        const fileHashes = await this.generateFileHashes(this.rootDir, fileStats);
        this.pendingBaseline = { fileHashes, fileStats, merkleDAG: this.buildMerkleDAG(fileHashes) };
    }

    /** Save the pending baseline. Call only after the rows for it are in the vector store. */
    public async commitChanges(): Promise<void> {
        if (!this.pendingBaseline) {
            return;
        }
        this.fileHashes = this.pendingBaseline.fileHashes;
        this.fileStats = this.pendingBaseline.fileStats;
        this.merkleDAG = this.pendingBaseline.merkleDAG;
        this.pendingBaseline = null;
        await this.saveSnapshot();
    }

    /**
     * Compare disk with the baseline. With deferCommit the baseline does not move: the caller deletes and re-embeds the
     * changed files, then calls commitChanges(). If that work stops part way, the changes are found again next time.
     */
    public async checkForChanges(options: { deferCommit?: boolean } = {}): Promise<{ added: string[], removed: string[], modified: string[] }> {
        console.log('[Synchronizer] Checking for file changes...');

        const newFileStats = new Map<string, FileStat>();
        const newFileHashes = await this.generateFileHashes(this.rootDir, newFileStats);
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);
        const statsChanged = !FileSynchronizer.sameStats(this.fileStats, newFileStats);

        // Compare the DAGs
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);

        // If there are any changes in the DAG, do a file-level comparison
        if (changes.added.length > 0 || changes.removed.length > 0) {
            console.log('[Synchronizer] Merkle DAG has changed. Comparing file states...');
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);

            if (options.deferCommit) {
                this.pendingBaseline = { fileHashes: newFileHashes, fileStats: newFileStats, merkleDAG: newMerkleDAG };
                console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
                return fileChanges;
            }

            this.fileHashes = newFileHashes;
            this.fileStats = newFileStats;
            this.merkleDAG = newMerkleDAG;
            await this.saveSnapshot();

            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
            return fileChanges;
        }

        // Content is unchanged, but sizes or timestamps may have moved (a touched file, or a snapshot written
        // before stats were stored). Persist them so the next scan, and the next process, can skip the read.
        if (statsChanged) {
            this.fileStats = newFileStats;
            await this.saveSnapshot();
        }

        console.log('[Synchronizer] No changes detected based on Merkle DAG comparison.');
        return { added: [], removed: [], modified: [] };
    }

    private static sameStats(a: Map<string, FileStat>, b: Map<string, FileStat>): boolean {
        if (a.size !== b.size) {
            return false;
        }
        for (const [file, s] of Array.from(b.entries())) {
            const o = a.get(file);
            if (!o || o.mtimeMs !== s.mtimeMs || o.size !== s.size) {
                return false;
            }
        }
        return true;
    }

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[], removed: string[], modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        const newEntries = Array.from(newHashes.entries());
        for (let i = 0; i < newEntries.length; i++) {
            const [file, hash] = newEntries[i];
            if (!oldHashes.has(file)) {
                added.push(file);
            } else if (oldHashes.get(file) !== hash) {
                modified.push(file);
            }
        }

        const oldKeys = Array.from(oldHashes.keys());
        for (let i = 0; i < oldKeys.length; i++) {
            const file = oldKeys[i];
            if (!newHashes.has(file)) {
                removed.push(file);
            }
        }

        return { added, removed, modified };
    }

    public getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    private async saveSnapshot(): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        await fs.mkdir(merkleDir, { recursive: true });

        // Convert Map to array without using iterator
        const fileHashesArray: [string, string][] = [];
        const keys = Array.from(this.fileHashes.keys());
        keys.forEach(key => {
            fileHashesArray.push([key, this.fileHashes.get(key)!]);
        });

        const fileStatsArray: [string, number, number][] = [];
        Array.from(this.fileStats.entries()).forEach(([key, s]) => {
            fileStatsArray.push([key, s.mtimeMs, s.size]);
        });

        const data = JSON.stringify({
            fileHashes: fileHashesArray,
            fileStats: fileStatsArray,
            merkleDAG: this.merkleDAG.serialize()
        });
        await fs.writeFile(this.snapshotPath, data, 'utf-8');
        console.log(`Saved snapshot to ${this.snapshotPath}`);
    }

    private async loadSnapshot(): Promise<void> {
        try {
            const data = await fs.readFile(this.snapshotPath, 'utf-8');
            const obj = JSON.parse(data);

            // Reconstruct Map without using constructor with iterator
            this.fileHashes = new Map();
            for (const [key, value] of obj.fileHashes) {
                this.fileHashes.set(key, value);
            }

            // Absent in snapshots written before stats were stored: those files are re-read once.
            this.fileStats = new Map();
            if (Array.isArray(obj.fileStats)) {
                for (const [key, mtimeMs, size] of obj.fileStats) {
                    this.fileStats.set(key, { mtimeMs, size });
                }
            }

            if (obj.merkleDAG) {
                this.merkleDAG = MerkleDAG.deserialize(obj.merkleDAG);
            }
            console.log(`Loaded snapshot from ${this.snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found at ${this.snapshotPath}. Generating new one.`);
                const stats = new Map<string, FileStat>();
                this.fileHashes = await this.generateFileHashes(this.rootDir, stats);
                this.fileStats = stats;
                this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
                await this.saveSnapshot();
            } else {
                throw error;
            }
        }
    }

    /**
     * Delete snapshot file for a given codebase path
     */
    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const snapshotPath = path.join(merkleDir, `${hash}.json`);

        try {
            await fs.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, error.message);
                throw error; // Re-throw non-ENOENT errors
            }
        }
    }
}
