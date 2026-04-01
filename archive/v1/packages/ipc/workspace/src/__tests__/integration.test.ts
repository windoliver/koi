/**
 * Integration tests — full lifecycle with real git backend.
 *
 * Creates a real git repo, attaches a workspace via the provider,
 * verifies the component, and tests cleanup on detach.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import type { Agent, AttachResult, WorkspaceComponent } from "@koi/core";
import { agentId, isAttachResult, WORKSPACE } from "@koi/core";
import type { TempGitRepo } from "@koi/test-utils";
import { createMockAgent, createTempGitRepo } from "@koi/test-utils";
import { createGitWorktreeBackend } from "../git-backend.js";
import { createWorkspaceProvider } from "../provider.js";

const WORKSPACE_KEY: string = WORKSPACE;

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

function getWorkspaceComponent(components: ReadonlyMap<string, unknown>): WorkspaceComponent {
  const ws = components.get(WORKSPACE_KEY);
  if (!ws) throw new Error("WORKSPACE component not found");
  return ws as WorkspaceComponent;
}

describe("workspace integration", () => {
  let repo: TempGitRepo;

  beforeEach(async () => {
    repo = await createTempGitRepo();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it("full lifecycle: attach → verify component → detach → cleanup", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "always",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("integration-agent") },
      state: "running",
    });

    // Attach
    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    expect(ws).toBeDefined();
    expect(ws.path).toBeTruthy();
    expect(existsSync(ws.path)).toBe(true);
    expect(ws.metadata.branchName).toBe("workspace/integration-agent");

    // Detach with "always" policy
    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace directory should be removed
    expect(existsSync(ws.path)).toBe(false);
  });

  it("on_success policy preserves workspace when agent is running", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "on_success",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("running-agent") },
      state: "running",
    });

    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace should still exist (agent not terminated)
    expect(existsSync(ws.path)).toBe(true);
  });

  it("on_success policy cleans up when agent terminated with success", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "on_success",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("terminated-agent") },
      state: "terminated",
      terminationOutcome: "success",
    });

    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace should be cleaned up (agent terminated successfully)
    expect(existsSync(ws.path)).toBe(false);
  });

  it("on_success policy preserves workspace when agent terminated with error", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "on_success",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("error-agent") },
      state: "terminated",
      terminationOutcome: "error",
    });

    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace should be preserved (agent failed)
    expect(existsSync(ws.path)).toBe(true);
  });

  it("on_success policy preserves workspace when agent terminated with interrupted", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "on_success",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("interrupted-agent") },
      state: "terminated",
      terminationOutcome: "interrupted",
    });

    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace should be preserved (agent was interrupted, not successful)
    expect(existsSync(ws.path)).toBe(true);
  });

  it("never policy always preserves workspace", async () => {
    const backendResult = createGitWorktreeBackend({ repoPath: repo.repoPath });
    if (!backendResult.ok) throw new Error("Backend creation failed");

    const providerResult = createWorkspaceProvider({
      backend: backendResult.value,
      cleanupPolicy: "never",
    });
    if (!providerResult.ok) throw new Error("Provider creation failed");

    const provider = providerResult.value;
    const agent: Agent = createMockAgent({
      pid: { id: agentId("never-cleanup-agent") },
      state: "terminated",
    });

    const components = extractMap(await provider.attach(agent));
    const ws = getWorkspaceComponent(components);

    if (!provider.detach) throw new Error("detach missing");
    await provider.detach(agent);

    // Workspace should still exist (never cleanup)
    expect(existsSync(ws.path)).toBe(true);
  });
});
