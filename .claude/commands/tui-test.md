---
name: tui-test
description: Launch koi tui in tmux, send a test prompt, capture output, and verify the response. Use for E2E validation of features that affect model behavior (skills, system prompts, middleware).
allowed-tools: Bash Read Write Edit Glob Grep
---

# TUI E2E Test via tmux

You are running an end-to-end test of the `koi tui` interactive terminal through tmux. This validates that features affecting model behavior (skills, system prompts, middleware) actually work in the live TUI.

## Arguments

``

- First argument: the test prompt to send (required)
- `--skill <path>`: optional path to a SKILL.md to install before testing
- `--expect <text>`: optional text that must appear in the response
- `--no-cleanup`: keep the tmux session alive after the test (for manual inspection)

If no arguments are provided, ask the user what to test.

## Prerequisites

Before launching the TUI, ensure:

1. **Worktree**: You MUST be in a worktree (not the main repo root). If `basename "$PWD"` is `koi`, stop and tell the user to create a worktree first.
2. **`.env` symlink**: The worktree needs API keys. Check if `.env` exists; if not, find the main repo root via `git worktree list` and symlink:
   ```bash
   MAIN_ROOT=$(git worktree list | head -1 | awk '{print $1}')
   ln -s "${MAIN_ROOT}/.env" .env
   ```
3. **Build**: Run `bun run build` — the TUI loads from built dist files. If build fails, diagnose and fix before proceeding.
4. **tmux**: Verify tmux is available (`which tmux`).

## Protocol

### Step 1: Setup

```bash
WORKTREE=$(basename "$PWD")
SESSION="${WORKTREE}-tui-test"
```

If `--skill` is provided, install the skill:
```bash
mkdir -p ~/.claude/skills/<skill-name>
cp <skill-path> ~/.claude/skills/<skill-name>/SKILL.md
```

### Step 2: Launch TUI

Kill any existing test session, then launch:
```bash
tmux kill-session -t "${SESSION}" 2>/dev/null
sleep 1
tmux new-session -d -s "${SESSION}" -x 120 -y 40 \
  "bun run packages/meta/cli/src/bin.ts tui; sleep 30"
sleep 5
```

Verify the TUI started by capturing the pane:
```bash
tmux capture-pane -t "${SESSION}" -p | tail -3
```

Expected: `Type a message... (/ for commands)` in the output. If not present, check stderr and diagnose.

### Step 3: Send prompt and capture

```bash
tmux send-keys -t "${SESSION}" "<prompt text>" Enter
sleep 10
tmux capture-pane -t "${SESSION}" -p
```

If the response is still streaming (shows `streaming…` in the status bar), wait 5 more seconds and re-capture.

### Step 4: Validate

1. Print the captured response
2. If `--expect` was provided, check that the expected text appears in the output
3. Report PASS or FAIL with the evidence

**If FAIL — enter the fix loop (Step 4b).**

### Step 4b: Fix loop (on failure)

When a test fails, do NOT just report it. Diagnose and fix:

1. **Build failure** (Step 2 — TUI didn't start): read the error, fix the source code, rebuild (`bun run build`), and retry from Step 2.
2. **No response** (Step 3 — TUI started but model returned nothing): check `.env` symlink, API key availability, stderr output. Fix and retry from Step 2.
3. **Wrong response** (Step 4 — response doesn't match `--expect`):
   - Check if the feature is wired into the TUI. Read `packages/meta/cli/src/tui-command.ts` to see if the relevant middleware/provider/skill is hooked up.
   - If not wired: wire it into `tui-command.ts`, rebuild, and retry from Step 2.
   - If wired but not working: read the middleware/provider code, add debug logging, diagnose, fix, rebuild, and retry from Step 2.
4. **Skill not discovered** (model doesn't see skill content): verify `createSkillsRuntime()` discovers the skill by running a quick inline check:
   ```bash
   bun -e 'import{createSkillsRuntime}from"@koi/skills-runtime";const r=await createSkillsRuntime().discover();console.log(r.ok?Object.fromEntries(r.value):r.error)'
   ```
   Fix discovery path issues and retry.

**Repeat the fix loop until the test passes. Maximum 5 attempts.** After 5 failures, report what was tried and what's still broken.

### Step 5: Cleanup

Unless `--no-cleanup` was specified:

```bash
tmux kill-session -t "${SESSION}" 2>/dev/null
```

If a skill was installed in Step 1, remove it:
```bash
rm -rf ~/.claude/skills/<skill-name>
```

## Output format

```
══════════════════════════════════════
  TUI E2E TEST
  Worktree: <name>
  Prompt: "<prompt>"
  Skill: <skill name or "none">
  Attempts: <N>
══════════════════════════════════════

--- Response ---
<captured model response>

--- Result ---
<PASS | FAIL>: <reason>
══════════════════════════════════════
```

## Example usage

```
/tui-test "What are the primary colors?" --skill ./my-skill/SKILL.md --expect "bullet"
/tui-test "Hello" --no-cleanup
/tui-test "What is 2+2?"
```
