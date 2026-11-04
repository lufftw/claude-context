# Open-Source Landscape and Adoption Decisions (November 2026)

**Reviewed:** 2026-11-04 for `0.1.15-lufftw.2`. This record compares the fork's stack with popular,
actively maintained open-source alternatives and complements, and decides what to adopt. The
review ran in three rounds:

1. **Research:** three experts covered retrieval, ingestion, and platform and quality.
2. **Cross-review:** three reviewers covered architecture, security and supply chain, and value,
   and re-verified claims by running the code.
3. **Decision:** a chair resolved disagreements and set the implementation plan and checklist.

The sibling mcp-doc-search keeps the detailed landscape tables for retrieval, chunking and
document conversion, in `docs/maintenance/oss-landscape-2026-11.md` in `lufftw/mcp-doc-search`.
This page records the fork-specific decisions.

**Fork constraint:** every change must keep upstream merges cheap
([upstream sync](upstream-sync.md)). New fork-owned files are preferred, and edits to
upstream-owned code or configuration require a stated reason.

## Adopted

| Item | Problem | Evidence | Verification |
|---|---|---|---|
| `.github/workflows/fork-tests.yml` (new file) | The upstream `ci.yml` only builds; ~190 fork tests never ran in CI | `ci.yml` has no test step and `pnpm lint` is commented out. The workflow also never triggered on `claude/**` branches | Locally: core unit 30 suites / 164 tests; integration 9 suites (8 passed, 1 skipped) / 17 tests passed, 2 skipped; mcp 6/6. CI: Ubuntu 24.04 and Windows Server 2025, Node 22 |

The workflow runs the secret scanner, the core unit tests, the hermetic core integration tests
(`*.int.test.ts`, in-memory fakes, no services) and the mcp `node:test` suite. Its permissions
are read-only and its actions are pinned to commit SHAs. On a pull request from a `claude/**` branch it runs twice, once for the push and once for the PR. This is intentional: the push run gives early feedback before a PR exists. It calls Jest directly under bash,
because the single-quoted patterns in the npm scripts are passed literally by `cmd.exe` on
Windows.

## Decisions

| Candidate | Decision | Reason |
|---|---|---|
| Dependabot **version** updates for npm | **REJECT** | Version PRs rewrite upstream-owned `package.json` and `pnpm-lock.yaml`, so every upstream merge would conflict |
| Dependabot `github-actions` ecosystem | **REJECT** | It would rewrite the upstream-owned `ci.yml` and `release.yml`. The fork-owned workflow is SHA-pinned by hand |
| Dependabot **security** updates | TRIAL (owner toggle) | Enable in repository settings → Code security. They are rare and targeted, so the merge cost is acceptable |
| Re-enable `pnpm lint` in upstream `ci.yml` | HOLD | Edits an upstream-owned file. Propose upstream instead |
| Hybrid RRF tuning (`HYBRID_RRF_K`, candidate multiplier) | HOLD | A fork knob would be a **no-op**; see the upstream bug below |
| MCP tool `annotations` (`readOnlyHint` for `search_code` / `get_indexing_status`) | TRIAL (upstream PR first) | Additive and cheap with TS SDK 1.32, but touches `packages/mcp/src/index.ts`. Upstream first; cherry-pick if stalled for 30 days |
| MCP TS SDK v2 (MCP 2026-07-28) | Deferred | See [dependency policy](dependency-policy.md#sdk-v2-migration-plan-when-triggered) |
| chonkie `CodeChunker` / tree-sitter-language-pack | REJECT | Would replace the upstream AST splitter (constraint: keep upstream merges cheap) |
| gitleaks v8.30.1 (MIT) | TRIAL (one-off) | Manual history scan with a checksum-pinned binary and `fetch-depth: 0`. The in-repo scanner already has `--history`, and gitleaks has had no release since 2026-02 |
| trufflehog | REJECT | AGPL-3.0 |
| osv-scanner v2.7.0, CodeQL, OpenSSF Scorecard | ASSESS | No defect cited; overlaps with Dependabot security alerts. Revisit if the repository goes public |
| MCP Inspector contract test | HOLD | The mcp test suite and the stdio diagnostics script already cover the tool list |

## Upstream bug reports to file

These are upstream defects. The fork does not patch them locally, because the fix belongs
upstream and a local patch would conflict on every sync.

1. **The hybrid-search `rerank` option is ignored.** `context.ts:1101-1104` passes
   `rerank: { strategy: 'rrf', params: { k: 100 } }`. Both adapters build their own strategy with
   a hard-coded `k: 100` (`milvus-vectordb.ts:783-787`, `milvus-restful-vectordb.ts:865-868`) and
   never read `options.rerank`. Each leg also requests only `topK`, so there is no larger
   candidate pool. Behaviour today is consistent (k = 100 everywhere), so this is not urgent,
   but no ranking parameter can be tuned until the adapters honour the option.
2. **Scala AST splitting probably never applies.** `SPLITTABLE_NODE_TYPES.scala` lists Java node
   names (`method_declaration`, `class_declaration`, …), but tree-sitter-scala produces
   `function_definition`, `class_definition`, `object_definition` and `trait_definition`. Scala
   files therefore likely fall back to the LangChain splitter. *Unverified:* confirm with a probe
   before filing.
3. **Tool annotations** (see the decisions above).

## Operational note

`.github/workflows/release.yml` (upstream-owned) publishes `@zilliz/*` packages on any `v*` or `c*`
tag. Do not push such tags from the fork, and confirm that `NPM_TOKEN` is **not** set as a
repository secret ([upstream sync](upstream-sync.md#release-caution)).

## Acceptance checklist

- [x] `pnpm install --frozen-lockfile && pnpm build` succeeds.
- [x] Core unit tests pass locally: 30 suites, 164 tests.
- [x] Core integration tests pass locally: 9 suites (8 passed, 1 skipped); 17 tests passed, 2 skipped.
- [x] mcp `node:test` passes 6/6.
- [x] The PR changes only `.github/workflows/fork-tests.yml` and `docs/**`. No upstream-owned code or configuration changes.
- [x] `node scripts/check-secrets.mjs` is clean; every relative documentation link resolves.
- [x] `permissions: contents: read`; all 3 `uses:` entries are SHA-pinned.
- [x] `Fork tests` is green on `ubuntu-24.04` and `windows-2025`, and the existing `ci.yml` matrix is still green on the PR.
- [x] Independent code review completed; its claude-context NITs (suite count, duplicate runs) are addressed.
