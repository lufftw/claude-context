# Upstream merge — 2026-11-04 (zilliztech/claude-context `master` @ `6fc318b`, 0.1.15)

A real `git merge` of `upstream/master` (68 commits since merge-base `7255be0`), replacing the
earlier cherry-pick approach (see `upstream-cherry-pick-log.md`). Packages are versioned
`0.1.15-lufftw.1`.

## Adopted from upstream

| Upstream change | Where it landed |
|---|---|
| gitignore-compatible `IgnoreMatcher` (negation `!`, root-anchored `/dir`) — `627eb2b`, `be107de` | `utils/ignore-matcher.ts`; used by both `Context.getCodeFiles` and `FileSynchronizer` |
| Per-codebase / per-request ignore patterns, extensions, splitter (`e368a97`, `b56ca04`, `d2ef81c`, `ead19f4`) | `Context.indexCodebase` / `reindexByChange`, MCP handlers, snapshot `request*` fields |
| Cancel background indexing on `clear_index` (`291863a`) — `AbortSignal` + `IndexAbortError` | `processFileList` checks the signal per file and skips the final flush |
| Search result de-duplication (`3675469`) | applied after the fork's multi-collection merge + sort, before `topK` |
| `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE` (`d4ad9ec`) | used only when `MILVUS_COLLECTION_PRIVATE` is not set |
| Trigger-file watcher `~/.context/.sync-trigger` (`82a37ad`), background sync knobs (`62323f4`) | `mcp/src/sync.ts` |
| Subdirectory → indexed parent resolution (`b03ebac`) | search / status use the resolved root |
| Embedding-error surfacing (`f8e2672`), Gemini Embedding 2, deterministic Merkle root, MCP version from package.json | see below for the embedding-error synthesis |

## Kept from the fork (upstream behaviour intentionally not adopted)

- **Snapshot writer**: `proper-lockfile` + field-merging read-merge-write + atomic rename stays;
  upstream's `mkdir` lock / `mergeExternalEntry` were dropped.
- **Interrupted `indexing` entries stay `indexing` on load** (upstream rewrites them to
  `indexfailed`). They carry the per-file resume ledger and, with a shared
  `CLAUDE_CONTEXT_HOME`, may belong to a live peer process.
- **Cloud sync does not re-add cloud-only codebases** (upstream #295 added this). Milvus is shared
  across machines here, so those are other machines' codebases.
- **Partial-tolerant embedding** (REAL/WAIT classification, consecutive-failure abort,
  per-target isolation) stays. Upstream's "any embedding error aborts" is reconciled as:
  - the fork's primary consecutive-failure abort is now an `EmbeddingError` instance;
  - a run in which the primary stored **nothing** but saw REAL failures throws `EmbeddingError`
    (with the provider's last error message) instead of reporting an empty index as `completed`;
  - the default `embedBatchPartial` rejects count/empty-vector mismatches as a whole-batch failure
    (upstream's `validateEmbeddings`), so vectors are never mis-paired with chunks.
- Fork's internal abort sentinel was renamed `EmbedFailureAbortError` to avoid clashing with
  upstream's exported `IndexAbortError` (cancellation).

## Signature notes

`Context.indexCodebase(path, progress, onFileComplete, forceReindex, priorLedgersByModel,
additionalIgnorePatterns, additionalSupportedExtensions, requestSplitter, signal)` — the fork's
parameters keep their positions; upstream's new ones are appended. Upstream's new tests were
adapted to this order and to the fork's `upsert` write path.

`includeDotDirs` (`.contextinclude`) now also applies to the initial scan (`getCodeFiles`), not only
to `FileSynchronizer`, so both see the same file set.

Upstream's `CLAUDE.md` (`AGENTS.md` symlink) is kept as `docs/upstream-repository-guide.md`; the fork
keeps its own `AGENTS.md` and its gitignored local `CLAUDE.md`.
