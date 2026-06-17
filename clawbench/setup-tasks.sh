#!/usr/bin/env bash
# Populate the ClawBench task source tree that the run-*.sh scripts read from.
#
# Source of truth: the koi-maintained fork of claw-bench, which carries the
# reference-solution fixes (the upstream claw-bench tasks ship broken oracles —
# 84/319 reference solutions failed their own verifiers). Override with env:
#
#   CLAWBENCH_REPO  git URL to clone           (default: koi-maintained fork)
#   CLAWBENCH_REF   branch/tag/sha to check out (default: main)
#   CLAWBENCH_SRC   destination checkout dir    (default: /tmp/claw-bench-src)
#
# Idempotent: re-running fetches and resets to the requested ref.
set -euo pipefail

CLAWBENCH_REPO="${CLAWBENCH_REPO:-https://github.com/JingW6/claw-bench.git}"
CLAWBENCH_REF="${CLAWBENCH_REF:-main}"
CLAWBENCH_SRC="${CLAWBENCH_SRC:-/tmp/claw-bench-src}"

if [ -d "$CLAWBENCH_SRC/.git" ]; then
  echo "Updating $CLAWBENCH_SRC ($CLAWBENCH_REPO @ $CLAWBENCH_REF)" >&2
  git -C "$CLAWBENCH_SRC" remote set-url origin "$CLAWBENCH_REPO"
  git -C "$CLAWBENCH_SRC" fetch --depth 1 origin "$CLAWBENCH_REF"
  git -C "$CLAWBENCH_SRC" checkout -B "$CLAWBENCH_REF" FETCH_HEAD
else
  echo "Cloning $CLAWBENCH_REPO @ $CLAWBENCH_REF -> $CLAWBENCH_SRC" >&2
  git clone --depth 1 --branch "$CLAWBENCH_REF" "$CLAWBENCH_REPO" "$CLAWBENCH_SRC"
fi

echo "$CLAWBENCH_SRC"
