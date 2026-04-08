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
2. **`.env` symlink**: The worktree needs API keys. Check if `.env` exists; if not, symlink it from the main repo:
   ```bash
   ln -s /Users/sophiawj/private/koi/.env .env
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
