#!/usr/bin/env bash
# Run a single ClawBench task through koi headless.
# Usage: clawbench/run-task.sh <task-dir>
#   e.g. clawbench/run-task.sh /tmp/claw-bench-src/tasks/file-operations/file-002-csv-to-json
set -euo pipefail

TASK_DIR="${1:?task dir required}"
TASK_ID=$(basename "$TASK_DIR")
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS_DIR="$REPO_ROOT/clawbench/results/$TASK_ID"
WORKSPACE="$RESULTS_DIR/workspace"
MANIFEST="$REPO_ROOT/clawbench/koi.yaml"

rm -rf "$RESULTS_DIR"
mkdir -p "$WORKSPACE"

# Ephemeral, per-run HOME for untrusted children (setup.sh / koi / verifier).
# Wiped with RESULTS_DIR every run, so they get a fresh scratch home instead
# of the operator's real ~ (no host dotfile/credential read or persistence).
SANDBOX_HOME="$RESULTS_DIR/.sandbox-home"
mkdir -p "$SANDBOX_HOME"

# --- Credential isolation ---------------------------------------------------
# Untrusted task code runs in this process tree: environment/setup.sh and the
# agent's own Bash tool execute arbitrary shell. We therefore NEVER source
# .env into this shell — sourcing executes arbitrary code. Instead we parse
# .env with a strict KEY=VALUE reader, extract ONLY the single model key koi
# needs, and inject it (plus an explicit allowlist) into just the koi
# invocation via `env -i`. setup.sh receives no credentials at all.
_read_env_key() {
  # Strict reader: never sources/executes .env. Last assignment wins;
  # tolerates an optional `export ` prefix and one layer of matching quotes.
  local key="$1" file="$REPO_ROOT/.env" line val
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -1 || true)
  [ -n "$line" ] || return 0
  val=${line#*=}
  case "$val" in
    \"*\") val=${val#\"}; val=${val%\"} ;;
    \'*\') val=${val#\'}; val=${val%\'} ;;
  esac
  printf '%s' "$val"
}
MODEL_KEY_NAME="OPENROUTER_API_KEY"
MODEL_KEY_VAL="$(_read_env_key OPENROUTER_API_KEY)"
if [ -z "$MODEL_KEY_VAL" ]; then
  MODEL_KEY_NAME="OPENAI_API_KEY"
  MODEL_KEY_VAL="$(_read_env_key OPENAI_API_KEY)"
fi
if [ -z "$MODEL_KEY_VAL" ]; then
  echo "FATAL: no OPENROUTER_API_KEY or OPENAI_API_KEY in $REPO_ROOT/.env" >&2
  exit 1
fi
MODEL_KEY_KV="$MODEL_KEY_NAME=$MODEL_KEY_VAL"

# Prevent agent-invoked python from creating __pycache__/.pyc (verifiers flag
# these). Non-secret; also benefits the in-shell verifier pytest below.
export PYTHONDONTWRITEBYTECODE=1

# Exfiltration guard.
#
# The default is the SAFE one: the guard is explicitly forced to "block".
# Downgrading to "warn" happens ONLY when the operator explicitly opts in for
# a trusted run by exporting CLAWBENCH_EXFIL_DOWNGRADE=1. Because the koi
# invocation runs under `env -i` with an allowlist (model key only), even a
# downgraded run has no other credential available to exfiltrate.
if [ "${CLAWBENCH_EXFIL_DOWNGRADE:-0}" = "1" ]; then
  EXFIL_ACTION_KV="KOI_EXFIL_ACTION=warn"
  EXFIL_DOWNGRADE_KV="KOI_EXFIL_ALLOW_DOWNGRADE=1"
  echo "=== exfil guard DOWNGRADED to warn (operator opt-in) ===" >&2
else
  EXFIL_ACTION_KV="KOI_EXFIL_ACTION=block"
  EXFIL_DOWNGRADE_KV="KOI_EXFIL_ALLOW_DOWNGRADE=0"
