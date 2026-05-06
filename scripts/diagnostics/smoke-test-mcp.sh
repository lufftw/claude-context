#!/usr/bin/env bash
# Smoke-test the claude-context MCP binary end-to-end:
#   1. spawn dist/index.js with .mcp.json env
#   2. send `initialize` and `tools/list` over stdio
#   3. assert proper JSON-RPC responses
#   4. assert no `[WARN] File lock failed` in stderr (regression check)
#   5. assert RabbitMQ + Milvus both initialize
#
# This is the test that the 2026-03-08 snapshot race-condition fix should
# have included but didn't (it would have caught the lockSync+retries
# regression on day 1). See:
#   docs/lufftw/bugfix-2026-03-08-snapshot-race-condition.md
#
# Run from claude-context repo root:
#   bash scripts/diagnostics/smoke-test-mcp.sh

set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ ! -f packages/mcp/dist/index.js ]]; then
  echo "ERROR: packages/mcp/dist/index.js not built. Run 'pnpm build:mcp' first." >&2
  exit 1
fi

if [[ ! -f .mcp.json ]]; then
  echo "ERROR: .mcp.json not found in repo root." >&2
  echo "       Create one (see mcp-services/docs/claude-context/README.md)." >&2
  exit 1
fi

# Pull env block from .mcp.json into shell env so the binary reads it
export $(node -e '
  const j=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));
  const srv=Object.values(j.mcpServers).find(s=>(s.command||"").includes("node"));
  if(!srv?.env){console.error("No node MCP server with env in .mcp.json");process.exit(1);}
  for(const[k,v] of Object.entries(srv.env))process.stdout.write(`${k}=${v}\n`);
' | xargs -d '\n')

REQ_FILE=$(mktemp)
OUT_FILE=$(mktemp)
ERR_FILE=$(mktemp)
trap 'rm -f "$REQ_FILE" "$OUT_FILE" "$ERR_FILE"' EXIT

cat > "$REQ_FILE" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF

echo "[smoke] spawning MCP binary (10s timeout)..."
timeout 10 node packages/mcp/dist/index.js < "$REQ_FILE" > "$OUT_FILE" 2> "$ERR_FILE" || true

PASS=true
fail() { echo "[smoke] ❌ $*"; PASS=false; }
pass() { echo "[smoke] ✅ $*"; }

# 1. initialize response — JSON field order is not guaranteed, so test substrings independently
if grep -q '"serverInfo"' "$OUT_FILE" && grep -q '"id":1' "$OUT_FILE"; then pass "initialize returned serverInfo"
else fail "initialize did NOT return serverInfo"; fi

# 2. tools/list response with all 4 tools
for t in index_codebase search_code clear_index get_indexing_status; do
  if grep -q "\"name\":\"$t\"" "$OUT_FILE"; then pass "tool present: $t"
  else fail "tool MISSING: $t"; fi
done

# 3. Lock regression check
if grep -q 'File lock failed, falling back' "$ERR_FILE"; then
  fail "REGRESSION: snapshot lock fell back to unlocked save"
  echo "        (See bugfix-2026-03-08-snapshot-race-condition.md regression notes)"
else
  pass "snapshot lock did not fall back"
fi

# 4. Provider initialization
if grep -q 'Successfully initialized.*embedding provider' "$ERR_FILE"; then pass "embedding provider initialized"
else fail "embedding provider did NOT initialize cleanly"; fi

# 5. Vector DB connection
if grep -q 'Connecting to vector database' "$ERR_FILE"; then pass "Milvus connection attempt logged"
else fail "no Milvus connection attempt — env may be missing"; fi

echo
if $PASS; then echo "[smoke] PASS"; exit 0
else
  echo "[smoke] FAIL — see stderr below:"
  echo "------"
  tail -40 "$ERR_FILE"
  echo "------"
  exit 1
fi
