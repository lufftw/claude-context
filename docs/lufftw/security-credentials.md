# Credentials and Secret Scanning

## Rule

Credentials are read from the environment only: the MCP client's `env` block, the OS environment, `~/.context/.env`, or a project `.env` that is git-ignored. Code and scripts must not contain a literal credential, including as a fallback such as `process.env.MILVUS_TOKEN || 'root:<password>'`; a missing value must fail with a clear error.

Credentials used by this repository:

| Variable | Used by |
|---|---|
| `MILVUS_TOKEN` | MCP server; `backfill-0p6b.mjs`, `distinct-pk-probe.mjs`, `verify-mappings.cjs` |
| `RABBITMQ_INFERENCE_URL` (contains the AMQP password) | MCP server with `EMBEDDING_PROVIDER=RabbitMQ`; `backfill-0p6b.mjs`, `worker-health-0p6b.test.mjs` |
| `RABBITMQ_MGMT_USER`, `RABBITMQ_MGMT_PASS` | `scripts/diagnostics/reindex-tier.sh` (RabbitMQ management API) |
| `OPENAI_API_KEY`, `VOYAGEAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | MCP server, depending on `EMBEDDING_PROVIDER` |

Files that hold credentials and are git-ignored: `.env`, `.env.*` (except `.env.example`), `.mcp.json`, key files (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`) and root scratch scripts `tmp-*.{js,mjs,ts}`.

## Secret Scanner

`scripts/check-secrets.mjs` has no dependencies. It reports:

- URLs with an inline password (`amqp://`, `http(s)://`, database URLs)
- Milvus `root:` / `admin:` tokens and `user:password` strings piped to `base64`
- Literal fallbacks for variables named `*TOKEN`, `*API_KEY`, `*PASSWORD`, `*PASS`, `*SECRET`
- OpenAI, Voyage, Google, GitHub, AWS and Slack key formats, and private key blocks

Placeholders (`your-…`, `<…>`, `xxx`, `dummy`, `test`, `smoke`, …) are allowed. Matches are masked in the output. A line can be exempted with a trailing `secret-scan: allow` comment; reviewers should question every use.

```bash
pnpm check:secrets                       # all tracked files (also runs in CI)
node scripts/check-secrets.mjs --staged  # staged changes only
```

### Pre-commit hook

Enable once per clone so a commit containing a secret is refused:

```bash
git config core.hooksPath .githooks
```

## If a Secret Was Committed

1. **Rotate it first.** Once pushed, it is in git history and possibly in forks, clones and caches; removing it in a new commit does not undo that.
2. Replace the literal with an environment variable that is required (no fallback) and commit.
3. Update the new value wherever it is configured (MCP `env` blocks, `~/.context/.env`, project `.env` files, CI secrets).
4. Optionally rewrite history (e.g. `git filter-repo`). This changes every later commit ID and needs a force-push and re-clones, so it does not replace rotation.

### Incident 2026-10

The Milvus `root` password and the RabbitMQ `crawler` password were committed as literal fallbacks in five diagnostic scripts (first in `2586462`). They were removed in `9782c1e` and the scanner was added in PR #5. Both passwords remain in history and must be rotated.