fi

# Minimal allowlisted environment for every untrusted child (setup.sh + koi).
# `env -i` wipes the inherited environment; we re-add only non-sensitive
# runtime essentials. No secrets here — the model key is added to the koi
# invocation ONLY, never to setup.sh. HOME is the ephemeral per-run sandbox
# dir, not the operator's real home.
#
# PATH is the host PATH by necessity: this is an agent benchmark whose whole
# purpose is running real dev tooling (python, node, git, …) and koi itself
# resolves `bun` from PATH. Confining the filesystem/command surface beyond
# this (chroot, command allowlist, uid separation) requires OS-level
# sandboxing (container/sandbox-exec) and is out of scope for a shell
# harness — operators running an untrusted task set should containerize.
SAFE_ENV=(
  "PATH=$PATH"
  "HOME=$SANDBOX_HOME"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-C}"
  "TERM=${TERM:-xterm}"
  "PYTHONDONTWRITEBYTECODE=1"
)

# Allowlist for the verifier (pytest). test_output.py is untrusted task code,
# so it must NOT inherit operator/CI secrets from the ambient environment.
# It needs only the runtime essentials plus the workspace path vars some
# upstream verifiers read at import time.
VERIFY_ENV=(
  "${SAFE_ENV[@]}"
  "WORKSPACE=$WORKSPACE"
  "CLAW_WORKSPACE=$WORKSPACE"
)

# Hard time bounds for untrusted steps. setup.sh and the verifier are task-
# provided; a malicious/buggy task could hang forever (infinite loop, hung
# network) and stall run-domain.sh/run-all-remaining.sh indefinitely.
SETUP_TIMEOUT="${CLAWBENCH_SETUP_TIMEOUT:-120}"
VERIFY_TIMEOUT="${CLAWBENCH_VERIFY_TIMEOUT:-240}"
# Outer backstop above koi's own --max-duration-ms (300s) in case the engine
# overruns its internal budget.
KOI_TIMEOUT="${CLAWBENCH_KOI_TIMEOUT:-420}"

if command -v timeout >/dev/null 2>&1; then
  _TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  _TIMEOUT_BIN="gtimeout"
else
  _TIMEOUT_BIN=""
fi
_with_timeout() {
  # $1 = seconds; rest = command (NOT a pipeline). Uses coreutils
  # timeout/gtimeout when available (exit 124 on timeout, SIGKILL 10s after
  # SIGTERM). When neither exists, a built-in sleep+kill watchdog enforces an
  # equivalent hard cap, so EVERY untrusted step is bounded on every host
  # (no silent unbounded path). Timeout via watchdog returns a non-zero
  # (signal) status, which all callers already treat as failure.
  local secs="$1"; shift
  if [ -n "$_TIMEOUT_BIN" ]; then
    "$_TIMEOUT_BIN" -k 10 "$secs" "$@"
    return $?
  fi
  # Fallback watchdog. Launch under job control (`set -m`) so the command
  # becomes a process-group leader (pgid == pid); the watchdog then signals
  # the WHOLE group with `kill -- -PGID`, so descendants (bun, python, any
  # subprocess setup.sh/the agent spawned) die with it instead of leaking
  # past the budget into later runs.
  local _mflag=""
  case "$-" in *m*) _mflag="on" ;; esac
  set -m
  "$@" &
  local cmd_pid=$!
  [ "$_mflag" = "on" ] || set +m
  (
    sleep "$secs"
    kill -TERM "-$cmd_pid" 2>/dev/null
    sleep 10
    kill -KILL "-$cmd_pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  local wd_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?
  # Command finished (or its group was killed): retire the watchdog and
  # sweep any stragglers in the command's process group.
  kill -TERM "$wd_pid" 2>/dev/null || true
  wait "$wd_pid" 2>/dev/null || true
  kill -KILL "-$cmd_pid" 2>/dev/null || true
  return "$rc"
}

