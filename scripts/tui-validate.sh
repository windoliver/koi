#!/usr/bin/env bash
# Multi-pane tmux validation harness for the gateway HA flow.
#
# Layout:
#   pane 0 (top-left)     gwA  — gateway-up.ts on :19500
#   pane 1 (top-right)    gwB  — gateway-up.ts on :19510
#   pane 2 (bottom-left)  REPL — interactive WS client → gwA, then gwB
#   pane 3 (bottom-right) observer — periodic Nexus record dump
#
# Captures each pane after each phase and writes evidence files to
# tasks/tui-validate/<phase>-<pane>.txt for review.

set -euo pipefail

WORKTREE="$(basename "$PWD")"
SESSION="${WORKTREE}-tuival"
NEXUS_URL="${NEXUS_URL:-http://127.0.0.1:22920}"
NEXUS_API_KEY="${NEXUS_API_KEY:-$(cat /tmp/nexus-rss-demo/nexus-data/.admin-api-key)}"
EVIDENCE_DIR="tasks/tui-validate"
mkdir -p "$EVIDENCE_DIR"
rm -f "$EVIDENCE_DIR"/*.txt

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  pkill -f gateway-up.ts 2>/dev/null || true
  pkill -f repl.ts 2>/dev/null || true
}
trap cleanup EXIT

cleanup

capture() {
  local phase="$1"
  for i in 0 1 2 3; do
    if tmux list-panes -t "$SESSION:0.$i" >/dev/null 2>&1; then
      tmux capture-pane -t "$SESSION:0.$i" -p -S -100 > "$EVIDENCE_DIR/${phase}-pane${i}.txt" 2>/dev/null || true
    fi
  done
}

echo "=== Phase 1: launch gwA + gwB in 4-pane tmux ==="
tmux new-session -d -s "$SESSION" -x 240 -y 60 -n main \
  "PORT=19500 INSTANCE_ID=gwA NEXUS_URL=$NEXUS_URL NEXUS_API_KEY=$NEXUS_API_KEY bun run packages/net/gateway-stack/scripts/gateway-up.ts; read"
sleep 1.5
tmux split-window -t "$SESSION:0.0" -h \
  "PORT=19510 INSTANCE_ID=gwB NEXUS_URL=$NEXUS_URL NEXUS_API_KEY=$NEXUS_API_KEY bun run packages/net/gateway-stack/scripts/gateway-up.ts; read"
sleep 1.5
tmux split-window -t "$SESSION:0.0" -v \
  "while sleep 2; do echo '--- Nexus list ---'; curl -s -X POST $NEXUS_URL/api/nfs/list -H 'Authorization: Bearer $NEXUS_API_KEY' -H 'Content-Type: application/json' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"list\",\"params\":{\"path\":\"global/gateway/sessions\"}}' | head -c 400; echo; done"
sleep 1.5
tmux split-window -t "$SESSION:0.1" -v \
  "echo READY; sleep 1; while true; do read -r line; echo \"\$line\"; done"
sleep 2

# Verify gateways are up
curl -fs http://127.0.0.1:19501/health >/dev/null || { echo "gwA not healthy"; exit 1; }
curl -fs http://127.0.0.1:19511/health >/dev/null || { echo "gwB not healthy"; exit 1; }

capture "phase1-boot"

echo "=== Phase 2: REPL session against gwA, send 3 messages ==="
printf 'hello via tmux REPL\nsecond line\nthird line\n:quit\n' | \
  bun run packages/net/gateway-stack/scripts/repl.ts ws://127.0.0.1:19500 tmux-user > "$EVIDENCE_DIR/phase2-repl-gwA.txt" 2>&1
sleep 2

capture "phase2-after-gwA"

echo "=== Phase 3: HA — REPL session against gwB with same client.id ==="
printf 'after-failover msg 1\nafter-failover msg 2\n:quit\n' | \
  bun run packages/net/gateway-stack/scripts/repl.ts ws://127.0.0.1:19510 tmux-user > "$EVIDENCE_DIR/phase3-repl-gwB.txt" 2>&1
sleep 2

capture "phase3-after-gwB"

echo "=== Phase 4: kill -9 gwA, REPL reconnects to gwB ==="
GW_A_PID=$(lsof -nP -iTCP:19500 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | head -1)
echo "killing gwA pid=$GW_A_PID"
kill -9 "$GW_A_PID" || true
sleep 1
printf 'post-kill msg\n:quit\n' | \
  bun run packages/net/gateway-stack/scripts/repl.ts ws://127.0.0.1:19510 tmux-user > "$EVIDENCE_DIR/phase4-repl-postkill.txt" 2>&1
sleep 2

capture "phase4-postkill"

echo "=== Phase 5: read final Nexus record ==="
PATH64=$(echo -n "sess-$(echo -n tmux-user | xxd -p)" | base64 | tr '+/' '-_' | tr -d '=')
curl -s -X POST "$NEXUS_URL/api/nfs/read_bulk" -H "Authorization: Bearer $NEXUS_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"read_bulk\",\"params\":{\"paths\":[\"global/gateway/sessions/$PATH64.json\"]}}" \
  -o "$EVIDENCE_DIR/phase5-final-record.json"

python3 -c "
import json, base64
r = json.load(open('$EVIDENCE_DIR/phase5-final-record.json'), strict=False)
v = list(r['result'].values())[0]
rec = json.loads(base64.b64decode(v['data']).decode())
print(json.dumps(rec, indent=2))
" > "$EVIDENCE_DIR/phase5-final-record-decoded.txt"

cat "$EVIDENCE_DIR/phase5-final-record-decoded.txt"

echo
echo "=== evidence files ==="
ls -la "$EVIDENCE_DIR/"
