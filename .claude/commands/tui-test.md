---
name: tui-test
description: Automatically test the current branch's changes in koi tui via tmux. Detects what changed, designs a test, runs it, and fixes bugs until it passes.
allowed-tools: Bash Read Write Edit Glob Grep Agent
---

# TUI E2E Test — Current Branch

You are testing the current branch's changes end-to-end in `koi tui` via tmux. Your job: figure out what changed, design a test that exercises it, run the test, and fix any bugs until it passes.

## Step 1: Detect what changed

```bash
MERGE_BASE=$(git merge-base HEAD main)
git diff --name-only "${MERGE_BASE}...HEAD"
```

Read the changed files to understand what feature/fix this branch introduces. Focus on:
- New or modified middleware → test that it affects model behavior
- New or modified tools → test that the tool appears and can be invoked
- New or modified skills → test that skill content reaches the model
- TUI wiring changes → test that the TUI starts and responds correctly
- Bug fixes → test the scenario that was broken

If the changes don't affect TUI behavior (e.g., pure L0 type changes, test-only changes), report "No TUI-visible changes on this branch" and stop.

## Step 2: Design the test

Based on your analysis, decide:
1. **Prompt**: What to send to the TUI that would exercise the changed feature
2. **Expectation**: What the response must contain (or how it must be formatted) to prove the feature works
3. **Skill** (if needed): Whether a temporary SKILL.md needs to be installed to test the feature

Print your test plan:
```
Test plan:
  Feature: <what changed>
  Prompt: "<prompt>"
  Expect: <what proves it works>
  Skill: <skill name or "none">
```

## Step 3: Prerequisites

1. **Worktree check**: Verify you are in a worktree, not the main repo root:
   ```bash
   MAIN_ROOT=$(git worktree list | head -1 | awk '{print $1}')
   if [ "$PWD" = "$MAIN_ROOT" ]; then echo "ERROR: run from a worktree, not main"; exit 1; fi
   ```
2. **`.env`**: If `.env` doesn't exist, symlink from main:
   ```bash
   MAIN_ROOT=$(git worktree list | head -1 | awk '{print $1}')
   [ ! -f .env ] && ln -s "${MAIN_ROOT}/.env" .env
   ```
3. **Build**: `bun run build` — if it fails, fix the build error and retry.

## Step 4: Run the test

```bash
WORKTREE=$(basename "$PWD")
SESSION="${WORKTREE}-tui-test"

# Install temp skill if needed
# mkdir -p ~/.claude/skills/<name> && write SKILL.md

# Launch TUI
tmux kill-session -t "${SESSION}" 2>/dev/null
sleep 1
tmux new-session -d -s "${SESSION}" -x 120 -y 40 \
  "bun run packages/meta/cli/src/bin.ts tui; sleep 30"
sleep 5

# Verify TUI started
tmux capture-pane -t "${SESSION}" -p | tail -3
# Must contain: "Type a message..."

# Send prompt
tmux send-keys -t "${SESSION}" "<prompt>" Enter
sleep 10
tmux capture-pane -t "${SESSION}" -p
```

If still streaming (`streaming...` in status bar), wait 5 more seconds and re-capture.

## Step 5: Validate

Check if the response matches the expectation. Report result.

**If PASS** — go to Step 7.

**If FAIL** — go to Step 6.

## Step 6: Fix loop (max 5 attempts)

Do NOT just report failure. Diagnose and fix:

1. **TUI didn't start**: Read the build/runtime error. Fix source code. Rebuild. Retry from Step 4.
2. **No response / API error**: Check `.env` symlink and API key. Fix and retry.
3. **Feature not working**:
   - Check if the feature is wired into `packages/meta/cli/src/tui-command.ts`. If not, wire it.
   - Check if middleware/provider is being called. Add debug logging if needed.
   - Read the relevant source code, find the bug, fix it, rebuild, retry from Step 4.
4. **Skill not discovered**: Run discovery check:
   ```bash
   cd packages/meta/cli && bun -e 'import{createSkillsRuntime}from"@koi/skills-runtime";const r=await createSkillsRuntime().discover();console.log(r.ok?Object.fromEntries(r.value):r.error)'
   ```

After each fix: rebuild (`bun run build`) and retry from Step 4.

**After 5 failed attempts**, report what was tried and what remains broken.

## Step 7: Cleanup

```bash
tmux kill-session -t "${SESSION}" 2>/dev/null
```

Remove any temp skills installed in Step 4:
```bash
rm -rf ~/.claude/skills/<name>
```

## Step 8: Report

```
══════════════════════════════════════
  TUI E2E TEST
  Branch: <branch name>
  Feature: <what was tested>
  Prompt: "<prompt>"
  Attempts: <N>
══════════════════════════════════════

--- Response ---
<captured model response>

--- Result ---
<PASS | FAIL>: <reason>
══════════════════════════════════════
```
