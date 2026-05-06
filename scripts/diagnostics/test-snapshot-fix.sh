#!/usr/bin/env bash
# End-to-end test for the v0.1.4-lufftw.3 snapshot fix:
#   - inject a synthetic ghost path into the shared snapshot
#   - spawn a fresh MCP process
#   - confirm the MCP detects the ghost on load AND purges it on first save
#
# This test is what the original 2026-03-08 fix should have included. The
# absence of a multi-process test let two regressions ship undetected:
#   1. lockSync+retries threw ESYNC on every call (silent unlocked fallback)
#   2. loadV2Format did not enroll missing paths in removedCodebases
#      (silently re-emitted ghosts on every save)
#
# See docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md.
#
# Run from claude-context repo root:
#   bash scripts/diagnostics/test-snapshot-fix.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

# Resolve snapshot file path with forward slashes (avoids backslash mangling
# when interpolated into shell-invoked node -e scripts on Windows / Git Bash).
SNAP_FILE=$(node -e '
  const path=require("path"),os=require("os");
  const home=process.env.CLAUDE_CONTEXT_HOME||path.join(os.homedir(),".context");
  process.stdout.write(path.join(home,"mcp-codebase-snapshot.json").replace(/\\/g,"/"));
')

if [[ ! -f "$SNAP_FILE" ]]; then
  echo "ERROR: snapshot file not found at $SNAP_FILE" >&2
  echo "       Run a real index_codebase first to create it." >&2
  exit 1
fi

GHOST_PATH='E:/__synthetic_ghost__/should-be-purged'
echo "[test] snapshot: $SNAP_FILE"
echo "[test] injecting synthetic ghost: $GHOST_PATH"

# Pass paths via argv (process.argv[2] / [3]) to avoid backslash escaping issues.
node -e '
  const fs=require("fs");
  const [snap,ghost]=process.argv.slice(1);
  const j=JSON.parse(fs.readFileSync(snap,"utf8"));
  j.codebases[ghost]={
    status:"indexed", indexedFiles:99, totalChunks:42,
    indexStatus:"completed", lastUpdated:new Date().toISOString()
  };
  fs.writeFileSync(snap, JSON.stringify(j,null,2));
  console.log("  before:", Object.keys(j.codebases).length, "entries (ghost present)");
' "$SNAP_FILE" "$GHOST_PATH"

# Spawn a fresh MCP process — env block must come from .mcp.json
export $(node -e '
  const j=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));
  const srv=Object.values(j.mcpServers).find(s=>(s.command||"").includes("node"));
  for(const[k,v] of Object.entries(srv.env))process.stdout.write(`${k}=${v}\n`);
' | xargs -d '\n')

REQ=$(mktemp); ERR=$(mktemp); trap 'rm -f "$REQ" "$ERR"' EXIT
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ghost-test","version":"1.0"}}}' > "$REQ"

echo "[test] spawning fresh MCP (8s timeout)..."
timeout 8 node packages/mcp/dist/index.js < "$REQ" > /dev/null 2> "$ERR" || true

# Assert the load step warned about the ghost
if grep -q "Codebase no longer exists, removing.*synthetic_ghost" "$ERR"; then
  echo "[test] ✅ MCP detected the ghost on load"
else
  echo "[test] ❌ MCP did not warn about the ghost"
  cat "$ERR" | tail -20
  exit 1
fi

# Assert lock acquired (regression check)
if grep -q 'File lock acquired' "$ERR"; then
  echo "[test] ✅ snapshot lock acquired"
elif grep -q 'File lock failed, falling back' "$ERR"; then
  echo "[test] ❌ REGRESSION: lock fell back to unlocked save"
  exit 1
fi

# Assert ghost is gone from disk after save
GHOST_PRESENT=$(node -e '
  const [snap,ghost]=process.argv.slice(1);
  const j=JSON.parse(require("fs").readFileSync(snap,"utf8"));
  process.stdout.write(j.codebases[ghost]?"YES":"NO");
' "$SNAP_FILE" "$GHOST_PATH")

if [[ "$GHOST_PRESENT" == 'NO' ]]; then
  echo "[test] ✅ ghost purged from disk by next save"
  echo "[test] PASS"
else
  echo "[test] ❌ ghost still on disk after save (loadV2Format -> removedCodebases bug?)"
  exit 1
fi
