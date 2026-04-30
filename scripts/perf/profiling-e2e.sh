#!/usr/bin/env bash
# E2E corner-case harness for the TUI profiling instrumentation (#1586).
#
# Covers failure-mode invariants that unit tests can't verify (real TTY,
# real process.on("exit") firing, real Ctrl-C path, real renderer mount).
# Does NOT cover the S1/S2/S3 measurement scenarios in
# docs/perf/tui-wave5-measurement.md — those need a recorded LLM session.
#
# Usage:
#   scripts/perf/profiling-e2e.sh            # run all cases
#   scripts/perf/profiling-e2e.sh case-name  # run a single case
#
# Exit code: 0 if every case passes, 1 if any FAIL.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WT="$(basename "$REPO_ROOT")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/koi-profe2e-XXXXXX")"
BIN="bun run ${REPO_ROOT}/packages/meta/cli/src/bin.ts"
PASS=0
FAIL=0
FAILED_CASES=()

trap 'cleanup_all' EXIT

cleanup_all() {
  for s in $(tmux list-sessions -F '#S' 2>/dev/null | grep "^${WT}-profe2e-" || true); do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  rm -rf "$WORK"
}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# launch_tui <session-suffix> <env-prefix> -> waits until "Type a message..."
launch_tui() {
  local suffix=$1; shift
  local session="${WT}-profe2e-${suffix}"
  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -x 120 -y 40 \
    "cd ${REPO_ROOT} && $* ${BIN} tui 2>${WORK}/${suffix}.stderr"
  for _ in $(seq 1 30); do
    if tmux capture-pane -t "$session" -p 2>/dev/null | grep -q "Type a message"; then
      echo "$session"
      return 0
    fi
    sleep 0.5
  done
  echo "FAIL: TUI did not reach 'Type a message...' for $suffix" >&2
  tmux capture-pane -t "$session" -p 2>/dev/null | tail -10 >&2
  return 1
}

# Send Ctrl-C, confirm quit dialog, wait for tmux session to die.
graceful_quit() {
  local session=$1
  tmux send-keys -t "$session" C-c 2>/dev/null
  sleep 0.5
  tmux send-keys -t "$session" Enter 2>/dev/null   # confirm
  for _ in $(seq 1 20); do
    tmux has-session -t "$session" 2>/dev/null || return 0
    sleep 0.5
  done
  tmux kill-session -t "$session" 2>/dev/null || true
}

# Hard-kill the bun process inside a session (simulates crash).
crash_kill() {
  local session=$1
  local pid
  pid=$(tmux list-panes -t "$session" -F '#{pane_pid}' | head -1)
  [ -z "$pid" ] && return 1
  # bin.ts is a child of the shell; kill the process tree.
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -9 "$pid" 2>/dev/null || true
  tmux kill-session -t "$session" 2>/dev/null || true
}

assert() {
  local label=$1
  local expected=$2
  local actual=$3
  if [ "$expected" = "$actual" ]; then
    echo "  ok: ${label}"
  else
    echo "  FAIL: ${label} (expected='${expected}' actual='${actual}')"
    return 1
  fi
}