# Try setup.sh with workspace arg; some scripts ignore $1 and write to
# TASK_DIR/workspace. Always also copy environment/data directly as fallback
# to guarantee seeding. Time-bounded: a hanging setup.sh must not wedge CI.
# Run with cwd = $WORKSPACE so the script's *default* (relative-path) writes
# land in the task workspace rather than the harness/repo tree. NOTE: this
# scopes the common case only — a hostile script can still absolute-path or
# `cd` out. True filesystem confinement (chroot/mount-ns/container) is the
# same OS-sandbox boundary documented at SAFE_ENV and is out of scope for a
# shell harness; operators running an untrusted task set should containerize.
( cd "$WORKSPACE" && _with_timeout "$SETUP_TIMEOUT" env -i "${SAFE_ENV[@]}" \
  bash "$TASK_DIR/environment/setup.sh" "$WORKSPACE" ) \
  > "$RESULTS_DIR/setup.log" 2>&1 || true
tail -5 "$RESULTS_DIR/setup.log" >&2 2>/dev/null || true
if [ -d "$TASK_DIR/environment/data" ]; then
  cp -r "$TASK_DIR/environment/data/." "$WORKSPACE/" 2>/dev/null || true
fi
# Clean up any workspace created in TASK_DIR by buggy setup.sh
rm -rf "$TASK_DIR/workspace" 2>/dev/null || true

INSTRUCTION=$(cat "$TASK_DIR/instruction.md")
PROMPT="Your working directory IS the workspace: $WORKSPACE
You are already inside it. When the task says a path like 'workspace/foo.txt',
it means the file 'foo.txt' in your current directory — do NOT create a
nested 'workspace/' subdirectory. Strip any leading 'workspace/' from paths.

$INSTRUCTION

IMPORTANT cleanup rules for grading:
- Do NOT delete the input/source files you were given to read. The grader may compare your output against them.
- Do not create temp files, debug logs, scratch scripts, or caches in the workspace. If you need to run a helper script, run it from /tmp.
- Do not produce files with extensions .pyc, .log, .bak, .tmp or directories named __pycache__.
- The workspace at the end must contain exactly: the original seed files (unchanged unless the task says to modify them in place) PLUS the files the task asks you to create."

# Per-task model override. A small allowlist of heavy structured-output
# tasks needs a stronger model than the Haiku default (Haiku thrashes on
# large JSON generation and exhausts the budget). Everything else stays on
# the manifest default to conserve the OpenRouter daily limit.
# Manifest model always wins over KOI_MODEL (start.ts: manifestModelName ??
# apiConfig.model), so heavy tasks select a Sonnet manifest instead.
HEAVY_TASKS="sec-015-full-security-assessment xdom-013-incident-response-pipeline xdom-014-data-driven-email-campaign xdom-015-automated-code-review-report mag-001-code-review-pipeline cs-003-log-analyzer cs-004-ci-pipeline edu-004-curriculum-mapping sci-002-monte-carlo sci-004-signal-processing bio-003-gene-expression acad-003-statistical-analysis fin-006-analyze-stock-portfolio-risk-using-var-and-cvar"
if echo " $HEAVY_TASKS " | grep -qF " $TASK_ID "; then
  MANIFEST="$REPO_ROOT/clawbench/koi-sonnet.yaml"
  echo "=== $TASK_ID: model override → Sonnet (koi-sonnet.yaml) ===" >&2
fi

echo "=== Running $TASK_ID ===" >&2
cd "$WORKSPACE"

# Defense-in-depth: bun auto-loads a .env from its cwd ($WORKSPACE). A
# malicious setup.sh could plant one containing KOI_EXFIL_* to silently
# disable the guard. Remove any task-planted dotenv before launching koi.
rm -f "$WORKSPACE"/.env "$WORKSPACE"/.env.* 2>/dev/null || true

