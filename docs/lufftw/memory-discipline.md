# Memory Discipline — session memory in this repository

> **Canonical source:** the estate memory architecture at
> `E:\Developer\lufftw\repo\claude-memory-index` — template
> `docs/reference/memory-discipline-template.md`, sync manifest
> `docs/reference/estate-discipline-manifest.md`. This page localizes the discipline
> for sessions working in claude-context; architecture questions are answered in the
> canonical repo. If the architecture changes, the manifest is the checklist that
> updates every copy; if this copy changes, it points home. Keep the two in sync.

Every Claude Code session in this repository has a persistent memory scope at
`C:\Users\luff\.claude\projects\E--Developer-lufftw-repo-claude-context\memory\`. Its root index (`MEMORY.md`)
is auto-loaded at session start. The scope is part of a version-controlled, estate-wide
tiered architecture (live since 2026-07-16); this page is what a session here must know.

## The one duty

Write the memory as a single file in the scope directory with frontmatter — that is the
entire duty; indexing is automatic:

```markdown
---
name: <short-kebab-slug>
description: <one line — the routing text the indices derive from>
metadata:
  type: user | feedback | project | reference
---

<the fact; link related memories with [[name]]>
```

A PostToolUse hook captures the write, re-syncs the scope, and confirms in-context.
For an immediate index refresh without waiting for the hook or the next sync, run
`python E:\Developer\lufftw\repo\claude-memory-index\tools\sync.py --scope E--Developer-lufftw-repo-claude-context`
(optional). A `[[link]]` to a not-yet-written memory is a valid marker of future work,
not an error.

## Generated caches — never hand-edit

`MEMORY.md` and everything under `index/` are **generated**. Never append to, edit, or
"fix" them; regeneration overwrites hand edits without notice. A memory written the
naive way (file only, no index touch) lands in the visible `unsorted` inbox at the next
sync — never in the void.

## The tier model, in one paragraph

The root `MEMORY.md` is kept within the session-start loader budget and routes by
domain: root → cluster router (`index/<cluster>.md`) → the memory file, which is the
sole truth. Small scopes render flat (all entries inline in the root). Above the
per-scope tiers sits the estate tier — cross-scope indices at
`E:\Developer\lufftw\repo\claude-memory-index\generated\estate\index\` with absolute
paths into every scope's live memory directory — so knowledge is reachable across
repositories, not only within one.

## How this repository routes

This is a fork with a small scope. Most related knowledge — the embedding fleet, Milvus, the shared claude-context MCP invariants — lives in the `event-crawler` hub and `event-search-service` scopes; route via the estate tier.

## Lifecycle — mark, never delete

A memory that turns out wrong is **marked, never deleted**: set
`metadata.status: superseded` with `superseded_by: <name>`, `status_reason`, and
`status_date` — or `status: deprecated` when there is no successor. Deleting memory
files is never correct.
