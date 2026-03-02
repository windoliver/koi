import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ResolvedWorkspaceConfig, WorkspaceBackend } from "@koi/core";
import { agentId } from "@koi/core";
import type { TempGitRepo } from "@koi/test-utils";
import { createTempGitRepo } from "@koi/test-utils";
import { createGitWorktreeBackend } from "./git-backend.js";
import { pruneStaleWorkspaces } from "./prune.js";

const DEFAULT_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "on_success",
  cleanupTimeoutMs: 5_000,
};

describe("pruneStaleWorkspaces", () => {
  let repo: TempGitRepo;
  let backend: WorkspaceBackend;

  beforeEach(async () => {
    repo = await createTempGitRepo();
    const result = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!result.ok) throw new Error(`Backend creation failed: ${result.error.message}`);
    backend = result.value;
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("returns empty result when no worktrees exist", async () => {
    const result = await pruneStaleWorkspaces(repo.repoPath);
    expect(result.pruned.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("does not prune workspace with alive process", async () => {
    // Create a workspace — its PID is the current process (alive)
    await backend.create(agentId("agent-1"), DEFAULT_CONFIG);

    const result = await pruneStaleWorkspaces(repo.repoPath);
    // Should not prune because our PID is still alive and age < maxAge
    expect(result.pruned.length).toBe(0);
  });

  it("prunes workspace exceeding maxAgeMs", async () => {
    await backend.create(agentId("agent-1"), DEFAULT_CONFIG);

    // Prune with maxAgeMs=0 so everything is "stale"
    const result = await pruneStaleWorkspaces(repo.repoPath, { maxAgeMs: 0 });
    expect(result.pruned.length).toBe(1);
    expect(result.errors.length).toBe(0);
  });

  it("dryRun reports but does not remove", async () => {
    const createResult = await backend.create(agentId("agent-1"), DEFAULT_CONFIG);
    if (!createResult.ok) throw new Error("create failed");

    const result = await pruneStaleWorkspaces(repo.repoPath, { maxAgeMs: 0, dryRun: true });
    expect(result.pruned.length).toBe(1);

    // Workspace should still exist
    const { existsSync } = await import("node:fs");
    expect(existsSync(createResult.value.path)).toBe(true);
  });

  it("returns error for invalid repo path", async () => {
    const result = await pruneStaleWorkspaces("/nonexistent/repo");
    expect(result.pruned.length).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});
