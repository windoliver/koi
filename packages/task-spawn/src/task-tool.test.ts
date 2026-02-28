import { describe, expect, it, mock } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import { agentId } from "@koi/core/ecs";
import { createTaskTool } from "./task-tool.js";
import type {
  AgentResolver,
  SpawnFn,
  TaskMessageRequest,
  TaskSpawnConfig,
  TaskSpawnRequest,
  TaskSpawnResult,
} from "./types.js";

const MOCK_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  model: { name: "test-model" },
};

const RESEARCH_MANIFEST: AgentManifest = {
  name: "researcher",
  version: "0.0.1",
  model: { name: "research-model" },
};

function createConfig(
  overrides?: Partial<TaskSpawnConfig> & { readonly spawnFn?: SpawnFn },
): TaskSpawnConfig {
  const agents = new Map([
    [
      "test",
      {
        name: "test-agent",
        description: "A test agent",
        manifest: MOCK_MANIFEST,
      },
    ],
    [
      "researcher",
      {
        name: "researcher",
        description: "A research agent",
        manifest: RESEARCH_MANIFEST,
      },
    ],
  ]);

  const spawn: SpawnFn =
    overrides?.spawnFn ?? (async () => ({ ok: true, output: "mock output" }) as TaskSpawnResult);

  return {
    agents: overrides?.agents ?? agents,
    agentResolver: overrides?.agentResolver,
    spawn: overrides?.spawn ?? spawn,
    defaultAgent: overrides?.defaultAgent,
    maxDurationMs: overrides?.maxDurationMs,
  };
}

