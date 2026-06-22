#!/usr/bin/env bash
# Run ClawBench quick test (20 tasks) and aggregate scores.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAWBENCH_SRC="${CLAWBENCH_SRC:-/tmp/claw-bench-src}"
TASKS_ROOT="$CLAWBENCH_SRC/tasks"
SUMMARY="$REPO_ROOT/clawbench/results/SUMMARY.txt"

# Ensure the task source tree exists (clones the koi-maintained fork on first run).
[ -d "$TASKS_ROOT" ] || CLAWBENCH_SRC="$CLAWBENCH_SRC" "$REPO_ROOT/clawbench/setup-tasks.sh" >/dev/null

QUICK_IDS=(
  file-002 code-002 eml-001 data-002 debug-001
  cal-006 doc-004 sys-004 sec-004 wfl-003 db-002 tool-002
  web-006 mem-005 xdom-001 plan-004 math-004
  code-014 debug-005 tool-005
)

mkdir -p "$REPO_ROOT/clawbench/results"
: > "$SUMMARY"

failures=0
for id in "${QUICK_IDS[@]}"; do
  # Find task dir. The corpus mixes two naming conventions: bare "<id>"
  # (e.g. data-002) and slug-suffixed "<id>-<slug>" (e.g. cal-006-...).
  # Match both, exact-id first, so validly-named tasks aren't skipped.
  task_dir=$(find "$TASKS_ROOT" -mindepth 2 -maxdepth 2 -type d \
    \( -name "$id" -o -name "${id}-*" \) | sort | head -1)
  if [ -z "$task_dir" ]; then
    echo "SKIP $id (not found)" | tee -a "$SUMMARY"
    failures=$((failures + 1))
    continue
  fi

  echo ">>> $id ($task_dir)" >&2
  # run-task.sh's exit status is authoritative (verifier pytest rc).
  if "$REPO_ROOT/clawbench/run-task.sh" "$task_dir" > /dev/null 2>&1; then
    task_rc=0
  else
    task_rc=$?
  fi

  log="$REPO_ROOT/clawbench/results/$(basename "$task_dir")/verifier.log"
  if [ -f "$log" ]; then
    # parse pytest summary line
    summary=$(grep -E "passed|failed|error" "$log" | tail -1 | tr -s ' ')
    echo "$id  $summary" | tee -a "$SUMMARY"
  else
    echo "$id  NO_VERIFIER_LOG" | tee -a "$SUMMARY"
  fi

  if [ "$task_rc" -ne 0 ] || [ ! -f "$log" ]; then
    failures=$((failures + 1))
  fi
done

echo "===" | tee -a "$SUMMARY"
echo "Summary written to $SUMMARY" >&2

# Make the aggregate outcome the authoritative exit status so automation
# consuming this script's exit code cannot get a false green.
if [ "$failures" -gt 0 ]; then
  echo "run-quick.sh: $failures task(s) failed/skipped" >&2
  exit 1
fi
