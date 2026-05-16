#!/usr/bin/env bash
# Run every ClawBench domain that does not yet have a SUMMARY-<domain>.txt.
# Sequential — one domain at a time — to stay within OpenRouter daily limits.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TASKS_ROOT="/tmp/claw-bench-src/tasks"
PROGRESS="$REPO_ROOT/clawbench/results/ALL-PROGRESS.txt"

mkdir -p "$REPO_ROOT/clawbench/results"
: > "$PROGRESS"

# Treat a missing/empty task source as a hard error — otherwise this script
# would loop zero times and still report "COMPLETE", masking a checkout/infra
# regression with a false green.
if [ ! -d "$TASKS_ROOT" ]; then
  echo "FATAL: task source not found: $TASKS_ROOT" | tee -a "$PROGRESS" >&2
  exit 1
fi
shopt -s nullglob
_domain_dirs=("$TASKS_ROOT"/*/)
shopt -u nullglob
if [ "${#_domain_dirs[@]}" -eq 0 ]; then
  echo "FATAL: no domain directories under $TASKS_ROOT" | tee -a "$PROGRESS" >&2
  exit 1
fi

failed_domains=0
for d in "${_domain_dirs[@]}"; do
  domain=$(basename "$d")
  [ "$domain" = "_schema" ] && continue
  [ "$domain" = "__pycache__" ] && continue

  summary="$REPO_ROOT/clawbench/results/SUMMARY-$domain.txt"
  # Only skip a domain whose summary is COMPLETE: run-domain.sh writes the
  # summary atomically and terminates it with a lone "===" sentinel line.
  # A missing file or one without the sentinel means the domain was never
  # finished, so it must be (re)processed rather than silently skipped.
  if [ -f "$summary" ] && [ "$(tail -1 "$summary" 2>/dev/null)" = "===" ]; then
    echo "SKIP $domain (already has complete summary)" | tee -a "$PROGRESS"
    continue
  fi

  echo ">>> START $domain ($(date +%H:%M:%S))" | tee -a "$PROGRESS"
  if "$REPO_ROOT/clawbench/run-domain.sh" "$domain" >> "$PROGRESS" 2>&1; then
    echo "<<< DONE  $domain ($(date +%H:%M:%S))" | tee -a "$PROGRESS"
  else
    rc=$?
    failed_domains=$((failed_domains + 1))
    echo "<<< FAIL  $domain (exit $rc) ($(date +%H:%M:%S))" | tee -a "$PROGRESS"
  fi
done

if [ "$failed_domains" -gt 0 ]; then
  echo "=== INCOMPLETE: $failed_domains domain(s) failed ===" | tee -a "$PROGRESS" >&2
  exit 1
fi
echo "=== ALL REMAINING DOMAINS COMPLETE ===" | tee -a "$PROGRESS"
