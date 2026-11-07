# Benchmark protocol: Qwen3-Embedding-0.6B vs 8B on claude-context and mcp-doc-search

Committed before the formal run (2026-11-06, written while the rebuild was still in progress; no results had been read from
the rebuilt collections). The query set and the pass bar below are frozen by this file. If a query turns out to be
defective (gold file does not exist in the repository at the indexed commit), it is removed for ALL systems and
listed in the report; no query is added or reworded after the first scored run.

## Question

Is `qwen3-embedding-0.6b` (1024-dim, dense only) good enough to serve as (a) the fallback model when the 8B worker is busy
and (b) a default for these two repositories, compared with the product path `qwen3-embedding-8b` hybrid
(dense + BM25, RRF)?

## Corpus and systems

- Corpus: the rebuilt collections `claude_context_own`, `claude_context_own_0p6b`, `mcp_doc_search_own`,
  `mcp_doc_search_own_0p6b`, restricted to chunk ids present in both models of the same repository (identical candidate set).
- Gate before scoring: row count equals distinct ids for every collection, 8B and 0.6B chunk-id sets agree (at least 0.99
  overlap), integrity probe cosine at least 0.97 on sampled chunks of at most 2048 tokens.
- Systems: S1 = 8B hybrid (product path), S2 = 8B dense only, S3 = 0.6B dense only.

## Queries (frozen)

`benchmark_queries.json` in this directory: per repository, direct-wording (D) and paraphrase (P) queries written from the
purpose of each file, not copied from chunk text; gold = acceptable source files (distinct-file level). Target size: at
least 30 per repository, at least one third paraphrase. Queries are English, matching the projects' docs.

## Metrics

Per system and repository: hit@1, hit@3, hit@10, MRR at distinct-file level (a query with no gold file ranked is a miss).
Report overall, D and P separately. Paired comparison: per-query reciprocal-rank difference with a 10,000-resample paired
bootstrap 95% confidence interval (seed 20261106).

## Pass bar (decision rules, fixed in advance)

R1. **0.6B acceptable as fallback**: on each repository, MRR(S3) - MRR(S1) has a 95% CI lower bound of at least -0.10, and
hit@10(S3) is at least 0.90.
R2. **0.6B may become the default for a repository**: R1 holds AND the lower CI bound of MRR(S3) - MRR(S1) is above 0
on that repository. Otherwise 8B stays the default.
R3. **8B dense vs 8B hybrid** is reported to show what BM25 adds; it does not gate a decision.
R4. A repository with fewer than 25 usable queries gets no R2 decision (R1 only, flagged as underpowered).
R5. The result applies to these two repositories only. No claim is made about `event_shared` or any other collection.

## Product-path spot check

Ten queries per repository (the first ten of the frozen set) are sent through the real MCP `search_code` with
`embeddingModel` set to each model. The top-1 file must agree with the harness result for the matching system on at least 8
of 10; disagreements are listed with both top-3 lists.

## Reporting

Written to `claude-context/docs/lufftw/benchmark-2026-11-06-embedding-0p6b-vs-8b.md` with: gate evidence, per-system
tables, bootstrap intervals, R1-R5 verdicts, the dropped queries, and the limits (small corpus, authored queries, one
embedding worker version, 0.6B has no BM25 arm in the product).
