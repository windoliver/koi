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

# Load API keys (koi reads OPENROUTER_API_KEY or OPENAI_API_KEY, not ANTHROPIC_API_KEY)
set -a; source "$REPO_ROOT/.env"; set +a

# Prevent agent-invoked python from creating __pycache__/.pyc (verifiers flag these).
export PYTHONDONTWRITEBYTECODE=1

# Bench fixtures may contain mock credentials; demote exfil guard from block→warn
# so the agent can complete the task. Real prod runs leave this unset (block).
export KOI_EXFIL_ACTION="${KOI_EXFIL_ACTION:-warn}"

# Cap per-request output tokens to stay under OpenRouter daily limits.
# Most clawbench tasks need <8K tokens per turn; cap at 8K.
export KOI_MAX_TOKENS="${KOI_MAX_TOKENS:-8000}"

# Try setup.sh with workspace arg; some scripts ignore $1 and write to TASK_DIR/workspace.
# Always also copy environment/data directly as fallback to guarantee seeding.
bash "$TASK_DIR/environment/setup.sh" "$WORKSPACE" 2>&1 | tail -5 >&2 || true
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
else
  TOKEN_LADDER=(8000 16000 32000 64000)
fi
cap_idx=0
for iter in $(seq 1 $MAX_ITER); do
  iter_cap="${TOKEN_LADDER[$cap_idx]}"
  echo "--- iter $iter (max_tokens=$iter_cap) ---" >&2
  KOI_MAX_TOKENS="$iter_cap" bun run "$REPO_ROOT/packages/meta/cli/src/bin.ts" start \
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
    > "$RESULTS_DIR/agent.iter${iter}.ndjson" 2> "$RESULTS_DIR/agent.iter${iter}.stderr" || echo "iter $iter exit=$?" >&2

  # Budget-reservation 402: OpenRouter reserves max_tokens*price up front and
  # rejects with "can only afford N" when the reservation exceeds the daily
  # allowance. Escalating UP (the generic path below) makes this strictly
  # worse. Parse the affordable N and clamp the NEXT iter's cap below it.
  afford=$(grep -oE 'can only afford [0-9]+' "$RESULTS_DIR/agent.iter${iter}.ndjson" 2>/dev/null | grep -oE '[0-9]+' | head -1)
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

  # Dry verify (no log persistence yet)
  # Some upstream verifiers resolve the workspace from $WORKSPACE/$CLAW_WORKSPACE
  # in module-level code (before pytest parses --workspace), so a fixture-only
  # --workspace is not enough. Export both so that fallback finds real output.
  export WORKSPACE CLAW_WORKSPACE="$WORKSPACE"
  cd "$REPO_ROOT"
  set +e
  fails=$("$REPO_ROOT/.venv-clawbench/bin/python" -m pytest \
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

  # Extract failed test names + assertion messages for feedback
  feedback=$(echo "$fails" | grep -E "^(FAILED|E  |assert )" | head -20)
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
source .venv-clawbench/bin/activate
# conftest.py lives at /tmp/claw-bench-src/tasks/conftest.py and registers --workspace.
# Run pytest with the tasks dir as rootdir so conftest is picked up.
python -m pytest \
  --rootdir=/tmp/claw-bench-src/tasks \
  --workspace="$WORKSPACE" \
  "$TASK_DIR/verifier/test_output.py" \
  -v --tb=short \
  > "$RESULTS_DIR/verifier.log" 2>&1 || echo "pytest exit=$?" >&2

tail -20 "$RESULTS_DIR/verifier.log"
