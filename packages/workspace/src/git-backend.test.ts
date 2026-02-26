import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AgentId } from "@koi/core";
import { agentId } from "@koi/core";
import type { TempGitRepo } from "@koi/test-utils";
import { createTempGitRepo } from "@koi/test-utils";
import { createGitWorktreeBackend } from "./git-backend.js";
import type { ResolvedWorkspaceConfig, WorkspaceBackend } from "./types.js";

const DEFAULT_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "on_success",
  cleanupTimeoutMs: 5_000,
};

describe("createGitWorktreeBackend", () => {
  it("returns error when repoPath does not exist", () => {
    const result = createGitWorktreeBackend({ repoPath: "/nonexistent/path" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("does not exist");
  });

  it("returns error when repoPath is not a git repo", async () => {
    const { makeTempDir } = await import("@koi/test-utils");
    const dir = await makeTempDir();
    try {
      const result = createGitWorktreeBackend({ repoPath: dir });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("not a git repository");
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns ok for a valid git repo", async () => {
    const repo = await createTempGitRepo();
    try {
      const result = createGitWorktreeBackend({ repoPath: repo.repoPath });
      expect(result.ok).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe("GitWorktreeBackend", () => {
  let repo: TempGitRepo;
  let backend: WorkspaceBackend;
  const aid: AgentId = agentId("test-agent-1");

  beforeEach(async () => {
    repo = await createTempGitRepo();
    const result = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!result.ok) throw new Error(`Backend creation failed: ${result.error.message}`);
    backend = result.value;
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe("create", () => {
    it("creates worktree with correct branch and path", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.path).toBeTruthy();
      expect(result.value.metadata.branchName).toBe(`workspace/${aid}`);
      expect(result.value.metadata.baseBranch).toBe("main");
    });

    it("workspace directory exists after create", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      if (!result.ok) throw new Error("create failed");

      expect(existsSync(result.value.path)).toBe(true);
    });

    it("marker file is written with correct metadata", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      if (!result.ok) throw new Error("create failed");

      const markerPath = `${result.value.path}/.koi-workspace`;
      expect(existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(await readFile(markerPath, "utf-8"));
      expect(marker.agentId).toBe(String(aid));
      expect(marker.pid).toBe(process.pid);
      expect(typeof marker.createdAt).toBe("number");
    });

    it("returns error when branch already exists", async () => {
      const first = await backend.create(aid, DEFAULT_CONFIG);
      expect(first.ok).toBe(true);

      // Second create with same agentId should fail (branch exists)
      const second = await backend.create(aid, DEFAULT_CONFIG);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe("CONFLICT");
    });

    it("custom branch pattern with agentId substitution", async () => {
      const customResult = createGitWorktreeBackend({
        repoPath: repo.repoPath,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional pattern for string replacement
        branchPattern: "koi-agent/${agentId}",
      });
      if (!customResult.ok) throw new Error("Backend creation failed");

      const result = await customResult.value.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.metadata.branchName).toBe(`koi-agent/${aid}`);
    });

    it("custom worktree base path", async () => {
      const customBase = `${repo.repoPath}/custom-workspaces`;
      const customResult = createGitWorktreeBackend({
        repoPath: repo.repoPath,
        worktreeBasePath: customBase,
      });
      if (!customResult.ok) throw new Error("Backend creation failed");

      const result = await customResult.value.create(aid, DEFAULT_CONFIG);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.path).toContain("custom-workspaces");
    });
  });

  describe("dispose", () => {
    it("removes worktree directory", async () => {
      const createResult = await backend.create(aid, DEFAULT_CONFIG);
      if (!createResult.ok) throw new Error("create failed");

      const disposeResult = await backend.dispose(createResult.value.id);
      expect(disposeResult.ok).toBe(true);
      expect(existsSync(createResult.value.path)).toBe(false);
    });

    it("returns error for unknown workspace ID", async () => {
      const result = await backend.dispose("unknown-id");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("isHealthy", () => {
    it("returns true for valid worktree", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      if (!result.ok) throw new Error("create failed");

      expect(backend.isHealthy(result.value.id)).toBe(true);
    });

    it("returns false for unknown workspace", () => {
      expect(backend.isHealthy("nonexistent")).toBe(false);
    });

    it("returns false after dispose", async () => {
      const result = await backend.create(aid, DEFAULT_CONFIG);
      if (!result.ok) throw new Error("create failed");

      await backend.dispose(result.value.id);
      expect(backend.isHealthy(result.value.id)).toBe(false);
    });
  });
});
