#!/usr/bin/env bash
# Run all tasks in a ClawBench domain and aggregate scores.
# Usage: clawbench/run-domain.sh <domain>   (e.g. file-operations)
set -uo pipefail

DOMAIN="${1:?domain required (e.g. file-operations)}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_DOMAIN_DIR="/tmp/claw-bench-src/tasks/$DOMAIN"
SUMMARY="$REPO_ROOT/clawbench/results/SUMMARY-$DOMAIN.txt"
# Write progress to a temp file and only promote it to the canonical
# SUMMARY-<domain>.txt atomically once every task in the domain has been
# processed. This prevents an interrupted/aborted run from leaving a partial
# summary that run-all-remaining.sh would treat as "domain complete" forever.
SUMMARY_TMP="$SUMMARY.partial.$$"

if [ ! -d "$TASKS_DOMAIN_DIR" ]; then
  echo "Domain not found: $TASKS_DOMAIN_DIR" >&2
  exit 1
fi

mkdir -p "$REPO_ROOT/clawbench/results"
trap 'rm -f "$SUMMARY_TMP"' EXIT
: > "$SUMMARY_TMP"

domain_failures=0
for task_dir in "$TASKS_DOMAIN_DIR"/*/; do
  [ -d "$task_dir" ] || continue
  task_dir="${task_dir%/}"
  id=$(basename "$task_dir")
  echo ">>> $id" >&2
  # run-task.sh's exit status is authoritative (it exits with the verifier's
  # pytest rc). Capture it instead of swallowing it with `|| true`.
  if "$REPO_ROOT/clawbench/run-task.sh" "$task_dir" > /dev/null 2>&1; then
    task_rc=0
  else
    task_rc=$?
  fi

  log="$REPO_ROOT/clawbench/results/$id/verifier.log"
  if [ -f "$log" ]; then
    summary=$(grep -E "passed|failed|error" "$log" | tail -1 | tr -s ' ')
    echo "$id  $summary" | tee -a "$SUMMARY_TMP"
  else
    echo "$id  NO_VERIFIER_LOG" | tee -a "$SUMMARY_TMP"
  fi

  # A task failed if run-task.sh returned non-zero (verifier failed/crashed)
  # or produced no verifier log at all.
  if [ "$task_rc" -ne 0 ] || [ ! -f "$log" ]; then
    domain_failures=$((domain_failures + 1))
  fi
done

if [ "$domain_failures" -eq 0 ]; then
  # Lone "===" sentinel marks a fully-passing, fully-processed domain.
  # run-all-remaining.sh skips a domain ONLY when its summary ends in this
  # exact line, so it is never written when any task failed.
  echo "===" >> "$SUMMARY_TMP"
else
  # Distinct terminal line (NOT the bare "===" sentinel): run-all-remaining.sh
  # will reprocess this domain on the next pass instead of skipping it
  # forever with its failures hidden behind a false-complete summary.
  echo "=== INCOMPLETE: $domain_failures task(s) failed ===" >> "$SUMMARY_TMP"
fi
# Atomic promote: results are visible, but completion is encoded in the
# terminal line above, not in the file's mere existence.
mv -f "$SUMMARY_TMP" "$SUMMARY"
trap - EXIT
cat "$SUMMARY"

if [ "$domain_failures" -gt 0 ]; then
  echo "run-domain.sh: $DOMAIN had $domain_failures failing task(s)" >&2
  exit 1
fi
