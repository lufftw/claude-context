import ignore, { Ignore } from 'ignore';

export class IgnoreMatcher {
    private matcher: Ignore;
    private includeDotDirs: string[];

    /**
     * @param patterns gitignore-style patterns
     * @param includeDotDirs (fork) dot-prefixed path segments (e.g. '.github') that are
     *        NOT treated as hidden. A path is hidden unless every dot-prefixed segment
     *        is in this list. Ignore patterns still apply to included dot dirs.
     */
    constructor(patterns: string[] = [], includeDotDirs: string[] = []) {
        this.includeDotDirs = includeDotDirs
            .map(d => d.trim().replace(/[\\/]+$/, ''))
            .filter(d => d.length > 0);

        const cleanPatterns = patterns
            .map(pattern => pattern.trim())
            .filter(pattern => pattern.length > 0 && !pattern.startsWith('#'));

        this.matcher = ignore().add(cleanPatterns);
    }

    ignores(relativePath: string, isDirectory: boolean = false): boolean {
        const normalizedPath = this.normalizePath(relativePath);
        if (!normalizedPath) {
            return false;
        }

        if (this.hasHiddenSegment(normalizedPath)) {
            return true;
        }

        if (this.matcher.ignores(normalizedPath)) {
            return true;
        }

        return isDirectory && this.matcher.ignores(`${normalizedPath}/`);
    }

    private normalizePath(relativePath: string): string {
        return relativePath
            .replace(/\\/g, '/')
            .replace(/^\/+|\/+$/g, '');
    }

    private hasHiddenSegment(relativePath: string): boolean {
        return relativePath
            .split('/')
            .some(part => part.length > 0 && part.startsWith('.') && !this.includeDotDirs.includes(part));
    }
}
