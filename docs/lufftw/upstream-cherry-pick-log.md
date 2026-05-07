# Upstream Cherry-Pick Log — Phase B (2026-05-06 / executed 2026-05-07)

> One row per attempted commit (applied / deferred / skip-cascade / aborted). ALREADY-IN-HISTORY entries are excluded since they are never attempted. Final row count must equal manifest's commit-attempt total at the Plan Completion Audit.

## Columns

- **SHA** — short SHA from manifest.
- **Subject** — one-line commit subject.
- **Conflicts** — `none` or list of conflicted files.
- **Survival-output** — `OK` or first-failing P7 marker.
- **tools/list-diff** — categorical diff vs prior row (`none | +<name> | -<name> | +<a>,-<b>`).
- **Lockfile-diff-summary** — `{none, workspace-link, dep-resolution, registry-url, peer-dep, sub-dep}` per P14 classification rule.
- **Smoke results** — `jsonrpc/snap/fregr OK` or first-failing scope.
- **Notes** — synthesis-resolution decisions, version stamps, anomalies.

| SHA | Subject | Conflicts | Survival-output | tools/list-diff | Lockfile-diff-summary | Smoke results | Notes |
|-----|---------|-----------|-----------------|-----------------|------------------------|---------------|-------|
| `1ebda84` | fix: parse default dimension from model metadata (#307) | none | OK | none (initial) | none | jsonrpc/snap/fregr OK | 1af71ea |
| `0bfff25` | feat: voyage-4 model series (#306) | none | OK | none | none | jsonrpc/snap/fregr OK | a67900f |
| `c912741` | fix: voyage-4-nano default dim 1024 | none | OK | none | none | jsonrpc/snap/fregr OK | 987f6cf |
| `a99939e` | fix(mcp): Ollama host fallback (#339) | none | OK | none | none | jsonrpc/snap/fregr OK | d2e1a0d |
| `2474e6f` | fix(core): malformed metadata in search results (#323) | none | OK | none | none | jsonrpc/snap/fregr OK | 564c17e |
| `f3f22b0` | fix: malformed metadata in gRPC hybridSearch | none | OK | none | none | jsonrpc/snap/fregr OK | eeb6d3f |
| `cdbd75b` | fix(core): tolerate gRPC timeout in checkCollectionLimit (#319) | milvus-vectordb.ts (--theirs; required deleteByFilter restoration in follow-up commit 23d6da3) | OK | none | none | jsonrpc/snap/fregr OK | 4785242 |
| `c0cc3cc` | fix: unreachable modified detection (#294) | none | OK | none | none | jsonrpc/snap/fregr OK | 8cecb6c |
| `cdad7ab` | feat(core): Solidity language (substituted from merge `0f7a82e`) | context.ts (--ours + manual .dart/.sol additions); context.splitter.test.ts (--ours, file deleted) | OK (all fork markers preserved) | none | none | jsonrpc/snap/fregr OK | 517596d |
| (fix) | restore deleteByFilter in MilvusVectorDatabase (lost during cdbd75b --theirs) | none | OK | none | none | jsonrpc/snap/fregr OK | 23d6da3 |
