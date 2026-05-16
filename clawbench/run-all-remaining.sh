#!/usr/bin/env bash
# Run every ClawBench domain that does not yet have a SUMMARY-<domain>.txt.
# Sequential — one domain at a time — to stay within OpenRouter daily limits.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_ROOT="/tmp/claw-bench-src/tasks"
PROGRESS="$REPO_ROOT/clawbench/results/ALL-PROGRESS.txt"

mkdir -p "$REPO_ROOT/clawbench/results"
: > "$PROGRESS"

for d in "$TASKS_ROOT"/*/; do
  domain=$(basename "$d")
  [ "$domain" = "_schema" ] && continue
  [ "$domain" = "__pycache__" ] && continue

  summary="$REPO_ROOT/clawbench/results/SUMMARY-$domain.txt"
  if [ -f "$summary" ]; then
    echo "SKIP $domain (already has summary)" | tee -a "$PROGRESS"
    continue
  fi

  echo ">>> START $domain ($(date +%H:%M:%S))" | tee -a "$PROGRESS"
  "$REPO_ROOT/clawbench/run-domain.sh" "$domain" >> "$PROGRESS" 2>&1 || \
    echo "  domain $domain exited non-zero" | tee -a "$PROGRESS"
  echo "<<< DONE  $domain ($(date +%H:%M:%S))" | tee -a "$PROGRESS"
done

echo "=== ALL REMAINING DOMAINS COMPLETE ===" | tee -a "$PROGRESS"
