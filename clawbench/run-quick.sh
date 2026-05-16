#!/usr/bin/env bash
# Run ClawBench quick test (20 tasks) and aggregate scores.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_ROOT="/tmp/claw-bench-src/tasks"
SUMMARY="$REPO_ROOT/clawbench/results/SUMMARY.txt"

QUICK_IDS=(
  file-002 code-002 eml-001 data-002 debug-001
  cal-006 doc-004 sys-004 sec-004 wfl-003 db-002 tool-002
  web-006 mem-005 xdom-001 plan-004 math-004
  code-014 debug-005 tool-005
)

mkdir -p "$REPO_ROOT/clawbench/results"
: > "$SUMMARY"

for id in "${QUICK_IDS[@]}"; do
  # Find task dir: tasks/*/{id}-*
  task_dir=$(find "$TASKS_ROOT" -mindepth 2 -maxdepth 2 -type d -name "${id}-*" | head -1)
  if [ -z "$task_dir" ]; then
    echo "SKIP $id (not found)" | tee -a "$SUMMARY"
    continue
  fi

  echo ">>> $id ($task_dir)" >&2
  "$REPO_ROOT/clawbench/run-task.sh" "$task_dir" > /dev/null 2>&1 || true

  log="$REPO_ROOT/clawbench/results/$(basename "$task_dir")/verifier.log"
  if [ -f "$log" ]; then
    # parse pytest summary line
    summary=$(grep -E "passed|failed|error" "$log" | tail -1 | tr -s ' ')
    echo "$id  $summary" | tee -a "$SUMMARY"
  else
    echo "$id  NO_VERIFIER_LOG" | tee -a "$SUMMARY"
  fi
done

echo "===" | tee -a "$SUMMARY"
echo "Summary written to $SUMMARY" >&2
