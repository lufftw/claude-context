/**
 * Auto-load policy for Milvus collections.
 *
 * WHY THIS EXISTS
 *
 * Before every search and query, both Milvus backends call `ensureLoaded()`, which asks Milvus for the
 * collection's load state and, if it is not loaded, loads it. That is a sensible default for a small
 * collection and a trap for a large one, because it means **a collection can never stay released**: an
 * operator releases it to reclaim memory, and the very next code search loads it again.
 *
 * On the estate this was written for, one collection (`event_shared`: 586,641 rows x 4,096 dimensions,
 * about 9.6 GB of raw float32 vectors) accounted for 70% of all vector data across 51 collections.
 * Releasing it took the Milvus process from 11.96 GiB to 3.42 GiB resident. It was released by an explicit
 * operator ruling on 2026-09-24 and was found loaded again three days later, because `ensureLoaded()` had
 * quietly restored it on the first search in any repository that touches it. The service's footprint then
 * grew by 10 GiB, it began paging its index from disk, and the host it ran on saturated.
 *
 * So this is not a performance tweak. It is the difference between a release that holds and one that does
 * not, and therefore between a memory budget that means something and one that is advisory.
 *
 * BEHAVIOUR
 *
 * Opt-in and off by default: with no configuration, `isAutoLoadDenied()` returns false for everything and
 * the callers behave exactly as before. Set `MILVUS_AUTOLOAD_DENY` to a comma- or whitespace-separated list
 * of collection names to refuse *implicit* loads of those collections:
 *
 *     MILVUS_AUTOLOAD_DENY=event_shared
 *     MILVUS_AUTOLOAD_DENY=event_shared,agent_shared
 *     MILVUS_AUTOLOAD_DENY=*_shared        // trailing or leading wildcard
 *
 * A denied collection that is ALREADY loaded is searched normally — the policy governs loading, not access.
 * Explicit loads (creating a collection, indexing into it) are deliberately not affected: they go through
 * `loadCollection` / `loadCollectionWithRetry` directly, and refusing them would break indexing rather than
 * bound memory.
 *
 * The failure is loud on purpose. A silent empty result set would look like "this code isn't in the index"
 * and send someone hunting for a phantom indexing bug.
 */

const ENV_VAR = 'MILVUS_AUTOLOAD_DENY';

/** Split on commas and whitespace, drop empties. Quotes are tolerated because shells and JSON both leak them. */
function parsePatterns(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(/[,\s]+/)
        .map(p => p.trim().replace(/^['"]|['"]$/g, ''))
        .filter(p => p.length > 0);
}

/**
 * Match a collection name against one pattern. Supports `*` as a wildcard for any run of characters, so
 * `*_shared`, `event_*` and `*shared*` all work. Matching is exact when the pattern has no `*`.
 */
function matches(name: string, pattern: string): boolean {
    if (!pattern.includes('*')) return name === pattern;
    const escaped = pattern
        .split('*')
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`).test(name);
}

/** The configured patterns, read fresh each call so a test or a long-lived process can change them. */
export function autoLoadDenyPatterns(env: NodeJS.ProcessEnv = process.env): string[] {
    return parsePatterns(env[ENV_VAR]);
}

/**
 * Should an *implicit* load of this collection be refused?
 * False whenever nothing is configured, which is the default.
 */
export function isAutoLoadDenied(collectionName: string, env: NodeJS.ProcessEnv = process.env): boolean {
    return autoLoadDenyPatterns(env).some(p => matches(collectionName, p));
}

/**
 * The message for a refusal. It names the collection, the rule that matched, and how to proceed, because
 * whoever hits this will be several layers away from this file.
 */
export function autoLoadDenyMessage(collectionName: string, env: NodeJS.ProcessEnv = process.env): string {
    const pattern = autoLoadDenyPatterns(env).find(p => matches(collectionName, p)) ?? collectionName;
    return (
        `Collection '${collectionName}' is not loaded, and ${ENV_VAR} ('${pattern}') forbids loading it ` +
        `implicitly. This guard exists so that releasing a large collection actually holds: without it the ` +
        `next search reloads it and the memory is never reclaimed. ` +
        `To search it, either load it deliberately (Milvus 'collections/load'), or remove it from ` +
        `${ENV_VAR}. To search something else, target a collection that is loaded.`
    );
}
