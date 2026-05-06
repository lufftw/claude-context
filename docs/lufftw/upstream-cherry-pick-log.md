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
