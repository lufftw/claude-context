import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class EnvManager {
    private envFilePath: string;
    private projectEnvPath: string | undefined;
    private projectEnvCache: Map<string, string> | undefined;
    private projectEnvCachePath: string | undefined;

    constructor() {
        const homeDir = os.homedir();
        this.envFilePath = path.join(homeDir, '.context', '.env');
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
     * Priority: project .env > process.env > ~/.context/.env > undefined
     */
    get(name: string): string | undefined {
        // 1. Project .env (highest priority for project-scoped vars)
        const projectValue = this.getFromProjectEnv(name);
        if (projectValue !== undefined) {
            return projectValue;
        }

        // 2. process.env (MCP env block + OS environment)
        if (process.env[name]) {
            return process.env[name];
        }

        // 3. Global ~/.context/.env (fallback)
        return this.getFromFile(this.envFilePath, name);
    }

    /**
     * Read a variable from the project .env file.
     * Uses a parsed cache to avoid re-reading the file on every get() call.
     */
    private getFromProjectEnv(name: string): string | undefined {
        if (!this.projectEnvPath) return undefined;

        // Build cache on first access
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
