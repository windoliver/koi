/**
 * Skill component for workspace isolation — teaches agents workspace lifecycle concepts.
 *
 * L2 — imports from @koi/core only.
 */

import type { SkillComponent } from "@koi/core";

/** Skill component name. */
export const WORKSPACE_SKILL_NAME = "workspace" as const;

/**
 * Markdown content teaching agents workspace isolation concepts.
 * Injected into the agent's context alongside the WORKSPACE component.
 */
export const WORKSPACE_SKILL_CONTENT: string = `
# Workspace — isolated execution environment

## Overview

A workspace provides an isolated filesystem environment for your work. When attached,
you operate in a dedicated directory separate from other agents and the host system.
The workspace backend determines the isolation mechanism (git worktree, Docker container,
temporary directory, etc.).

## How workspaces work

- On agent startup, the workspace provider creates an isolated environment
- Your filesystem operations (reads, writes, edits) happen within this workspace
- Other agents cannot access your workspace — each gets their own
- On agent termination, the workspace is cleaned up according to the cleanup policy

## Cleanup policies

The workspace lifecycle is controlled by the cleanup policy:

- **always**: workspace is deleted when the agent terminates, regardless of outcome.
  Best for stateless, repeatable tasks
- **on_success**: workspace is deleted only if the agent terminates successfully.
  Failed runs preserve the workspace for debugging and inspection
- **never**: workspace is always preserved after termination. Useful for audit trails
  or when manual inspection is required

## Backend strategies

Workspace isolation can use different backends:

- **Git worktree**: creates a new git worktree branch — fast, lightweight, supports
  full git operations within the workspace
- **Docker container**: runs in an isolated container — strongest isolation, supports
  custom images and resource limits
- **Temporary directory**: simple temp directory — minimal overhead, no VCS integration

## Working within a workspace

- **File paths are relative to the workspace root**: your working directory is the
  workspace, not the host project root
- **Git operations work normally**: if using a git worktree backend, you can commit,
  branch, and push from within the workspace
- **Changes are isolated**: modifications do not affect other agents or the main branch
  until explicitly merged

## Error handling

- **Creation failure**: the backend could not create the workspace — check that the
  backend is properly configured and has necessary permissions
- **Cleanup failure**: workspace disposal timed out or failed — the workspace may be
  preserved on disk and require manual cleanup
- **postCreate hook failure**: if a post-creation setup hook fails, the workspace is
  automatically disposed to avoid orphaned state
`.trim();

/**
 * Pre-built SkillComponent for workspace isolation guidance.
 * Attached automatically by createWorkspaceProvider alongside the WORKSPACE component.
 */
export const WORKSPACE_SKILL: SkillComponent = {
  name: WORKSPACE_SKILL_NAME,
  description:
    "Workspace isolation concepts, cleanup policies, backend strategies, and lifecycle management",
  content: WORKSPACE_SKILL_CONTENT,
  tags: ["workspace", "isolation", "lifecycle"],
} as const satisfies SkillComponent;