describe("createTaskTool", () => {
  it("returns output on successful spawn (happy path)", async () => {
    const spawnFn = mock(
      async (): Promise<TaskSpawnResult> => ({
        ok: true,
        output: "result text",
      }),
    );
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    const result = await tool.execute({
      description: "do something",
      agent_type: "test",
    });

    expect(result).toBe("result text");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const call = spawnFn.mock.calls[0] as unknown as [TaskSpawnRequest];
    expect(call[0].description).toBe("do something");
    expect(call[0].agentName).toBe("test-agent");
    expect(call[0].manifest).toBe(MOCK_MANIFEST);
    expect(call[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns error string for unknown agent type", async () => {
    const tool = await createTaskTool(createConfig());

    const result = await tool.execute({
      description: "do something",
      agent_type: "nonexistent",
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("unknown agent type");
    expect(result as string).toContain("nonexistent");
    expect(result as string).toContain("test");
  });

  it("re-throws when spawn callback throws (infra failure)", async () => {
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => {
      throw new Error("adapter factory exploded");
    });
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    await expect(tool.execute({ description: "do something", agent_type: "test" })).rejects.toThrow(
      "adapter factory exploded",
    );
  });

  it("re-throws when spawn rejects (ledger full)", async () => {
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => {
      throw new Error("spawn ledger at capacity");
    });
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    await expect(tool.execute({ description: "do something", agent_type: "test" })).rejects.toThrow(
      "spawn ledger at capacity",
    );
  });

  it("returns error string on timeout via abort signal", async () => {
    const spawnFn = mock(async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
      // Simulate the spawn checking the signal
      if (request.signal.aborted) {
        return { ok: false, error: "task timed out" };
      }
      // Wait until aborted
      return new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({ ok: false, error: "task timed out" });
        });
      });
    });
    const tool = await createTaskTool(createConfig({ spawn: spawnFn, maxDurationMs: 50 }));

    const result = await tool.execute({
      description: "slow task",
      agent_type: "test",
    });

    expect(result).toBe("Task failed: task timed out");
  });

  it("returns error string when child run fails", async () => {
    const spawnFn = mock(
      async (): Promise<TaskSpawnResult> => ({
        ok: false,
        error: "child execution failed: model returned error",
      }),
    );
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    const result = await tool.execute({
      description: "do something",
      agent_type: "test",
    });

    expect(result).toBe("Task failed: child execution failed: model returned error");
  });

  it("returns error string when child terminates with error stop reason", async () => {
    const spawnFn = mock(
      async (): Promise<TaskSpawnResult> => ({
        ok: false,
        error: "agent terminated with stop reason: error",
      }),
    );
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    const result = await tool.execute({
      description: "do something",
      agent_type: "test",
    });

    expect(result).toBe("Task failed: agent terminated with stop reason: error");
  });

  it("returns default message when child produces empty output", async () => {
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => ({ ok: true, output: "" }));
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    const result = await tool.execute({
      description: "do something",
      agent_type: "test",
    });

    expect(result).toBe("(task completed with no output)");
  });

  it("uses default agent when agent_type is omitted", async () => {
    const spawnFn = mock(
      async (): Promise<TaskSpawnResult> => ({
        ok: true,
        output: "researched",
      }),
    );
    const tool = await createTaskTool(createConfig({ spawn: spawnFn, defaultAgent: "researcher" }));

    const result = await tool.execute({ description: "research topic" });

    expect(result).toBe("researched");
    const call = spawnFn.mock.calls[0] as unknown as [TaskSpawnRequest];
    expect(call[0].agentName).toBe("researcher");
    expect(call[0].manifest).toBe(RESEARCH_MANIFEST);
  });

  it("clears timeout on spawn failure (no leaked timers)", async () => {
    // let justified: track whether spawn was called
    let spawnCalled = false;
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => {
      spawnCalled = true;
      throw new Error("infra failure");
    });

    const tool = await createTaskTool(createConfig({ spawn: spawnFn, maxDurationMs: 60_000 }));

    await expect(tool.execute({ description: "do something", agent_type: "test" })).rejects.toThrow(
      "infra failure",
    );
    expect(spawnCalled).toBe(true);
    // Timer cleared in finally — no timeout leak
  });

  it("returns error when agent_type omitted and no default configured", async () => {
    const tool = await createTaskTool(createConfig());

    const result = await tool.execute({ description: "do something" });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("agent_type");
    expect(result as string).toContain("required");
  });

  it("returns error for empty description", async () => {
    const tool = await createTaskTool(createConfig({ defaultAgent: "test" }));

    const result = await tool.execute({
      description: "",
      agent_type: "test",
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("description");
  });

  it("has descriptor with name 'task'", async () => {
    const tool = await createTaskTool(createConfig());
    expect(tool.descriptor.name).toBe("task");
  });

  it("has trustTier 'verified'", async () => {
    const tool = await createTaskTool(createConfig());
    expect(tool.trustTier).toBe("verified");
  });

  it("passes abort signal to spawn callback", async () => {
    // let justified: capture the signal for assertion
    let capturedSignal: AbortSignal | undefined;
    const spawnFn = mock(async (request: TaskSpawnRequest): Promise<TaskSpawnResult> => {
      capturedSignal = request.signal;
      return { ok: true, output: "done" };
    });
    const tool = await createTaskTool(createConfig({ spawn: spawnFn }));

    await tool.execute({ description: "do something", agent_type: "test" });

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it("resolves agent via agentResolver when provided", async () => {
    const resolver: AgentResolver = {
      resolve: async (type) =>
        type === "custom"
          ? {
              name: "custom-agent",
              description: "Custom",
              manifest: MOCK_MANIFEST,
            }
          : undefined,
      list: async () => [{ key: "custom", name: "custom-agent", description: "Custom agent" }],
    };
    const spawnFn = mock(
      async (): Promise<TaskSpawnResult> => ({
        ok: true,
        output: "custom result",
      }),
    );
    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: spawnFn,
    });

    const result = await tool.execute({
      description: "do custom",
      agent_type: "custom",
    });
    expect(result).toBe("custom result");
  });

  it("builds dynamic enum in descriptor from agent summaries", async () => {
    const resolver: AgentResolver = {
      resolve: async () => undefined,
      list: async () => [
        { key: "researcher", name: "Researcher", description: "Researches" },
        { key: "coder", name: "Coder", description: "Codes" },
      ],
    };
    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: async () => ({ ok: true, output: "" }),
    });

    const schema = tool.descriptor.inputSchema;
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.agent_type?.enum).toEqual(["researcher", "coder"]);
  });

  it("routes to live copilot when findLive returns an AgentId", async () => {
    const liveAgentId = agentId("copilot-123");
    const resolver: AgentResolver = {
      resolve: async (type) =>
        type === "test"
          ? { name: "test-agent", description: "A test", manifest: MOCK_MANIFEST }
          : undefined,
      list: async () => [{ key: "test", name: "test-agent", description: "A test" }],
      findLive: async () => liveAgentId,
    };
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => ({ ok: true, output: "spawned" }));
    const messageFn = mock(
      async (request: TaskMessageRequest): Promise<TaskSpawnResult> => ({
        ok: true,
        output: `messaged ${request.agentId}`,
      }),
    );

    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: spawnFn,
      message: messageFn,
    });

    const result = await tool.execute({ description: "do it", agent_type: "test" });

    expect(result).toBe("messaged copilot-123");
    expect(messageFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    const call = messageFn.mock.calls[0] as unknown as [TaskMessageRequest];
    expect(call[0].agentId).toBe(liveAgentId);
    expect(call[0].description).toBe("do it");
    expect(call[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("falls through to spawn when findLive returns undefined", async () => {
    const resolver: AgentResolver = {
      resolve: async (type) =>
        type === "test"
          ? { name: "test-agent", description: "A test", manifest: MOCK_MANIFEST }
          : undefined,
      list: async () => [{ key: "test", name: "test-agent", description: "A test" }],
      findLive: async () => undefined,
    };
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => ({ ok: true, output: "spawned" }));
    const messageFn = mock(
      async (): Promise<TaskSpawnResult> => ({ ok: true, output: "messaged" }),
    );

    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: spawnFn,
      message: messageFn,
    });

    const result = await tool.execute({ description: "do it", agent_type: "test" });

    expect(result).toBe("spawned");
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(messageFn).not.toHaveBeenCalled();
  });

  it("falls through to spawn when message fn is absent", async () => {
    const resolver: AgentResolver = {
      resolve: async (type) =>
        type === "test"
          ? { name: "test-agent", description: "A test", manifest: MOCK_MANIFEST }
          : undefined,
      list: async () => [{ key: "test", name: "test-agent", description: "A test" }],
      findLive: async () => agentId("copilot-123"),
    };
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => ({ ok: true, output: "spawned" }));

    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: spawnFn,
      // message is absent
    });

    const result = await tool.execute({ description: "do it", agent_type: "test" });

    expect(result).toBe("spawned");
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it("clears timeout on message callback failure", async () => {
    const resolver: AgentResolver = {
      resolve: async (type) =>
        type === "test"
          ? { name: "test-agent", description: "A test", manifest: MOCK_MANIFEST }
          : undefined,
      list: async () => [{ key: "test", name: "test-agent", description: "A test" }],
      findLive: async () => agentId("copilot-456"),
    };
    const spawnFn = mock(async (): Promise<TaskSpawnResult> => ({ ok: true, output: "spawned" }));
    const messageFn = mock(async (): Promise<TaskSpawnResult> => {
      throw new Error("message delivery failed");
    });

    const tool = await createTaskTool({
      agentResolver: resolver,
      spawn: spawnFn,
      message: messageFn,
      maxDurationMs: 60_000,
    });

    await expect(tool.execute({ description: "do it", agent_type: "test" })).rejects.toThrow(
      "message delivery failed",
    );
    // Timer cleared in finally — no timeout leak
  });
});
