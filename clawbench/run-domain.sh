#!/usr/bin/env bash
# Run all tasks in a ClawBench domain and aggregate scores.
# Usage: clawbench/run-domain.sh <domain>   (e.g. file-operations)
set -uo pipefail

DOMAIN="${1:?domain required (e.g. file-operations)}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DOMAIN_DIR="/tmp/claw-bench-src/tasks/$DOMAIN"
SUMMARY="$REPO_ROOT/clawbench/results/SUMMARY-$DOMAIN.txt"

if [ ! -d "$TASKS_DOMAIN_DIR" ]; then
  echo "Domain not found: $TASKS_DOMAIN_DIR" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/clawbench/results"
: > "$SUMMARY"

for task_dir in "$TASKS_DOMAIN_DIR"/*/; do
  [ -d "$task_dir" ] || continue
  task_dir="${task_dir%/}"
  id=$(basename "$task_dir")
  echo ">>> $id" >&2
  "$REPO_ROOT/clawbench/run-task.sh" "$task_dir" > /dev/null 2>&1 || true

  log="$REPO_ROOT/clawbench/results/$id/verifier.log"
  if [ -f "$log" ]; then
    summary=$(grep -E "passed|failed|error" "$log" | tail -1 | tr -s ' ')
    echo "$id  $summary" | tee -a "$SUMMARY"
  else
    echo "$id  NO_VERIFIER_LOG" | tee -a "$SUMMARY"
  fi
done

echo "===" | tee -a "$SUMMARY"
