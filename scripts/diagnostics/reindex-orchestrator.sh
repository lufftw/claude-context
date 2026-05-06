#!/usr/bin/env bash
# Re-index orchestrator for the lufftw fork. Drives index_codebase calls
# sequentially against a fresh MCP instance, leaving idle time between repos
# so the shared RabbitMQ qwen3-embedding-8b worker queue stays drained and
# event-search-service realtime traffic (priority 10) is not delayed.
#
# Each repo is indexed via a fresh MCP child process (stdio + JSON-RPC) so
# that:
#   - one bug or stuck index does not poison the whole batch
#   - we can tail the per-run log for diagnosis afterward
#   - the existing 7 long-running MCP processes are not touched
#
# Usage:
#   bash scripts/diagnostics/reindex-orchestrator.sh tier1
#   bash scripts/diagnostics/reindex-orchestrator.sh tier2
#   bash scripts/diagnostics/reindex-orchestrator.sh tier3
#   bash scripts/diagnostics/reindex-orchestrator.sh tier4
#   bash scripts/diagnostics/reindex-orchestrator.sh dryrun        # print plan, no exec
#   bash scripts/diagnostics/reindex-orchestrator.sh REPO_NAME     # one repo only

set -euo pipefail
cd "$(dirname "$0")/../.."

TIER="${1:-dryrun}"
REPO_ROOT="E:/Developer/lufftw/repo"
IDLE_BETWEEN="${IDLE_BETWEEN:-30}"   # seconds between repos
PER_INDEX_TIMEOUT="${PER_INDEX_TIMEOUT:-600}"  # seconds per repo
LOG_DIR="/tmp/reindex-$(date +%Y%m%d-%H%M%S)"

# Tier definitions (heat score / dual-write impact)
TIER1=(mcp-doc-search)
TIER2=(dev-machine-setup harness-research finetune-datasets event-chat-repo poi-data-layer-crawler-worker)
TIER3=(taiwan-address-normalizer milvus-services mcp-services gpu-coordinator
       event-crawler-worker event-platform-infra event-model-worker event-chat-service)
TIER4=(poi-data-layer event-search-service event-crawler)

case "$TIER" in
  tier1) REPOS=("${TIER1[@]}") ;;
  tier2) REPOS=("${TIER2[@]}") ;;
  tier3) REPOS=("${TIER3[@]}") ;;
  tier4) REPOS=("${TIER4[@]}") ;;
  dryrun)
    echo "Tier 1 (zero impact, run anytime):"
    for r in "${TIER1[@]}"; do echo "  $r"; done
    echo "Tier 2 (new collections, low impact):"
    for r in "${TIER2[@]}"; do echo "  $r"; done
    echo "Tier 3 (refresh existing, dual-write to event_shared):"
    for r in "${TIER3[@]}"; do echo "  $r"; done
    echo "Tier 4 (heavy / customer-facing — OFF-PEAK ONLY):"
    for r in "${TIER4[@]}"; do echo "  $r"; done
    exit 0
    ;;
  *) REPOS=("$TIER") ;;
esac

mkdir -p "$LOG_DIR"
echo "[orchestrator] tier=$TIER  repos=${#REPOS[@]}  log_dir=$LOG_DIR"
echo "[orchestrator] idle between=${IDLE_BETWEEN}s  per-index timeout=${PER_INDEX_TIMEOUT}s"

# Build env block from .mcp.json (this session's config — provides credentials).
# Per-repo project identity is loaded by EnvManager.setProjectPath() from each
# repo's .env at tool-call time, so we don't need to swap env per repo.
export $(node -e '
  const j=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));
  const srv=Object.values(j.mcpServers).find(s=>(s.command||"").includes("node"));
  for(const[k,v] of Object.entries(srv.env))process.stdout.write(`${k}=${v}\n`);
' | xargs -d '\n')

run_one_index() {
  local repo="$1"
  local abs="${REPO_ROOT}/${repo}"
  abs="$(echo "$abs" | sed 's|/|\\\\|g' | sed 's|^E:|E:|')"
  local req_file=$(mktemp)
  local out_file="$LOG_DIR/${repo}.stdout.json"
  local err_file="$LOG_DIR/${repo}.stderr.log"

  cat > "$req_file" <<EOF
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"reindex","version":"1"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"index_codebase","arguments":{"path":"${abs}"}}}
EOF

  local start=$(date +%s)
  echo "[orchestrator] [$(date '+%H:%M:%S')] indexing $repo ..."
  timeout "$PER_INDEX_TIMEOUT" node packages/mcp/dist/index.js < "$req_file" > "$out_file" 2> "$err_file" || true
  local rc=$?
  rm -f "$req_file"
  local elapsed=$(( $(date +%s) - start ))

  # Parse the second response (tools/call result)
  if grep -q '"id":2' "$out_file"; then
    local snippet=$(grep -o '"text":"[^"]*' "$out_file" | head -1 | sed 's|"text":"||' | head -c 120)
    echo "[orchestrator]   ${repo}: rc=$rc elapsed=${elapsed}s  result=${snippet}"
  else
    echo "[orchestrator]   ${repo}: NO RESPONSE — see $err_file"
    return 1
  fi
}

idx=0
for repo in "${REPOS[@]}"; do
  idx=$((idx + 1))
  echo "[orchestrator] === [$idx/${#REPOS[@]}] $repo ==="

  # Verify repo has a .env routing var
  if [[ ! -f "${REPO_ROOT}/${repo}/.env" ]] || ! grep -q "^MILVUS_COLLECTION_PRIVATE=" "${REPO_ROOT}/${repo}/.env"; then
    echo "[orchestrator]   ⚠ $repo lacks MILVUS_COLLECTION_PRIVATE in .env; would route to $MILVUS_COLLECTION_PRIVATE — SKIPPING"
    continue
  fi

  run_one_index "$repo"

  if [[ $idx -lt ${#REPOS[@]} ]]; then
    echo "[orchestrator]   idle ${IDLE_BETWEEN}s before next..."
    sleep "$IDLE_BETWEEN"
  fi
done

echo
echo "[orchestrator] DONE. logs in: $LOG_DIR"
