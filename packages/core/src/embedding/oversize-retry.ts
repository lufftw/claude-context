/**
 * Oversize-chunk handling for the RabbitMQ embedding client.
 *
 * Some workers (the 0.6B llama-server worker, context 2048 tokens) answer a chunk longer than their context with a terminal
 * HTTP 400 `exceed_context_size_error` even though the request carries `truncate:'end'`. That is a property of one chunk
 * (dense CJK text of 2,500 characters is about 2,200 tokens), not a fault of the model or the worker, yet the indexer counts it
 * as a REAL-class failure; three in a row dropped the whole 0.6B target for the rest of a run (event-search-service,
 * taiwan-counties.ts, 2026-11-09: 31 of 70 chunks over the limit).
 *
 * The worker states both numbers in its error, so the cut is computed from them: keep the leading part of the text, which is
 * what `truncate:'end'` was meant to do. The row keeps its place in both models (ids pair, coverage holds); its vector
 * describes the leading part of the chunk.
 */

const OVERSIZE = /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i;

/** Safety margin under the limit: character-to-token ratios differ along one chunk, and a second pass costs a round trip. */
const MARGIN = 0.9;

/** At most this many shortenings per chunk; an input that still overflows after them is a real failure. */
export const MAX_OVERSIZE_CUTS = 3;

/**
 * llama-server answers 500 "Context size has been exceeded" to a request that fit on its own when other long requests are in
 * flight on the same worker (observed 2026-11-09: 22 of 70 chunks of one file at concurrency 4, none at concurrency 1, a 7-character
 * chunk among them). It is a momentary capacity condition, so the request is sent again after a short pause.
 */
const CONTEXT_BUSY = /context size has been exceeded/i;

/** Pauses (ms) before each resend of a request refused for momentary context pressure; its length is the resend limit. */
export const CONTEXT_BUSY_BACKOFF_MS = [1000, 2500, 5000, 10000, 20000, 30000];

export function isContextBusy(errorMessage: string): boolean {
    return CONTEXT_BUSY.test(errorMessage);
}

/**
 * Returns a shortened text when `errorMessage` is the worker's context-size error for `text`, or null when it is any other
 * error (so the caller fails as before), or when the text cannot be shortened further.
 */
export function shortenForContextLimit(text: string, errorMessage: string): string | null {
    const m = errorMessage.match(OVERSIZE);
    if (!m) return null;
    const tokens = Number(m[1]);
    const limit = Number(m[2]);
    if (!(tokens > limit) || !(limit > 0) || text.length < 2) return null;
    const keep = Math.floor(text.length * (limit / tokens) * MARGIN);
    if (keep < 1 || keep >= text.length) return null;
    return text.slice(0, keep);
}
