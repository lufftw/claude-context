# Credential Handling and Secret-Leak Prevention

This page defines how credentials are supplied to Claude Context in this fork, the controls that keep
them out of git, and the procedure to follow when a credential has been committed.

## Scope

The credentials in scope are everything that grants access to a service:

| Credential | Typical variable |
|---|---|
| Milvus / Zilliz Cloud token (`user:password` or API key) | `MILVUS_TOKEN` |
| RabbitMQ inference broker URL (contains user and password) | `RABBITMQ_INFERENCE_URL` |
| Embedding provider API keys | `OPENAI_API_KEY`, `VOYAGEAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` |
| Any HTTP Basic-auth pair, private key, or cloud access key | — |

Connection *addresses* (`MILVUS_ADDRESS`, `OLLAMA_HOST`, base URLs) are configuration, not secrets, but
they must not embed credentials (`https://user:pass@host` is a secret).

## Policy

1. **Credentials come from the environment only.** Valid sources, in resolution order, are:
   1. the project `.env` of the codebase being indexed (git-ignored; see
      [Project-scoped `.env` loading](../lufftw/project-env-loading.md));
   2. `process.env` — the MCP client's `env` block or the OS environment;
   3. `~/.context/.env` (user-global fallback, outside any repository).
2. **No literal fallbacks.** Code and scripts must not contain a credential, including as a default:

   ```js
   // Forbidden: the literal ships with the repository.
   const token = process.env.MILVUS_TOKEN || 'root:<real-password>'; // secret-scan: allow (example)

   // Required: fail fast with an actionable message.
   const token = process.env.MILVUS_TOKEN;
   if (!token) throw new Error('MILVUS_TOKEN is not set (see docs/security/credential-handling.md)');
   ```

3. **Placeholders are explicit.** Documentation and examples use values the scanner recognises as
   placeholders: `your-openai-api-key`, `<password>`, `sk-xxx`, `${MILVUS_TOKEN}`.
4. **Logs never print secret values.** Diagnostics report presence and length only
   (`OPENAI_API_KEY: SET (length: 51)`), as `packages/mcp/src/config.ts` already does.
5. **Ad-hoc scripts stay outside git until sanitised.** Root-level `tmp-*.mjs|js|ts` files are
   git-ignored for this reason; promote them to `scripts/` only after removing credentials.

## Files that must never be committed

`.gitignore` already excludes the following. Do not force-add them (`git add -f`).

| Pattern | Why |
|---|---|
| `.env`, `.env.*` (except `.env.example`) | Local credentials |
| `.mcp.json` | Project-scope MCP config that usually carries `MILVUS_TOKEN` and the RabbitMQ URL |
| `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` | Keys and certificates |
| `/backups/`, `/tmp-*.{mjs,js,ts}` | Operational scratch data that often contains live connection strings |

Use `.env.example` for documenting variables; it must contain placeholders only.

## Automated controls

`scripts/check-secrets.mjs` is a dependency-free scanner. It recognises inline URL passwords, Milvus
`user:password` tokens, Basic-auth pairs piped to `base64`, credential variables with literal
fallbacks, and the key formats of OpenAI, Voyage, Google, GitHub, AWS and Slack, plus private-key
blocks. Matches are masked in the output, so the report cannot itself leak a value.

| Mode | Command | Where it runs |
|---|---|---|
| Tracked files | `pnpm check:secrets` | CI (`.github/workflows/ci.yml`, Ubuntu job), before install |
| Staged files | `node scripts/check-secrets.mjs --staged` | Pre-commit hook |
| Full history | `pnpm check:secrets:history` | Manually, and after any history purge |

Enable the pre-commit hook once per clone:

```bash
git config core.hooksPath .githooks
```

A line that is a deliberate false positive may end with a `secret-scan: allow` comment. Such
exemptions require review; never use one to admit a real credential.

The history mode scans every blob reachable from any local ref, including fetched `upstream/*`
branches. Findings are reported as `path@blob-sha:line`.

## Incident response: a credential was committed

Removing the value in a new commit does **not** remove it from git history, from forks, or from
clones. Treat any pushed credential as compromised.

1. **Rotate first.** Change the password or revoke the key at the service (Milvus/Zilliz user,
   RabbitMQ user, provider console). This is the only step that closes the exposure.
2. **Update every consumer** with the new value through the environment (MCP `env` blocks, project
   `.env` files, `~/.context/.env`, CI secrets).
3. **Remove the literal from the tree** and replace it with an environment read that fails fast.
4. **Audit history:** `pnpm check:secrets:history`.
5. **Optionally purge history.** Only after rotation, and only with the repository owner's agreement,
   because it rewrites every descendant commit and invalidates existing clones and open pull requests:

   ```bash
   # In a fresh mirror clone; requires git-filter-repo.
   git clone --mirror https://github.com/lufftw/claude-context.git cc-purge.git
   cd cc-purge.git
   printf '%s\n' 'literal:<old-secret-1>==>REDACTED' 'literal:<old-secret-2>==>REDACTED' > ../replacements.txt
   git filter-repo --replace-text ../replacements.txt
   git push --force --mirror
   ```

   Afterwards, every collaborator must re-clone, and GitHub may still serve the old objects through
   cached views or forks until GitHub Support purges them. A purge reduces exposure; it is not a
   substitute for rotation.
6. **Record the incident** (date, credential type, affected commits, rotation time) in
   `docs/lufftw/` without reproducing the secret.

## Known historical exposure

`pnpm check:secrets:history` reports a Milvus `root` token and a RabbitMQ inference-broker password
in diagnostic scripts committed between 2026-05-06 and 2026-06-14 (commits `2586462`, `ca5d881`,
`36a65bd`). Both were removed from the tree on 2026-10-12 (`716e194`), but they remain in history.
Unless they have already been changed, **rotate both credentials** and then decide whether to
purge history as described above.

**Status (2026-11-04):** rotation and history purge are deferred by the repository owner. The same
two credentials were also present in `lufftw/mcp-doc-search` (removed from its tree in `4a75235`).
Until they are rotated, treat the Milvus `root` user and the RabbitMQ `crawler` user as known to
anyone with read access to either repository's history. Keep both services off untrusted networks,
and give new consumers dedicated least-privilege users. One further match, in a since-deleted
`docs/lufftw/security-credentials.md`, is a documentation example of the forbidden pattern, not a
credential.

## Review checklist

- [ ] No new `process.env.X || '<literal>'` for any credential variable.
- [ ] New variables are documented in `.env.example` with a placeholder.
- [ ] Logs print presence/length only.
- [ ] `pnpm check:secrets` passes locally.
- [ ] No `.env*`, `.mcp.json`, key or backup file is staged.
