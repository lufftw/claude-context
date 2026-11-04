# Platform Support

## Supported Platforms

| Component | Supported |
|---|---|
| Operating system | **Windows 11** (x64, 23H2 or later) and **Ubuntu 24.04 LTS** (x64). macOS and other Linux distributions are expected to work but are not part of the test matrix. |
| Node.js | 20.x, 22.x, 24.x (`>= 20.0.0`) |
| pnpm (development only) | 10.x |
| Vector database | Milvus 2.5 or later (self-hosted), or Zilliz Cloud |
| RabbitMQ (only with `EMBEDDING_PROVIDER=RabbitMQ`) | 3.13 or later |

## How Each Platform Is Verified

Every push to `main` and every pull request runs the CI workflow (`.github/workflows/ci.yml`):

| Check | Ubuntu 24.04 | Windows (Server 2025) |
|---|---|---|
| Install from lockfile and build all packages (Node 20, 22, 24) | ✓ | ✓ |
| Secret scan | ✓ | ✓ |
| Core unit tests (Jest) | ✓ | ✓ |
| MCP unit tests (`node:test`) | ✓ | ✓ |
| MCP offline integration checks (snapshot ledger, config, search routing, cross-process sync lock) | ✓ | ✓ |
| MCP server stdio smoke: starts `dist/index.js`, checks `initialize` and `tools/list` and that stdout carries only JSON-RPC | ✓ | ✓ |
| Core integration tests against a live Milvus 2.5 (`MILVUS_LIVE=1`) | ✓ | Manual |
| Live end-to-end against Milvus 2.5 and RabbitMQ 3.13 (`e2e-live.mjs`, both embedding modes) | ✓ | Manual, see below |

GitHub does not offer Windows 11 runners. The Windows jobs use `windows-2025` (Windows Server 2025), which is built from the same 24H2 code base as Windows 11 24H2 and has the same file system, path and process semantics. The live end-to-end test cannot run on GitHub's Windows runners because they cannot run the Linux Milvus container; run it on a Windows 11 machine as described in [Verify an Installation](#verify-an-installation).

## Windows 11

### Install

```powershell
winget install OpenJS.NodeJS.LTS
```

For development, enable pnpm through Corepack (included with Node.js):

```powershell
corepack enable
```

### Register the MCP server

On native Windows (not WSL), MCP servers started with `npx` must be wrapped in `cmd /c`:

```powershell
claude mcp add claude-context -e OPENAI_API_KEY=sk-your-key -e MILVUS_ADDRESS=your-endpoint -e MILVUS_TOKEN=your-token -- cmd /c npx @zilliz/claude-context-mcp@latest
```

In JSON-based clients:

```json
{
  "mcpServers": {
    "claude-context": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@zilliz/claude-context-mcp@latest"],
      "env": { "MILVUS_ADDRESS": "your-endpoint", "MILVUS_TOKEN": "your-token" }
    }
  }
}
```

In JSON, write Windows paths with forward slashes (`C:/repos/app`) or escaped backslashes (`C:\\repos\\app`).

### Files and paths

- The state directory is `%USERPROFILE%\.context` (global `.env`, snapshot, Merkle trees, `.sync-trigger`). Set `CLAUDE_CONTEXT_HOME` in the MCP client's `env` block, or with `setx CLAUDE_CONTEXT_HOME D:\shared\context`, to move the snapshot.
- Save `.env`, `.gitignore`, `.contextignore` and `.contextinclude` as UTF-8. CRLF line endings and a UTF-8 byte-order mark are handled. **UTF-16 files are not**: Windows PowerShell 5.1's `>` and `Out-File` write UTF-16, so use PowerShell 7, or `Set-Content -Encoding utf8`:
  ```powershell
  Set-Content -Path .env -Encoding utf8 -Value "MILVUS_COLLECTION_PRIVATE=my_project_own"
  ```
- Values in `.env` files are taken literally; do not wrap them in quotes.
- Pass a codebase path with the same spelling and drive-letter case each time. Windows paths are case-insensitive, but the index snapshot matches them exactly, so `C:\Repo` and `c:\repo` are tracked as two codebases.
- The repository enforces LF line endings through `.gitattributes`, so `core.autocrlf` settings do not affect it.

### Trigger an immediate re-index

The server watches `%USERPROFILE%\.context\.sync-trigger`. Touch it from PowerShell (also usable as a Claude Code hook command):

```powershell
powershell -NoProfile -Command "New-Item -ItemType File -Force \"$env:USERPROFILE\.context\.sync-trigger\" | Out-Null"
```

### Local Milvus

Use Zilliz Cloud, or run Milvus standalone in Docker Desktop with the WSL 2 back end, following [Run Milvus in Docker (Windows)](https://milvus.io/docs/install_standalone-windows.md). Milvus is then reachable at `127.0.0.1:19530`.

## Ubuntu 24.04 LTS

### Install

Install Node.js 22 from NodeSource (or use `nvm`):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
```
```bash
sudo apt-get install -y nodejs
```

Native modules (tree-sitter, faiss-node) ship prebuilt binaries for Linux x64. If a prebuilt binary is unavailable, install a toolchain and reinstall:

```bash
sudo apt-get install -y build-essential python3
```

### Register the MCP server

```bash
claude mcp add claude-context -e OPENAI_API_KEY=sk-your-key -e MILVUS_ADDRESS=your-endpoint -e MILVUS_TOKEN=your-token -- npx @zilliz/claude-context-mcp@latest
```

### Local Milvus

With Docker Engine installed, follow [Run Milvus in Docker (Linux)](https://milvus.io/docs/install_standalone-docker.md):

```bash
curl -sfL https://raw.githubusercontent.com/milvus-io/milvus/master/scripts/standalone_embed.sh -o standalone_embed.sh
```
```bash
bash standalone_embed.sh start
```

## Verify an Installation

From a clone of this repository, build and run the test suites, then the live end-to-end test against your Milvus. The end-to-end test needs no API key: it serves embeddings from an in-process stub, works in a temporary directory and drops its collection when done. See the [Testing Guide](../dive-deep/testing.md) for details.

Ubuntu:

```bash
pnpm install --frozen-lockfile && pnpm build
```
```bash
pnpm --filter @zilliz/claude-context-core test && pnpm --filter @zilliz/claude-context-mcp test
```
```bash
MILVUS_ADDRESS=127.0.0.1:19530 node packages/mcp/scripts/e2e-live.mjs
```

Windows 11 (PowerShell):

```powershell
pnpm install --frozen-lockfile; pnpm build
```
```powershell
pnpm --filter @zilliz/claude-context-core test; pnpm --filter @zilliz/claude-context-mcp test
```
```powershell
$env:MILVUS_ADDRESS = "127.0.0.1:19530"; node packages/mcp/scripts/e2e-live.mjs
```

To also exercise the RabbitMQ provider, set `RABBITMQ_INFERENCE_URL` to a broker you can reach (for a local test broker, `amqp://guest:guest@127.0.0.1:5672`) before the last command. A successful run ends with `e2e-live: PASS`.
