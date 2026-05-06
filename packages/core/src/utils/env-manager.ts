import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AsyncLocalStorage } from 'async_hooks';

interface ProjectContext {
    projectEnvPath: string | undefined;
    cache: Map<string, string> | undefined;
}

export class EnvManager {
    private envFilePath: string;

    // Legacy fallback used when no AsyncLocalStorage context is active. Kept
    // so external callers that mutate state imperatively (setProjectPath +
    // serial calls) keep working — but parallel callers MUST use
    // runWithProject() to avoid clobbering each other's state.
    private projectEnvPath: string | undefined;
    private projectEnvCache: Map<string, string> | undefined;
    private projectEnvCachePath: string | undefined;

    // AsyncLocalStorage gives each async call chain its own ProjectContext
    // independent of any other concurrent chain. Critical because
    // Context.indexCodebase() runs many async operations with project-scoped
    // env reads (MILVUS_COLLECTION_PRIVATE etc.) that must not be visible to
    // a sibling indexCodebase() running in parallel — the bug that caused
    // 2026-05-04 cross-collection contamination during parallel Tier 2.
    private als: AsyncLocalStorage<ProjectContext> = new AsyncLocalStorage();

    constructor() {
        const homeDir = os.homedir();
        this.envFilePath = path.join(homeDir, '.context', '.env');
    }

    /**
     * Run an async function inside a project-scoped env context. Project
     * `.env` lookups inside `fn` (transitively, through any await chain) will
     * resolve to this projectPath only — concurrent runWithProject() calls
     * with other paths do not interfere.
     *
     * Replaces the older pattern:
     *   envManager.setProjectPath(p);
     *   await ...do work...
     * which was unsafe under concurrency because setProjectPath mutates
     * shared state.
     */
    async runWithProject<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
        const resolved = path.resolve(projectPath);
        const envFile = path.join(resolved, '.env');
        const ctx: ProjectContext = {
            projectEnvPath: fs.existsSync(envFile) ? envFile : undefined,
            cache: undefined, // built lazily on first get()
        };
        if (ctx.projectEnvPath) {
            console.log(`[EnvManager] Project .env scoped (ALS): ${envFile}`);
        }
        return this.als.run(ctx, fn);
    }

    /**
     * Set the current project path for project-scoped .env loading.
     * Call this before operations that need project-specific env vars
     * (e.g., MILVUS_STRATEGY, MILVUS_COLLECTION_PRIVATE).
     *
     * Priority after this call:
     *   1. Project .env  (highest — project identity)
     *   2. process.env   (MCP env block + OS env)
     *   3. ~/.context/.env (global fallback)
     */
    setProjectPath(projectPath: string): void {
        const resolved = path.resolve(projectPath);
        const envFile = path.join(resolved, '.env');

        if (fs.existsSync(envFile)) {
            this.projectEnvPath = envFile;
            // Invalidate cache if path changed
            if (this.projectEnvCachePath !== envFile) {
                this.projectEnvCache = undefined;
                this.projectEnvCachePath = envFile;
            }
            console.log(`[EnvManager] Project .env loaded: ${envFile}`);
        } else {
            this.projectEnvPath = undefined;
            this.projectEnvCache = undefined;
            this.projectEnvCachePath = undefined;
        }
    }

    /**
     * Clear the project path (revert to global-only resolution).
     */
    clearProjectPath(): void {
        this.projectEnvPath = undefined;
        this.projectEnvCache = undefined;
        this.projectEnvCachePath = undefined;
    }

    /**
     * Get environment variable by name.
     * Priority:
     *   1. ALS-scoped project .env  (per-call, set by runWithProject)
     *   2. Legacy global project .env  (set by setProjectPath — for callers
     *      that have not yet migrated to runWithProject)
     *   3. process.env  (MCP env block + OS environment)
     *   4. Global ~/.context/.env  (fallback)
     */
    get(name: string): string | undefined {
        // 1. ALS-scoped project .env (highest priority — wins over global state)
        const alsCtx = this.als.getStore();
        if (alsCtx?.projectEnvPath) {
            if (!alsCtx.cache) {
                alsCtx.cache = this.parseEnvFile(alsCtx.projectEnvPath);
            }
            const v = alsCtx.cache.get(name);
            if (v !== undefined) return v;
            // Fall through to lower-priority sources for unset keys (e.g. credentials)
        }

        // 2. Legacy global project .env
        const projectValue = this.getFromProjectEnv(name);
        if (projectValue !== undefined) {
            return projectValue;
        }

        // 3. process.env (MCP env block + OS environment)
        if (process.env[name]) {
            return process.env[name];
        }

        // 4. Global ~/.context/.env (fallback)
        return this.getFromFile(this.envFilePath, name);
    }

    /**
     * Read a variable from the legacy globally-set project .env file.
     */
    private getFromProjectEnv(name: string): string | undefined {
        if (!this.projectEnvPath) return undefined;

        if (!this.projectEnvCache) {
            this.projectEnvCache = this.parseEnvFile(this.projectEnvPath);
        }

        return this.projectEnvCache.get(name);
    }

    /**
     * Read a single variable from a .env file (no caching).
     */
    private getFromFile(filePath: string, name: string): string | undefined {
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lines = content.split('\n');

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.startsWith(`${name}=`)) {
                        return trimmedLine.substring(name.length + 1);
                    }
                }
            }
        } catch (error) {
            // Ignore file read errors
        }
        return undefined;
    }

    /**
     * Parse a .env file into a Map. Skips comments and blank lines.
     */
    private parseEnvFile(filePath: string): Map<string, string> {
        const result = new Map<string, string>();
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf-8');
                for (const line of content.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#')) continue;
                    const eqIndex = trimmed.indexOf('=');
                    if (eqIndex > 0) {
                        const key = trimmed.substring(0, eqIndex).trim();
                        const value = trimmed.substring(eqIndex + 1).trim();
                        result.set(key, value);
                    }
                }
            }
        } catch (error) {
            // Ignore file read errors
        }
        return result;
    }

    /**
     * Set environment variable to the global .env file
     */
    set(name: string, value: string): void {
        try {
            // Ensure directory exists
            const envDir = path.dirname(this.envFilePath);
            if (!fs.existsSync(envDir)) {
                fs.mkdirSync(envDir, { recursive: true });
            }

            let content = '';
            let found = false;

            // Read existing content if file exists
            if (fs.existsSync(this.envFilePath)) {
                content = fs.readFileSync(this.envFilePath, 'utf-8');

                // Update existing variable
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].trim().startsWith(`${name}=`)) {
                        // Replace the existing value
                        lines[i] = `${name}=${value}`;
                        found = true;
                        console.log(`[EnvManager] Updated ${name} in ${this.envFilePath}`);
                        break;
                    }
                }
                content = lines.join('\n');
            }

            // If variable not found, append it
            if (!found) {
                if (content && !content.endsWith('\n')) {
                    content += '\n';
                }
                content += `${name}=${value}\n`;
                console.log(`[EnvManager] Added ${name} to ${this.envFilePath}`);
            }

            fs.writeFileSync(this.envFilePath, content, 'utf-8');

        } catch (error) {
            console.error(`[EnvManager] Failed to write env file: ${error}`);
            throw error;
        }
    }

    /**
     * Get the path to the global .env file
     */
    getEnvFilePath(): string {
        return this.envFilePath;
    }

    /**
     * Get the current project .env path, if set.
     */
    getProjectEnvPath(): string | undefined {
        return this.projectEnvPath;
    }
}

// Export a default instance for convenience
export const envManager = new EnvManager();
