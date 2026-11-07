# Benchmark: Qwen3-Embedding-0.6B vs 8B on claude-context and mcp-doc-search

Run 2026-11-07 under the protocol frozen on 2026-11-06 ([protocol](benchmark-2026-11-06/protocol.md),
[queries](benchmark-2026-11-06/queries.py)). No query was added, reworded or dropped.

## Verdict

- **8B stays the default on both repositories.** R2 passes on neither.
- **0.6B fails the fallback bar (R1) as written**, because R1 must hold on each repository.
  It passes on mcp-doc-search and fails on claude-context.
- Applies to these two repositories only (R5). No claim is made about `event_shared` or any other collection.

| Repository | MRR(S3) - MRR(S1), 95% CI | hit@10(S3) | R1 fallback | R2 default | Usable queries |
|---|---|---|---|---|---|
| claude-context | -0.004 [-0.148, +0.142] | 0.844 | **Fail** (both conditions) | Fail | 32 |
| mcp-doc-search | +0.143 [-0.001, +0.291] | 0.968 | Pass | Fail (lower bound -0.001, needs > 0) | 31 |

The claude-context point estimate is level. It fails because the interval is wide and its hit@10 is under 0.90, so this is
not evidence that 0.6B is worse there. The sample cannot show that it is safe.

## Systems

S1 is 8B hybrid (dense + BM25, RRF k=100), the product path. S2 is 8B dense. S3 is 0.6B dense, which has no BM25 arm in the
product. Scoring is at distinct-file level over chunk ids present in both models.

## Results

### claude-context (32 queries: 16 direct, 16 paraphrase)

| System | Set | hit@1 | hit@3 | hit@10 | MRR |
|---|---|---|---|---|---|
| S1 8B hybrid | All | 0.344 | 0.688 | 0.844 | 0.538 |
| S2 8B dense | All | 0.438 | 0.719 | 0.812 | 0.586 |
| S3 0.6B dense | All | 0.406 | 0.594 | 0.844 | 0.534 |
| S1 8B hybrid | Direct | 0.375 | 0.938 | 1.000 | 0.665 |
| S2 8B dense | Direct | 0.500 | 0.938 | 1.000 | 0.696 |
| S3 0.6B dense | Direct | 0.562 | 0.812 | 1.000 | 0.699 |
| S1 8B hybrid | Paraphrase | 0.312 | 0.438 | 0.688 | 0.411 |
| S2 8B dense | Paraphrase | 0.375 | 0.500 | 0.625 | 0.475 |
| S3 0.6B dense | Paraphrase | 0.250 | 0.375 | 0.688 | 0.370 |

Paired MRR differences: S3-S1 -0.004 [-0.148, +0.142]; S3-S2 -0.051 [-0.176, +0.069]; S2-S1 +0.048 [-0.059, +0.163].

### mcp-doc-search (31 queries: 15 direct, 16 paraphrase)

| System | Set | hit@1 | hit@3 | hit@10 | MRR |
|---|---|---|---|---|---|
| S1 8B hybrid | All | 0.419 | 0.516 | 0.774 | 0.515 |
| S2 8B dense | All | 0.548 | 0.710 | 0.839 | 0.640 |
| S3 0.6B dense | All | 0.516 | 0.710 | 0.968 | 0.659 |
| S1 8B hybrid | Direct | 0.333 | 0.467 | 0.867 | 0.457 |
| S2 8B dense | Direct | 0.333 | 0.600 | 0.867 | 0.480 |
| S3 0.6B dense | Direct | 0.467 | 0.733 | 0.933 | 0.641 |
| S1 8B hybrid | Paraphrase | 0.500 | 0.562 | 0.688 | 0.570 |
| S2 8B dense | Paraphrase | 0.750 | 0.812 | 0.812 | 0.790 |
| S3 0.6B dense | Paraphrase | 0.562 | 0.688 | 1.000 | 0.676 |

Paired MRR differences: S3-S1 +0.143 [-0.001, +0.291]; S3-S2 +0.019 [-0.109, +0.154]; S2-S1 +0.124 [+0.006, +0.249].

## What BM25 adds (R3, informative)

On these queries BM25 fusion did not help. S1 scored below S2 on MRR on both repositories, and the mcp-doc-search interval
excludes zero. This does not gate a decision, but it is worth a separate study of the fusion before anyone relies on
hybrid being the better path. The spot check below shows that the harness matches the product at top-1 on the first ten
queries, so this is unlikely to be a harness artefact.

## Gate evidence

| Collection | Rows | Distinct ids | Files | Lowest sampled cosine |
|---|---|---|---|---|
| `claude_context_own` | 2,820 | 2,820 | 177 | 0.6738 (see below) |
| `claude_context_own_0p6b` | 2,819 | 2,819 | 177 | 0.9997 |
| `mcp_doc_search_own` | 766 | 766 | 65 | 0.9998 |
| `mcp_doc_search_own_0p6b` | 766 | 766 | 65 | 0.9997 |

- **Id overlap:** 2,819 common on claude-context, 766 on mcp-doc-search; both 1.000 of the smaller set. The one id only in
  8B is a chunk of `packages/chrome-extension/src/content.ts` (2,763 characters) that exceeds the 0.6B worker's 2,048-token
  context.
- **Exception to the cosine gate:** the protocol's bar is 0.97. The 0.6738 row is `evaluation/servers/__init__.py`, an
  empty file with a zero-character chunk. Its stored vector gave the same cosine on six repeats, and other empty
  `__init__.py` chunks sit beside it. A separate sample of 41 non-empty rows had a minimum of 0.9996. The gate was treated
  as met for real content. Strictly read, this one row breached it.

## Product-path spot check

The first ten queries per repository through the real MCP `search_code`, with `embeddingModel` set to each model.

| Repository | 8B top-1 agreement | 0.6B top-1 agreement | Bar |
|---|---|---|---|
| claude-context | 10/10 | 10/10 | Pass (8/10) |
| mcp-doc-search | 10/10 | 10/10 | Pass (8/10) |

The first attempt scored 0/10 on 0.6B for both repositories, returning `secondary-coverage-below-threshold`. The rebuild
had not persisted `coverageByModel`, which only `packages/mcp/scripts/persist-0p6b-coverage.mjs` writes. After writing the
measured ratios (0.999645 and 1.0) the check passed. The harness scores were not affected.

## Deviations from the protocol

- The query set is `queries.py`, not the `benchmark_queries.json` the protocol names. Content is unchanged.
- A gold path typo (`upstream-merge-2026-11.md`, corrected to `-04.md`) was fixed before the first scored run.
- The cosine gate exception above.
- The last 65 ids that differed between the two claude-context collections were aligned by copying those chunks across
  models (same id and content, embedded by the target model), because a full 8B pass was too slow.

## Limits

Small corpora, authored queries, one worker version of each model, and no BM25 arm for 0.6B in the product. The intervals
are wide, so differences smaller than about 0.15 MRR are not resolved by this benchmark.

## Open defects found

- `index_codebase` does not persist `coverageByModel`, so a dual-model rebuild leaves 0.6B unsearchable until the script is
  run by hand.
- Empty files are indexed as zero-character chunks.
