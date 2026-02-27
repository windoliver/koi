import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { Agent, AgentId, Result, TerminationOutcome, WorkspaceComponent } from "@koi/core";
import { agentId, WORKSPACE } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createWorkspaceProvider } from "./provider.js";
import type { ResolvedWorkspaceConfig, WorkspaceBackend, WorkspaceInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_KEY: string = WORKSPACE;

function getWorkspaceComponent(components: ReadonlyMap<string, unknown>): WorkspaceComponent {
  const ws = components.get(WORKSPACE_KEY);
  if (!ws) throw new Error("WORKSPACE component not found");
  return ws as WorkspaceComponent;
}

// ---------------------------------------------------------------------------
// Mock backend
// ---------------------------------------------------------------------------

function createMockBackend(): WorkspaceBackend & {
  readonly createCalls: Array<{ agentId: AgentId; config: ResolvedWorkspaceConfig }>;
  readonly disposeCalls: string[];
} {
  const createCalls: Array<{ agentId: AgentId; config: ResolvedWorkspaceConfig }> = [];
  const disposeCalls: string[] = [];
  let counter = 0;

  return {
    name: "mock",
    createCalls,
    disposeCalls,

    create: async (
      aid: AgentId,
      config: ResolvedWorkspaceConfig,
    ): Promise<Result<WorkspaceInfo>> => {
      createCalls.push({ agentId: aid, config });
      counter += 1;
      return {
        ok: true,
        value: {
          id: `mock-ws-${counter}`,
          path: `/tmp/mock-ws-${counter}`,
          createdAt: Date.now(),
          metadata: { backendName: "mock" },
        },
      };
    },

    dispose: async (workspaceId: string): Promise<Result<void>> => {
      disposeCalls.push(workspaceId);
      return { ok: true, value: undefined };
    },

    isHealthy: () => true,
  };
}

function makeAgent(
  id: string,
  state: string = "running",
  terminationOutcome?: TerminationOutcome,
): Agent {
  return createMockAgent({
    pid: { id: agentId(id) },
    state: state as "running" | "terminated",
    ...(terminationOutcome !== undefined ? { terminationOutcome } : {}),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWorkspaceProvider", () => {
  it("returns error when backend is missing", () => {
    const result = createWorkspaceProvider({} as never);
    expect(result.ok).toBe(false);
  });

  it("returns ok with valid config", () => {
    const result = createWorkspaceProvider({ backend: createMockBackend() });
    expect(result.ok).toBe(true);
  });
});

describe("WorkspaceProvider.attach", () => {
  let backend: ReturnType<typeof createMockBackend>;

  beforeEach(() => {
    backend = createMockBackend();
  });

  it("returns component map with WORKSPACE token", async () => {
    const result = createWorkspaceProvider({ backend });
    if (!result.ok) throw new Error("Provider creation failed");

    const agent = makeAgent("agent-1");
    const components = await result.value.attach(agent);

    expect(components.has(WORKSPACE_KEY)).toBe(true);
  });

  it("component has correct shape", async () => {
    const result = createWorkspaceProvider({ backend });
    if (!result.ok) throw new Error("Provider creation failed");

    const agent = makeAgent("agent-1");
    const components = await result.value.attach(agent);
    const ws = getWorkspaceComponent(components);

    expect(ws.id).toStartWith("mock-ws-");
    expect(ws.path).toStartWith("/tmp/mock-ws-");
    expect(typeof ws.createdAt).toBe("number");
    expect(ws.metadata).toBeDefined();
  });

  it("calls postCreate hook after workspace creation", async () => {
    const postCreate = mock(async (_ws: WorkspaceInfo): Promise<void> => {});
    const result = createWorkspaceProvider({ backend, postCreate });
    if (!result.ok) throw new Error("Provider creation failed");

    await result.value.attach(makeAgent("agent-1"));

    expect(postCreate).toHaveBeenCalledTimes(1);
    const callArg = postCreate.mock.calls[0]?.[0] as WorkspaceInfo;
    expect(callArg.id).toStartWith("mock-ws-");
  });

  it("disposes workspace and throws when postCreate fails", async () => {
    const postCreate = async (_ws: WorkspaceInfo): Promise<void> => {
      throw new Error("hook failed");
    };
    const result = createWorkspaceProvider({ backend, postCreate });
    if (!result.ok) throw new Error("Provider creation failed");

    await expect(result.value.attach(makeAgent("agent-1"))).rejects.toThrow(
      "postCreate hook failed",
    );

    // Backend.dispose should have been called for cleanup
    expect(backend.disposeCalls.length).toBe(1);
  });

  it("throws when backend.create fails", async () => {
    const failBackend: WorkspaceBackend = {
      name: "fail",
      create: async () => ({
        ok: false as const,
        error: { code: "EXTERNAL" as const, message: "disk full", retryable: false },
      }),
      dispose: async () => ({ ok: true as const, value: undefined }),
      isHealthy: () => false,
    };
    const result = createWorkspaceProvider({ backend: failBackend });
    if (!result.ok) throw new Error("Provider creation failed");

    await expect(result.value.attach(makeAgent("agent-1"))).rejects.toThrow("disk full");
  });
});

describe("WorkspaceProvider.detach", () => {
  let backend: ReturnType<typeof createMockBackend>;

  beforeEach(() => {
    backend = createMockBackend();
  });

  // ---------------------------------------------------------------------------
  // Full cleanup matrix: 3 policies × 4 outcomes = 12 cases
  // ---------------------------------------------------------------------------

  // -- "always" policy: always clean up regardless of outcome --

  it("'always' cleans up on success", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "success");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  it("'always' cleans up on error", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "error");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  it("'always' cleans up on interrupted", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "interrupted");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  it("'always' cleans up when agent is still running", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "running");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  it("'always' cleans up when terminated with undefined outcome", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "always" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  // -- "on_success" policy: clean up only on confirmed success --

  it("'on_success' cleans up on success", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "success");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(1);
  });

  it("'on_success' preserves workspace on error", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "error");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  it("'on_success' preserves workspace on interrupted", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "interrupted");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  it("'on_success' preserves workspace when outcome is undefined (fail-closed)", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "on_success" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  // -- "never" policy: never clean up regardless of outcome --

  it("'never' preserves workspace on success", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "success");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  it("'never' preserves workspace on error", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "error");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  it("'never' preserves workspace on interrupted", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "interrupted");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  it("'never' preserves workspace when outcome is undefined", async () => {
    const result = createWorkspaceProvider({ backend, cleanupPolicy: "never" });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "running");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(backend.disposeCalls.length).toBe(0);
  });

  // -- pruneStale hook --

  it("calls pruneStale when workspace is preserved", async () => {
    const pruneStale = mock(async (): Promise<void> => {});
    const result = createWorkspaceProvider({
      backend,
      cleanupPolicy: "on_success",
      pruneStale,
    });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "error");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(pruneStale).toHaveBeenCalledTimes(1);
  });

  it("does not call pruneStale when workspace is cleaned up", async () => {
    const pruneStale = mock(async (): Promise<void> => {});
    const result = createWorkspaceProvider({
      backend,
      cleanupPolicy: "always",
      pruneStale,
    });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "success");
    await result.value.attach(agent);
    await result.value.detach(agent);

    expect(pruneStale).not.toHaveBeenCalled();
  });

  it("handles pruneStale failure gracefully", async () => {
    const pruneStale = mock(async (): Promise<void> => {
      throw new Error("prune crashed");
    });
    const result = createWorkspaceProvider({
      backend,
      cleanupPolicy: "never",
      pruneStale,
    });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    const agent = makeAgent("agent-1", "terminated", "success");
    await result.value.attach(agent);

    // Should not throw despite pruneStale throwing
    await expect(result.value.detach(agent)).resolves.toBeUndefined();
    expect(pruneStale).toHaveBeenCalledTimes(1);
  });

  // -- Edge cases --

  it("is a no-op when agent has no workspace", async () => {
    const result = createWorkspaceProvider({ backend });
    if (!result.ok) throw new Error("Provider creation failed");
    if (!result.value.detach) throw new Error("detach missing");

    // detach without attach — should not throw
    await result.value.detach(makeAgent("agent-unknown"));
    expect(backend.disposeCalls.length).toBe(0);
  });
});