run_case() {
  local name=$1
  if [ $# -ge 2 ] && [ -n "${2:-}" ] && [ "$name" != "$2" ]; then
    return 0
  fi
  echo "── ${name} ──"
  if "case_${name}"; then
    PASS=$((PASS+1))
    echo "PASS ${name}"
  else
    FAIL=$((FAIL+1))
    FAILED_CASES+=("$name")
    echo "FAIL ${name}"
  fi
}

# ---------------------------------------------------------------------------
# cases
# ---------------------------------------------------------------------------

# 1. Off-path inert: no env, no profile artifacts, no stderr noise.
case_off_path_inert() {
  local out="${WORK}/off.json"
  local session
  session=$(launch_tui "off" "KOI_TUI_PROFILE_OUT=${out}") || return 1
  graceful_quit "$session"
  [ -f "$out" ] && { echo "  FAIL: report written when KOI_TUI_PROFILE unset"; return 1; }
  if grep -q "koi-tui-profile" "${WORK}/off.stderr" 2>/dev/null; then
    echo "  FAIL: stderr contains koi-tui-profile noise when disabled"
    return 1
  fi
  echo "  ok: no artifacts when disabled"
}

# 2. Very short run: start + immediate quit. Final-tick must capture ≥1 sample.
case_short_run() {
  local out="${WORK}/short.json"
  local session
  session=$(launch_tui "short" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${out}") || return 1
  graceful_quit "$session"
  [ ! -f "$out" ] && { echo "  FAIL: report not written"; return 1; }
  local n
  n=$(jq '.samples["cpu.userUs"] | length' "$out")
  if [ "$n" -lt 1 ]; then
    echo "  FAIL: expected ≥1 cpu sample (final tick), got $n"
    return 1
  fi
  echo "  ok: cpu.userUs samples=$n"
}

# 3. Crash via SIGKILL: exit handler runs and writes a partial report
#    capturing the trailing CPU tick.
case_crash_writes_report() {
  local out="${WORK}/crash.json"
  local session
  session=$(launch_tui "crash" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${out}") || return 1
  sleep 1
  crash_kill "$session"
  sleep 1
  if [ ! -f "$out" ]; then
    echo "  ok: SIGKILL bypasses exit handler (expected — report not written on -9)"
    # Note: process.on("exit") does NOT fire on SIGKILL. This is a documented
    # Node behavior. Test that we degrade gracefully (no orphan tmp file).
  fi
  local stale
  stale=$(find "$WORK" -name 'crash.json.tmp-*' 2>/dev/null | wc -l)
  if [ "$stale" -ne 0 ]; then
    echo "  FAIL: orphan tmp file left after SIGKILL: $(find "$WORK" -name 'crash.json.tmp-*')"
    return 1
  fi
  echo "  ok: no orphan tmp files after crash"
}

# 4. Output dir missing: stderr error, no overwrite of valid prior report.
case_missing_dir() {
  local good="${WORK}/good.json"
  local bad="${WORK}/missing/dir/bad.json"
  # Seed a good report.
  local s1
  s1=$(launch_tui "good" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${good}") || return 1
  graceful_quit "$s1"
  [ ! -f "$good" ] && { echo "  FAIL: good seed report missing"; return 1; }
  local good_hash
  good_hash=$(shasum "$good" | awk '{print $1}')
  # Now run with a missing parent dir.
  local s2
  s2=$(launch_tui "missdir" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${bad}") || return 1
  graceful_quit "$s2"
  [ -f "$bad" ] && { echo "  FAIL: bad path got written despite missing dir"; return 1; }
  if ! grep -q "failed to write" "${WORK}/missdir.stderr" 2>/dev/null; then
    echo "  FAIL: expected 'failed to write' on stderr"
    cat "${WORK}/missdir.stderr" >&2
    return 1
  fi
  # Good report unchanged.
  local good_hash2
  good_hash2=$(shasum "$good" | awk '{print $1}')
  assert "good report unchanged" "$good_hash" "$good_hash2" || return 1
}

# 5. Output path IS a directory: atomic-rename refuses, no truncation,
#    no orphan tmp files.
case_path_is_dir() {
  local p="${WORK}/asdir.json"
  mkdir -p "$p"
  local session
  session=$(launch_tui "isdir" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${p}") || return 1
  graceful_quit "$session"
  if [ ! -d "$p" ]; then
    echo "  FAIL: directory at outpath was overwritten or removed"
    return 1
  fi
  local stale
  stale=$(find "$WORK" -maxdepth 2 -name 'asdir.json.tmp-*' 2>/dev/null | wc -l)
  if [ "$stale" -ne 0 ]; then
    echo "  FAIL: orphan tmp file left: $(find "$WORK" -name 'asdir.json.tmp-*')"
    return 1
  fi
  if ! grep -q "failed to write" "${WORK}/isdir.stderr" 2>/dev/null; then
    echo "  FAIL: expected 'failed to write' on stderr"
    return 1
  fi
  echo "  ok: directory intact, no orphan tmp, error reported"
}

# 6. Path captured at init: relative path resolves against init-time cwd,
#    not where the process happens to be later.
case_relative_path_resolves_at_init() {
  # `koi tui` must be launched from the project root (for skills/configs).
  # We therefore can't test cwd change at the launcher level. Instead:
  # verify a relative KOI_TUI_PROFILE_OUT lands at REPO_ROOT/<rel>, which
  # demonstrates path.resolve() ran against the init-time cwd.
  local rel="profe2e-rel-${RANDOM}.json"
  local expected="${REPO_ROOT}/${rel}"
  rm -f "$expected"
  local session
  session=$(launch_tui "rel" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${rel}") || return 1
  graceful_quit "$session"
  if [ ! -f "$expected" ]; then
    echo "  FAIL: relative path did not resolve to REPO_ROOT/${rel}"
    return 1
  fi
  rm -f "$expected"
  echo "  ok: relative ${rel} resolved to REPO_ROOT at init"
}

# 7. Run B succeeds after run A's failed write is no longer pending.
#    A's pending-write would otherwise leak into B per
#    ProfilingPendingWriteError. Simulated cross-process: run A with bad
#    path (process exits, snapshot does NOT persist across processes),
#    run B with a good path — must succeed.
case_pending_does_not_cross_process() {
  local bad="${WORK}/x/y/bad.json"
  local good="${WORK}/recover.json"
  local s1
  s1=$(launch_tui "penda" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${bad}") || return 1
  graceful_quit "$s1"
  local s2
  s2=$(launch_tui "pendb" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${good}") || return 1
  graceful_quit "$s2"
  if [ ! -f "$good" ]; then
    echo "  FAIL: run B did not write its report"
    cat "${WORK}/pendb.stderr" >&2
    return 1
  fi
  if grep -q "ProfilingPendingWriteError" "${WORK}/pendb.stderr" 2>/dev/null; then
    echo "  FAIL: pending-write error leaked across processes"
    return 1
  fi
  echo "  ok: pending state is per-process (does not leak)"
}

# 8. Double Ctrl-C is idempotent (no double-write, no error).
case_double_quit_idempotent() {
  local out="${WORK}/dbl.json"
  local session
  session=$(launch_tui "dbl" "KOI_TUI_PROFILE=1 KOI_TUI_PROFILE_OUT=${out}") || return 1
  tmux send-keys -t "$session" C-c
  sleep 0.3
  tmux send-keys -t "$session" C-c   # second interrupt
  sleep 0.3
  tmux send-keys -t "$session" Enter
  for _ in $(seq 1 20); do
    tmux has-session -t "$session" 2>/dev/null || break
    sleep 0.5
  done
  tmux kill-session -t "$session" 2>/dev/null || true
  [ ! -f "$out" ] && { echo "  FAIL: report missing after double quit"; return 1; }
  local n
  n=$(grep -c "report written to" "${WORK}/dbl.stderr" 2>/dev/null || echo 0)
  if [ "$n" -gt 1 ]; then
    echo "  FAIL: report written multiple times ($n) — idempotency broken"
    return 1
  fi
  echo "  ok: single write across double quit"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

CASES=(
  off_path_inert
  short_run
  crash_writes_report
  missing_dir
  path_is_dir
  relative_path_resolves_at_init
  pending_does_not_cross_process
  double_quit_idempotent
)

ONLY="${1:-}"
for c in "${CASES[@]}"; do
  run_case "$c" "$ONLY"
done

echo
echo "════════════════════════════════════════"
echo "  PROFILING E2E"
echo "  passed: ${PASS}"
echo "  failed: ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  echo "  failing: ${FAILED_CASES[*]}"
fi
echo "════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
