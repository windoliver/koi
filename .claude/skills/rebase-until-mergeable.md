---
name: rebase-until-mergeable
description: >
  Rebase the current branch onto origin/main, resolve every conflict, then loop
  fixing failing CI checks (lint, typecheck, tests, layer checks) until the
  remote PR is mergeable. Use when asked to "rebase and fix", "make this
  mergeable", "get this branch green", or "rebase until merge-ready".
---

# Rebase Until Mergeable

You are running a convergence loop: rebase the current branch onto `origin/main`, resolve conflicts, push, then iterate fixing CI failures until the PR is mergeable or the round cap is hit.

## Arguments

`$ARGUMENTS`

- `--rounds N` — max CI fix rounds (default: 8)
- `--base <ref>` — base branch (default: `origin/main`)
- `--no-push` — resolve locally only, do not push or watch CI
- Remaining text passed to commit messages as context if needed

## Pre-flight (run once)

1. Verify you are NOT on `main` and NOT in the bare repo:
   ```bash
   git rev-parse --abbrev-ref HEAD
   git rev-parse --show-toplevel
   ```
   Abort if branch is `main`/`master`. Print error and stop.

2. Verify clean working tree:
   ```bash
   git status --porcelain
   ```
   If dirty: stash with `git stash push -u -m "rebase-until-mergeable autosave"` and remember to pop at the end. Never discard user changes.

3. Capture branch + PR info:
   ```bash
   BRANCH=$(git rev-parse --abbrev-ref HEAD)
   gh pr view --json number,url,mergeable,mergeStateStatus,headRefName 2>/dev/null
   ```
   If no PR exists, that's fine — the loop still rebases and fixes locally.

4. Fetch base:
   ```bash
   git fetch origin main
   ```

## Phase 1: Rebase

Run the rebase:

```bash
git rebase origin/main
```

### Conflict resolution sub-loop

While `git status` reports `UU` / `AA` / `DD` / `AU` / `UA` / `UD` / `DU` paths:

1. List conflicted files: `git diff --name-only --diff-filter=U`
2. For each file:
   - Read it
   - Resolve markers (`<<<<<<<`, `=======`, `>>>>>>>`) by understanding both sides — never blindly pick one
   - For lockfiles (`bun.lock`, `package-lock.json`): regenerate, do NOT hand-edit
     - `bun.lock` → run `bun install` after resolving `package.json` files
   - For generated files (`*.d.ts`, build artifacts): regenerate via build, do NOT hand-edit
   - `git add <file>`
3. After all files resolved: `git rebase --continue`
4. If a commit becomes empty: `git rebase --skip`
5. NEVER run `git rebase --abort` unless the user explicitly asks — that throws away progress.

If the same conflict reappears across 3 commits in the same hunk, stop and surface to user — likely needs a strategy decision.

## Phase 2: Local Verification

Before pushing, run the project's gate (per `CLAUDE.md`):

```bash
bun run typecheck
bun run lint
bun run check:layers
bun run test
```

If any fail, fix them (see Fix Protocol below) and re-run before pushing. Do not push broken code.

## Phase 3: Push

```bash
git push --force-with-lease origin "$BRANCH"
```

- ALWAYS `--force-with-lease`, never bare `--force`. This refuses the push if someone else pushed in the meantime.
- If lease fails: `git fetch origin "$BRANCH"`, inspect the diff, ask the user before clobbering.
- Skip this phase if `--no-push` was passed.

## Phase 4: CI Convergence Loop

Skip if `--no-push` or no PR exists.

Round counter starts at 1. Print:

```
══════════════════════════════════════
  ROUND {N}/{MAX} — CI Fix
══════════════════════════════════════
```

### Step 1: Wait for checks

```bash
gh pr checks --watch --interval 30
```

This blocks until all checks complete.

### Step 2: Inspect mergeability

```bash
gh pr view --json mergeable,mergeStateStatus,statusCheckRollup
```

**EXIT conditions:**
- `mergeable` is `MERGEABLE` AND `mergeStateStatus` is `CLEAN` → print `MERGEABLE on round {N}` and stop
- Round counter equals max → print `ROUND CAP REACHED. Remaining failures:` list them, stop
- `mergeStateStatus` is `BLOCKED` purely due to required reviews (no failed checks) → print `CI green; awaiting review` and stop

### Step 3: Collect failures

For each failed check in `statusCheckRollup`:

```bash
gh run view <run-id> --log-failed
```

Extract the actual errors (skip ANSI noise, focus on `error:`, `FAIL`, stack traces, file:line).

### Step 4: Fix Protocol

For each failure, in this order of preference:

| Failure type | Action |
|--------------|--------|
| Type error | Read file, fix types — never use `any`, `as`, or `!` (banned per CLAUDE.md) |
| Lint error | Apply Biome fix: `bun run lint --apply` if available, else hand-fix |
| Layer violation | Move import to correct layer; never weaken `check:layers` |
| Test failure | Read test, read code, fix root cause — never delete or skip the test |
| Coverage drop | Add tests for uncovered lines |
| Build/install | Re-run `bun install`, check `bunfig.toml`, never mutate lockfile in CI |
| Flaky/infra | Re-run once via `gh run rerun <id> --failed`. If still flaky, surface to user — do not mask |

After fixes:
1. Re-run the relevant local check (`bun run test --filter=<package>`, etc.) to confirm fix
2. Commit: `git commit -am "fix(ci): <short summary>"` — concrete, not "fix CI"
3. `git push --force-with-lease origin "$BRANCH"` (no force-with-lease needed for fast-forward — use plain `git push`)

### Step 5: Increment and loop

Increment round counter, go to Step 1.

## Hard Rules

- NEVER `git push --force` (always `--force-with-lease`)
- NEVER `git rebase --abort` without user approval
- NEVER `git reset --hard` to "fix" rebase state
- NEVER skip hooks (`--no-verify`)
- NEVER weaken or delete tests, lints, or layer checks to make CI pass — fix the root cause
- NEVER use banned TS constructs (`any`, `as`, `!`, `enum`, `namespace`) when fixing type errors
- NEVER commit `.env`, credentials, or `bun.lockb` (binary)
- NEVER push to `main` or merge the PR yourself — only the user merges
- If the same finding recurs 3 rounds in a row on the same file+line, stop and surface — the fix isn't working

## Final Summary

```
══════════════════════════════════════
  REBASE-UNTIL-MERGEABLE COMPLETE
  Branch: {BRANCH}
  Rebased onto: {BASE}
  Conflicts resolved: {count}
  CI rounds: {N}/{MAX}
  Result: {MERGEABLE | AWAITING-REVIEW | CAPPED | ABORTED}
  Final PR state: {url}
══════════════════════════════════════
```

Pop any autosaved stash before exiting:
```bash
git stash list | grep -q "rebase-until-mergeable autosave" && git stash pop
```
