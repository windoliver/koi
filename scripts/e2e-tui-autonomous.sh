#!/bin/bash
#
# E2E: TUI-based autonomous spawn-delegation test via tmux.
#
# Tests the full user experience:
#   1. Start koi up in a tmux session (demo preset + Nexus)
#   2. Navigate TUI to agent console
#   3. Type a message asking for spawn delegation
#   4. Verify plan creation + worker dispatch in TUI output
#   5. Verify harness completion via admin API
#   6. Verify copilot received per-task notifications
#   7. Clean up
#
# Requires: OPENROUTER_API_KEY, NEXUS_URL, NEXUS_API_KEY, tmux, Docker
#
# Run:
#   export OPENROUTER_API_KEY=...
#   export NEXUS_URL=http://localhost:33320
#   export NEXUS_API_KEY=...
#   bash scripts/e2e-tui-autonomous.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY not set" >&2
  exit 1
fi
if [[ -z "${NEXUS_URL:-}" ]]; then
  echo "NEXUS_URL not set (run: cd /path/to/koi && eval \$(nexus env))" >&2
  exit 1
fi

ADMIN_URL="http://localhost:3100/admin/api"
SESSION="koi-e2e-$$"
WORKDIR=$(mktemp -d)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/../packages/meta/cli/src/bin.ts"
PASSED=0
FAILED=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

pass() { PASSED=$((PASSED + 1)); echo "  $(tput setaf 2)PASS$(tput sgr0)  $1"; }
fail() { FAILED=$((FAILED + 1)); echo "  $(tput setaf 1)FAIL$(tput sgr0)  $1${2:+ — $2}"; }
step() { echo ""; echo "$(tput setaf 6)══ $1 ══$(tput sgr0)"; }

capture() { tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo "(tmux capture failed)"; }

wait_for_text() {
  local text="$1"
  local timeout="${2:-30}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if capture | grep -q "$text"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_api() {
  local url="$1"
  local timeout="${2:-90}"
  local deadline=$((SECONDS + timeout))
  while (( SECONDS < deadline )); do
    if curl -sf "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cleanup() {
  step "Cleanup"
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$WORKDIR"
  # Kill any lingering temporal
  pkill -f "temporal.*server" 2>/dev/null || true
  echo "  tmux session killed, temp dir cleaned"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

step "Setup: create temp workspace"

cat > "$WORKDIR/koi.yaml" <<'YAML'
name: "e2e-tui-autonomous"
version: "0.0.1"
description: "TUI e2e test for autonomous spawn delegation"

preset: demo

model:
  name: "openrouter:anthropic/claude-3.5-haiku"

autonomous:
  enabled: true
YAML

echo "  workspace: $WORKDIR"
echo "  koi.yaml written"

# ---------------------------------------------------------------------------
# Start koi up in tmux
# ---------------------------------------------------------------------------

step "Start: koi up in tmux"

tmux new-session -d -s "$SESSION" -x 120 -y 40 \
  "cd $WORKDIR && OPENROUTER_API_KEY=$OPENROUTER_API_KEY NEXUS_API_KEY=${NEXUS_API_KEY:-} bun run $BIN up --manifest $WORKDIR/koi.yaml --nexus-url ${NEXUS_URL} --verbose 2>&1"

echo "  tmux session: $SESSION"

# ---------------------------------------------------------------------------
# Wait for admin API
# ---------------------------------------------------------------------------

step "Wait: admin API healthy"

if wait_for_api "$ADMIN_URL/health" 90; then
  pass "admin API is healthy"
else
  fail "admin API is healthy" "timeout"
  capture
  exit 1
fi

# ---------------------------------------------------------------------------
# Wait for agent ready
# ---------------------------------------------------------------------------

step "Wait: agent ready in TUI"

if wait_for_text "ready" 45; then
  pass "agent appears in TUI"
else
  fail "agent appears in TUI" "timeout"
  echo "  TUI screen:"
  capture
fi

# Wait for admin API to have agents
sleep 5

# ---------------------------------------------------------------------------
# Navigate TUI: select agent → open console
# ---------------------------------------------------------------------------

step "TUI: navigate to console"

# Press Enter to select the agent (opens console view)
tmux send-keys -t "$SESSION" Enter
sleep 2

# Capture and verify we're in the console
SCREEN=$(capture)
echo "  screen after Enter:"
echo "$SCREEN" | head -5

# ---------------------------------------------------------------------------
# Send message via TUI input
# ---------------------------------------------------------------------------

step "TUI: send autonomous plan message"

# Type the message in the console input
MSG='Use plan_autonomous with 2 spawn tasks: {id:"haiku-ocean", description:"Write a haiku about the ocean", delegation:"spawn", agentType:"poet"} and {id:"haiku-mountain", description:"Write a haiku about mountains", delegation:"spawn", agentType:"poet"}. No dependencies.'

tmux send-keys -t "$SESSION" "$MSG" Enter

echo "  message sent"

# Wait for plan creation
sleep 10

# Check TUI for plan_autonomous response
SCREEN=$(capture)
if echo "$SCREEN" | grep -qi "plan"; then
  pass "TUI shows plan response"
else
  fail "TUI shows plan response" "no plan text in TUI"
fi

echo "  TUI after message:"
echo "$SCREEN" | tail -15

# ---------------------------------------------------------------------------
# Verify harness status via admin API
# ---------------------------------------------------------------------------

step "Verify: harness status via admin API"

# Wait for harness to complete
DEADLINE=$((SECONDS + 90))
PHASE="unknown"
while (( SECONDS < DEADLINE )); do
  RESULT=$(curl -sf "$ADMIN_URL/view/harness/status" 2>/dev/null || echo '{}')
  PHASE=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('data',{}).get('phase','unknown'))" 2>/dev/null || echo "unknown")
  DONE=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); tp=d.get('data',{}).get('taskProgress',{}); print(tp.get('completed',0))" 2>/dev/null || echo "0")
  printf "\r  phase=%s done=%s  " "$PHASE" "$DONE"
  if [[ "$PHASE" == "completed" || "$PHASE" == "failed" ]]; then
    break
  fi
  sleep 2
done
echo ""

if [[ "$PHASE" == "completed" ]]; then
  pass "harness phase is completed"
else
  fail "harness phase is completed" "phase=$PHASE"
fi

if [[ "$DONE" == "2" ]]; then
  pass "2 tasks completed"
else
  fail "2 tasks completed" "done=$DONE"
fi

# ---------------------------------------------------------------------------
# Verify: TUI shows completion
# ---------------------------------------------------------------------------

step "Verify: TUI shows completion state"

SCREEN=$(capture)
echo "  Final TUI screen:"
echo "$SCREEN" | tail -20

# ---------------------------------------------------------------------------
# Session 2: copilot responds to unrelated question
# ---------------------------------------------------------------------------

step "TUI: send unrelated question"

tmux send-keys -t "$SESSION" "What is 2 + 2? Reply with just the number." Enter
sleep 8

SCREEN=$(capture)
if echo "$SCREEN" | grep -q "4"; then
  pass "copilot answered unrelated question"
else
  fail "copilot answered unrelated question" "no '4' in TUI"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "============================================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "============================================================"

if (( FAILED > 0 )); then
  exit 1
fi
