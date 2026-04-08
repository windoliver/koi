---
name: cleanup
description: >
  Clean up unused worktrees, merged local branches, and orphaned Codex broker
  processes. Use when the system feels slow, fseventsd is using too much memory,
  or after finishing a batch of PRs. Triggers on: "clean up", "free memory",
  "remove old worktrees", "prune branches", "kill orphaned processes".
allowed-tools: Bash Read Glob Grep
---

# System Cleanup

You are performing a system cleanup to free memory and reduce filesystem watcher overhead. Run all three phases, report findings, and ask for confirmation before destructive actions.

## Phase 1: Orphaned Codex Broker Processes

Codex broker processes (`app-server-broker.mjs`) persist after Claude Code sessions end. Find and kill orphaned ones.

1. List all broker processes:
   ```bash
   ps -eo pid,rss,command | grep app-server-broker | grep -v grep
   ```
2. For each broker, extract its `--cwd` directory and check if it still exists on disk.
3. Report how many brokers are running, how many point to missing directories, and their total RSS.
4. Kill brokers whose `--cwd` directory no longer exists:
   ```bash
   # Kill only brokers pointing to nonexistent dirs — parse --cwd from each process
   ```
5. If ALL brokers are orphaned (no active Claude sessions reference them), offer to `pkill -f app-server-broker.mjs` instead.

## Phase 2: Stale Git Worktrees

Identify worktrees that are safe to remove.

1. List all worktrees: `git worktree list`
2. For each non-main worktree, gather:
   - **Branch**: from worktree list output
   - **Last commit age**: `git -C <path> log -1 --format="%ar"`
   - **Merged status**: `git branch --merged main | grep <branch>`
   - **Uncommitted changes**: `git -C <path> status --short`
3. Classify each worktree:
   - **SAFE TO REMOVE**: branch is merged to main AND no uncommitted changes
   - **PROBABLY SAFE**: no commits in 12+ hours AND no uncommitted changes AND branch not merged
   - **HAS UNCOMMITTED WORK**: uncommitted changes present — warn user
   - **ACTIVE**: commits within last 2 hours — skip
4. Present a table with columns: Path | Branch | Last Activity | Merged? | Dirty? | Recommendation
5. Ask user to confirm before removing. Then for each confirmed worktree:
   ```bash
   git worktree remove <path>
   ```

## Phase 3: Merged Local Branches

Clean up local branches that have been merged to main.

1. List merged branches: `git branch --merged main | grep -v -E '^\*|main$'`
2. Filter out any branch currently checked out in a remaining worktree (from `git worktree list`).
3. Report the list and count.
4. Ask user to confirm, then delete:
   ```bash
   git branch -d <branch>  # safe delete — only works if merged
   ```

## Phase 4: Summary

After all phases, report:
- Brokers killed and estimated memory freed
- Worktrees removed
- Branches deleted
- Current `fseventsd` RSS (to confirm improvement):
  ```bash
  ps -eo pid,rss,%mem,comm | grep fseventsd | grep -v grep
  ```

## Rules

- NEVER force-delete branches (`git branch -D`) — only use safe delete (`git branch -d`)
- NEVER remove the main worktree
- NEVER remove worktrees with uncommitted changes without explicit user approval
- NEVER kill the current Claude Code process's own broker
- Always ask for confirmation before destructive actions
- Present findings clearly so the user can make informed decisions
