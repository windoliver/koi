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
  # Live task count from the (read-only) source, recomputed every pass so a
  # stale or partial summary cannot satisfy the check.
  shopt -s nullglob
  _task_dirs=("$d"*/)
  shopt -u nullglob
  live_task_count="${#_task_dirs[@]}"

  # Live CONTENT fingerprint, computed BYTE-IDENTICALLY to run-domain.sh
  # (paths relative to the domain dir via subshell cd; the absolute prefix /
  # trailing slash must not perturb the hash).
  live_fp=$( ( cd "${d%/}" 2>/dev/null \
      && find . -type f ! -name '*.pyc' \
        -not -path '*/__pycache__/*' -not -path '*/.pytest_cache/*' \
        -not -path '*/workspace/*' -print0 \
      | LC_ALL=C sort -z | xargs -0 shasum -a 256 2>/dev/null ) \
    | shasum -a 256 | cut -c1-16)

  # Skip a domain ONLY when its summary's terminal line is the structured
  # completion sentinel "=== COMPLETE tasks=<n> fp=<h> ===" AND BOTH <n> and
  # <h> match the live source (recomputed every pass). This defeats:
  #   - a bare/forged "===" line (old format or written by a hostile task)
  #   - a stale summary from a partial run (count/fp mismatch -> reprocess)
  #   - a same-cardinality task-set swap/reorder (fp mismatch -> reprocess)
  #   - an in-place task CONTENT edit (content fp changes -> reprocess)
  # Residual risk: a same-uid agent with shell access could still forge the
  # exact-correct line (the fp is derived from world-readable source files);
  # fully closing that requires OS-level sandboxing of the agent (container/
  # uid separation), out of scope for this shell harness. The fingerprint
  # eliminates accidental/partial/stale false-greens.
  if [ -f "$summary" ] && [ "$live_task_count" -gt 0 ]; then
    last_line=$(tail -1 "$summary" 2>/dev/null)
    expected="=== COMPLETE tasks=$live_task_count fp=$live_fp ==="
    if [ "$last_line" = "$expected" ]; then
      echo "SKIP $domain (complete: $live_task_count tasks, fp=$live_fp)" | tee -a "$PROGRESS"
      continue
    fi
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
