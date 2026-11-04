# Changelog (lufftw fork)

Changes to this fork, newest first. Upstream changes are listed in [zilliztech/claude-context releases](https://github.com/zilliztech/claude-context/releases).

## Unreleased

### Platform support and verification
- Supported platforms are now stated explicitly: Windows 11 and Ubuntu 24.04 LTS, Node.js 20, 22 and 24 ([Platform Support](../getting-started/platform-support.md)).
- CI pins `ubuntu-24.04` and `windows-2025` and, besides building, now runs the core and MCP unit tests, the offline MCP integration checks and an MCP stdio smoke test on both, for each Node version.
- New CI job `e2e_live` runs the core integration tests and a new end-to-end test (`packages/mcp/scripts/e2e-live.mjs`) against real Milvus 2.5 and RabbitMQ 3.13 containers. The same script can be run on Windows 11 by hand.
- Fixed: `pnpm --filter @zilliz/claude-context-mcp test` failed on Node 20, because `node --test` glob patterns need Node 21 or later. Test files are now discovered by `scripts/run-unit-tests.mjs`.
- Fixed: on Windows, tests that redirected only `HOME` read and wrote the real `%USERPROFILE%\.context`. They now redirect `USERPROFILE` too.
- `.gitattributes` enforces LF line endings, so Windows checkouts can no longer commit CRLF files (which previously caused whole-file merge conflicts).

### Documentation
- New: [Platform Support](../getting-started/platform-support.md), [Testing Guide](../dive-deep/testing.md), [Security Policy](../../SECURITY.md), this changelog.
- Environment variable reference covers every fork variable and upstream's sync settings; fork overview and credential policy added (see 0.1.15-lufftw.1).

## 0.1.15-lufftw.1 (2026-11-04)

### Upstream
- Merged upstream `zilliztech/claude-context` 0.1.15 (68 commits): gitignore-compatible ignore rules (negation, root anchoring), per-request ignore/extension/splitter options, cancellation of background indexing on `clear_index`, search result de-duplication, `CODE_CHUNKS_COLLECTION_NAME_OVERRIDE`, the `.sync-trigger` watcher and background-sync settings, subdirectory search, Gemini Embedding 2. Decisions on conflicting behaviour: [upstream-merge-2026-11-04.md](upstream-merge-2026-11-04.md).

### Changed
- A run that stores nothing for the primary model now fails with `EmbeddingError` (including the provider's last error) instead of reporting an empty index as complete.
- `.contextinclude` now also applies to the initial scan, not only to incremental sync.

### Security
- Removed hard-coded Milvus and RabbitMQ credentials from five diagnostic scripts; they now require the credentials from the environment. **The removed passwords remain in git history and must be rotated.**
- Added `scripts/check-secrets.mjs`, run in CI and by an opt-in pre-commit hook ([Credentials and Secret Scanning](security-credentials.md)).

### Documentation
- Environment variable reference for all fork settings; [fork overview](README.md); [credential policy](security-credentials.md); corrected RabbitMQ timeout default (`1700000`) and `MILVUS_STRATEGY` behaviour when unset.

## 0.1.4-lufftw.3 and earlier

See the design notes and bug reports in this directory, starting from the [fork overview](README.md#history).