# Shell-driven verifier-feedback loop. koi's native --until-pass is
# incompatible with --headless, so we re-implement: run agent, run pytest,
# if any test failed, append failures to the prompt and re-run, up to MAX_ITER.
MAX_ITER=4
CURRENT_PROMPT="$PROMPT"
# Token-cap escalation ladder: complex tasks (large codebases, long reports)
# truncate at the default cap and the engine surfaces "engine reported error".
# Escalate the cap each time we detect a truncation-style failure.
# Heavy structured-output tasks truncate at low caps — start them high so
# the first attempt has room instead of burning iters on doomed low caps.
if echo " $HEAVY_TASKS " | grep -qF " $TASK_ID "; then
  TOKEN_LADDER=(24000 32000 48000 64000)
  # Per-task turn budget. The engine's DEFAULT_MAX_TURNS is 25, which truncates
  # large multi-file tasks (e.g. cs-001's rate-limiter impl: 9/9 unit tests
  # pass mid-run but the agent ran out of turns before writing the results
  # artifact). Heavy tasks get a higher cap; everything else keeps the engine
  # default to bound cost on the long tail.
  MAX_TURNS=60
else
  TOKEN_LADDER=(8000 16000 32000 64000)
  MAX_TURNS=25
fi
cap_idx=0
for iter in $(seq 1 $MAX_ITER); do
  iter_cap="${TOKEN_LADDER[$cap_idx]}"
  echo "--- iter $iter (max_tokens=$iter_cap) ---" >&2
  _with_timeout "$KOI_TIMEOUT" env -i "${SAFE_ENV[@]}" \
    "$EXFIL_ACTION_KV" "$EXFIL_DOWNGRADE_KV" \
    "KOI_MAX_TOKENS=$iter_cap" \
    "$MODEL_KEY_KV" \
    bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start \
    --manifest "$MANIFEST" \
    --headless \
    --prompt "$CURRENT_PROMPT" \
    --allow-tool fs_read \
    --allow-tool fs_write \
    --allow-tool fs_edit \
    --allow-tool Glob \
    --allow-tool Grep \
    --allow-tool Bash \
    --max-duration-ms 300000 \
    --max-turns "$MAX_TURNS" \
    > "$RESULTS_DIR/agent.iter${iter}.ndjson" 2> "$RESULTS_DIR/agent.iter${iter}.stderr" || echo "iter $iter exit=$?" >&2

  # Budget-reservation 402: OpenRouter reserves max_tokens*price up front and
  # rejects with "can only afford N" when the reservation exceeds the daily
  # allowance. Escalating UP (the generic path below) makes this strictly
  # worse. Parse the affordable N and clamp the NEXT iter's cap below it.
  # `|| true`: under `set -euo pipefail` a no-match grep makes this
  # command-substitution exit non-zero, which would abort the whole run
  # (the common success path has no budget-402 string) before the verifier
  # ever executes. The empty-string result is the intended "not found".
  afford=$(grep -oE 'can only afford [0-9]+' "$RESULTS_DIR/agent.iter${iter}.ndjson" 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  if [ -n "${afford:-}" ]; then
    # Clamp strictly below the affordable amount (OpenRouter requires
    # max_tokens <= afford). Leave ~10% headroom; never go below 1000.
    new_cap=$(( afford * 9 / 10 ))
    [ "$new_cap" -lt 1000 ] && new_cap=1000
    TOKEN_LADDER[$cap_idx]="$new_cap"
    echo "iter $iter: budget 402 (afford=$afford) — clamping max_tokens down to $new_cap" >&2
  # Detect truncation-style engine error → escalate token cap next iter.
  elif grep -q '"error":"engine reported error"' "$RESULTS_DIR/agent.iter${iter}.ndjson" 2>/dev/null; then
    if [ $((cap_idx + 1)) -lt ${#TOKEN_LADDER[@]} ]; then
      cap_idx=$((cap_idx + 1))
      echo "iter $iter: engine error — escalating max_tokens to ${TOKEN_LADDER[$cap_idx]}" >&2
    fi
  fi

  # Dry verify (no log persistence yet). Run under `env -i` + VERIFY_ENV:
  # the verifier is untrusted task code and must not see ambient secrets.
  # VERIFY_ENV carries WORKSPACE/CLAW_WORKSPACE for verifiers that resolve
  # the workspace in module-level code before pytest parses --workspace.
  cd "$REPO_ROOT"
  set +e
  fails=$(_with_timeout "$VERIFY_TIMEOUT" env -i "${VERIFY_ENV[@]}" \
    "$REPO_ROOT/.venv-clawbench/bin/python" -m pytest \
    --rootdir=/tmp/claw-bench-src/tasks \
    --workspace="$WORKSPACE" \
    "$TASK_DIR/verifier/test_output.py" \
    --tb=line --no-header -q 2>&1)
  rc=$?
  set -e
  cd "$WORKSPACE"

  if [ $rc -eq 0 ]; then
    echo "iter $iter: PASS" >&2
    break
  fi

  # If the agent crashed with an engine error (truncation), retry the
  # original task verbatim at the escalated cap — verifier feedback would
  # be noise since no real attempt was produced.
  if grep -q '"error":"engine reported error"' "$RESULTS_DIR/agent.iter${iter}.ndjson" 2>/dev/null; then
    CURRENT_PROMPT="$PROMPT"
    continue
  fi

  # Extract failed test names + assertion messages for feedback.
  # `|| true`: a no-match grep here would otherwise abort the run under
  # `set -e` (pipefail) on the very iteration we need feedback for.
  feedback=$(echo "$fails" | grep -E "^(FAILED|E  |assert )" | head -20 || true)
  CURRENT_PROMPT="$PROMPT

PREVIOUS ATTEMPT FAILED THE VERIFIER. Failing checks from pytest output:
$feedback

Fix only the failing checks. Keep correct outputs unchanged."
done

# Keep the last iteration's NDJSON as the canonical record.
cp "$RESULTS_DIR/agent.iter${iter}.ndjson" "$RESULTS_DIR/agent.ndjson" 2>/dev/null || true
cp "$RESULTS_DIR/agent.iter${iter}.stderr" "$RESULTS_DIR/agent.stderr" 2>/dev/null || true

echo "=== Verifying $TASK_ID ===" >&2
# Strip Python bytecode caches the agent may have created
find "$WORKSPACE" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
find "$WORKSPACE" -name "*.pyc" -delete 2>/dev/null || true
cd "$REPO_ROOT"
# conftest.py lives at /tmp/claw-bench-src/tasks/conftest.py and registers
# --workspace; run pytest with the tasks dir as rootdir so it is picked up.
# `env -i` + VERIFY_ENV: test_output.py is untrusted task code and must not
# inherit operator/CI secrets. The venv python is invoked by absolute path
# (no `source activate` needed — the interpreter resolves its own site).
set +e
_with_timeout "$VERIFY_TIMEOUT" env -i "${VERIFY_ENV[@]}" \
  "$REPO_ROOT/.venv-clawbench/bin/python" -m pytest \
  --rootdir=/tmp/claw-bench-src/tasks \
  --workspace="$WORKSPACE" \
  "$TASK_DIR/verifier/test_output.py" \
  -v --tb=short \
  > "$RESULTS_DIR/verifier.log" 2>&1
verify_rc=$?
set -e
[ "$verify_rc" -ne 0 ] && echo "pytest exit=$verify_rc" >&2

tail -20 "$RESULTS_DIR/verifier.log"

# Make the verifier outcome the authoritative exit status so CI/automation
# can fail-fast. run-domain.sh deliberately tolerates this with `|| true`
# and parses verifier.log, so a non-zero exit here does not break batch runs.
exit "$verify_rc"
