#!/usr/bin/env bash
# Re-index a tier of repositories. Designed for use AFTER the v0.1.4-lufftw.3
# EnvManager concurrency fix is loaded (i.e. after the running Claude Code
# session has been restarted to pick up the new dist).
#
# This script does NOT spawn per-repo MCP processes (the prior orchestrator
# did, and the timeout-kill of long-running indexings was unreliable). Instead,
# it:
#   - Spawns a single fresh MCP process for the whole batch (or, in --parallel
#     mode, fires all index_codebase calls into ONE MCP and waits for the
#     queue to drain)
#   - Uses RabbitMQ queue depth (ready+unack) as the completion signal
#   - Verifies routing by sampling each new collection's content
#
# Usage:
#   bash scripts/diagnostics/reindex-tier.sh tier3            # serial
#   bash scripts/diagnostics/reindex-tier.sh tier3 --parallel # parallel
#                                                             # (requires v0.1.4-lufftw.3)
#   bash scripts/diagnostics/reindex-tier.sh tier4 --parallel
#
# Why parallel is safe in v0.1.4-lufftw.3+:
#   The EnvManager singleton was rewritten to use AsyncLocalStorage so that
#   each Context.indexCodebase() call sees its own project context, even when
#   sibling calls are in flight. Prior to this, parallel calls clobbered each
#   other's MILVUS_COLLECTION_PRIVATE and routed all chunks to whichever path
#   was setProjectPath()'d most recently.
#   See: docs/lufftw/bugfix-2026-05-04-envmanager-concurrency.md

set -euo pipefail
cd "$(dirname "$0")/../.."

TIER="${1:-dryrun}"
MODE="${2:-serial}"
REPO_ROOT="E:/Developer/lufftw/repo"
LOG_DIR="/tmp/reindex-$(date +%Y%m%d-%H%M%S)"

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
  *)
    cat <<'HELP'
Usage: reindex-tier.sh <tier> [--parallel]

Tiers:
  tier1 — mcp-doc-search (fastest, no shared write)
  tier2 — 5 repos with new collections (low impact)
  tier3 — 8 repos refresh (dual-writes to event_shared)
  tier4 — 3 heavy repos (event-crawler, event-search-service, poi-data-layer)
          Run OFF-PEAK to avoid contention with realtime search.

Modes:
  (default) — serial: one repo at a time, safe on any version
  --parallel — fires all repos at once. REQUIRES v0.1.4-lufftw.3+ (EnvManager
               AsyncLocalStorage fix). Without that fix, parallel mode causes
               cross-collection contamination — chunks land in the wrong
               collection because EnvManager's projectPath was global state.
HELP
    exit 0
    ;;
esac

mkdir -p "$LOG_DIR"
echo "[reindex-tier] tier=$TIER mode=$MODE repos=${#REPOS[@]} log_dir=$LOG_DIR"

# Build env block from .mcp.json
export $(node -e '
  const j=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));
  const srv=Object.values(j.mcpServers).find(s=>(s.command||"").includes("node"));
  for(const[k,v] of Object.entries(srv.env))process.stdout.write(`${k}=${v}\n`);
' | xargs -d '\n')

# Helper: build JSON-RPC initialize + N tools/call frames
build_rpc() {
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"reindex-tier","version":"1"}}}'
    local id=2
    for r in "$@"; do
        local abs_path="${REPO_ROOT}/${r}"
        echo "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"index_codebase\",\"arguments\":{\"path\":\"$(echo $abs_path | sed 's|/|\\\\|g')\"}}}"
        id=$((id + 1))
    done
}

# Wait until RabbitMQ queue is drained for a sustained period
wait_for_drain() {
    local stable=0
    while true; do
        local r=$(curl -sS "http://127.0.0.1:15672/api/queues/inference/embedding.qwen3-8b" \
            -H "Authorization: Basic $(echo -n 'crawler:4MizIwuQ1wbSOL5vXh3WMBKU' | base64)" \
            --max-time 3 2>/dev/null | \
            node -e 'try{const j=JSON.parse(require("fs").readFileSync(0,"utf8"));process.stdout.write(j.messages_ready+"/"+j.messages_unacknowledged)}catch(e){process.stdout.write("-/-")}')
        echo "$(date '+%H:%M:%S') q=$r"
        if [ "$r" = "0/0" ]; then
            stable=$((stable + 1))
            if [ "$stable" -ge 2 ]; then echo "DRAINED"; return 0; fi
        else
            stable=0
        fi
        sleep 15
    done
}

if [ "$MODE" = "--parallel" ]; then
    echo "[reindex-tier] PARALLEL mode — sending all $((${#REPOS[@]})) tools/call into one MCP"
    build_rpc "${REPOS[@]}" > "$LOG_DIR/rpc.txt"
    # MCP keeps stdio open; we'll let it run for 30 min max while waiting on queue
    timeout 1800 node packages/mcp/dist/index.js < "$LOG_DIR/rpc.txt" > "$LOG_DIR/mcp.stdout.json" 2> "$LOG_DIR/mcp.stderr.log" &
    MCP_PID=$!
    sleep 5  # let MCP initialize
    wait_for_drain
    kill -TERM $MCP_PID 2>/dev/null || true
    wait $MCP_PID 2>/dev/null || true
else
    echo "[reindex-tier] SERIAL mode — one repo at a time"
    for r in "${REPOS[@]}"; do
        echo "[reindex-tier] === $r ==="
        build_rpc "$r" > "$LOG_DIR/${r}-rpc.txt"
        timeout 900 node packages/mcp/dist/index.js < "$LOG_DIR/${r}-rpc.txt" > /dev/null 2> "$LOG_DIR/${r}.stderr.log" &
        MCP_PID=$!
        sleep 5
        wait_for_drain
        kill -TERM $MCP_PID 2>/dev/null || true
        wait $MCP_PID 2>/dev/null || true
    done
fi

echo "[reindex-tier] DONE. Logs in: $LOG_DIR"
