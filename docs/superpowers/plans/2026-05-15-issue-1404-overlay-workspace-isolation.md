# Issue 1404 Overlay Workspace Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit git-worktree overlay API that redirects speculative writes into an isolated workspace and supports accept/reject lifecycle decisions.

**Architecture:** Keep the existing `WorkspaceBackend` contract intact and implement overlay behavior in `@koi/workspace`, beside the git backend that already owns worktree lifecycle. The overlay manager creates a worktree from the repo HEAD, records the base commit, lets callers write through the overlay path, rejects by disposing the worktree, and accepts by detecting base drift before copying overlay changes back to the real repo.

**Tech Stack:** Bun, bun:test, TypeScript 6 strict mode, existing `@koi/git-utils` git wrapper, node `fs/promises`.

---

### Task 1: Add Overlay Tests

**Files:**
- Create: `packages/ipc/workspace/src/overlay.test.ts`

- [x] Write failing tests for create, reject cleanup, accept merge, conflict detection, concurrent overlay isolation, and large file copy.
- [x] Run `bun test packages/lib/workspace/src/overlay.test.ts` and confirm the missing export/API failure.

### Task 2: Implement Overlay Manager

**Files:**
- Create: `packages/ipc/workspace/src/overlay.ts`
- Modify: `packages/ipc/workspace/src/index.ts`

- [x] Export `createGitWorktreeOverlayManager` and its public types.
- [x] Create overlays as git worktrees with metadata containing `baseCommit`, `branchName`, `repoPath`, and `path`.
- [x] Export `createOverlayFileSystem` so tool backends can redirect writes into an overlay while reads fall back to the real filesystem.
- [x] Implement `reject` as worktree cleanup.
- [x] Implement `accept` as conflict check followed by recursive copy from overlay to repo and cleanup.

### Task 3: Verify

**Files:**
- Test: `packages/ipc/workspace/src/overlay.test.ts`

- [x] Run `bun test packages/lib/workspace/src/overlay.test.ts`.
- [x] Run `bun run typecheck` from `packages/lib/workspace`.
- [x] Run `bun run build` from `packages/lib/workspace`.
