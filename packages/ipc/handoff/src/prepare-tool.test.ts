import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentRegistry, HandoffEvent, JsonObject, RegistryEntry } from "@koi/core";
import { agentId } from "@koi/core";
import { createPrepareTool } from "./prepare-tool.js";
import { createInMemoryHandoffStore, type HandoffStore } from "./store.js";

describe("prepare_handoff tool", () => {
  let store: HandoffStore;
  const events: HandoffEvent[] = [];

  beforeEach(() => {
    store = createInMemoryHandoffStore();
    events.length = 0;
  });

  function makeTool(): ReturnType<typeof createPrepareTool> {
    return createPrepareTool({
      store,
      agentId: agentId("agent-a"),
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  test("creates envelope with valid input", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      completed: "Analyzed the data",
      next: "Generate report from analysis",
    } as JsonObject);

    const output = result as { handoffId: string; status: string };
    expect(output.handoffId).toBeDefined();
    expect(output.status).toBe("pending");

    // Verify stored
    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      const stored = listResult.value;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.from).toBe(agentId("agent-a"));
      expect(stored[0]?.to).toBe(agentId("agent-b"));
      expect(stored[0]?.status).toBe("pending");
      expect(stored[0]?.phase.completed).toBe("Analyzed the data");
      expect(stored[0]?.phase.next).toBe("Generate report from analysis");
    }
  });

  test("emits handoff:prepared event", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("handoff:prepared");
  });

  test("returns error when neither 'to' nor 'capability' is provided", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({ error: "Provide exactly one of 'to' or 'capability'" });
  });

  test("returns error when 'completed' is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({ error: "'completed' is required and must be a non-empty string" });
  });

  test("returns error when 'next' is missing", async () => {
    const tool = makeTool();
    const result = await tool.execute({
      to: "agent-b",
      completed: "Done",
    } as JsonObject);

    expect(result).toEqual({ error: "'next' is required and must be a non-empty string" });
  });

  test("includes artifacts and warnings in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      artifacts: [{ id: "a1", kind: "file", uri: "file:///workspace/out.json" }],
      warnings: ["Watch out for edge case X"],
    } as JsonObject);

    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.context.artifacts).toHaveLength(1);
      expect(listResult.value[0]?.context.warnings).toContain("Watch out for edge case X");
    }
  });

  test("adds artifact validation warnings", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      artifacts: [{ id: "a1", kind: "data", uri: "s3://bucket/key" }],
    } as JsonObject);

    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.context.warnings.length).toBeGreaterThan(0);
      expect(listResult.value[0]?.context.warnings[0]).toContain("unsupported URI scheme");
    }
  });

  test("concurrent calls produce unique IDs", async () => {
    const tool = makeTool();
    const [r1, r2] = await Promise.all([
      tool.execute({ to: "b", completed: "D1", next: "N1" } as JsonObject),
      tool.execute({ to: "b", completed: "D2", next: "N2" } as JsonObject),
    ]);

    const id1 = (r1 as { handoffId: string }).handoffId;
    const id2 = (r2 as { handoffId: string }).handoffId;
    expect(id1).not.toBe(id2);
  });

  test("includes decisions in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      decisions: [
        {
          agentId: "agent-a",
          action: "chose_strategy",
          reasoning: "BFS is better for this graph",
          timestamp: Date.now(),
        },
      ],
    } as JsonObject);

    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.context.decisions).toHaveLength(1);
      expect(listResult.value[0]?.context.decisions[0]?.action).toBe("chose_strategy");
    }
  });

  test("includes metadata in envelope", async () => {
    const tool = makeTool();
    await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
      metadata: { priority: "high" },
    } as JsonObject);

    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.metadata).toEqual({ priority: "high" });
    }
  });
});

// ---------------------------------------------------------------------------
// Capability-based resolution
// ---------------------------------------------------------------------------

describe("prepare_handoff capability resolution", () => {
  let store: HandoffStore;
  const events: HandoffEvent[] = [];

  beforeEach(() => {
    store = createInMemoryHandoffStore();
    events.length = 0;
  });

  function makeRegistryEntry(id: string): RegistryEntry {
    return {
      agentId: agentId(id),
      status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      metadata: {},
      registeredAt: Date.now(),
      priority: 10,
    };
  }

  function makeRegistry(entries: readonly RegistryEntry[]): AgentRegistry {
    return {
      register: () => {
        throw new Error("not implemented");
      },
      deregister: () => {
        throw new Error("not implemented");
      },
      lookup: () => {
        throw new Error("not implemented");
      },
      list: () => entries,
      transition: () => {
        throw new Error("not implemented");
      },
      patch: () => {
        throw new Error("not implemented");
      },
      watch: () => () => {},
      [Symbol.asyncDispose]: async () => {},
    };
  }

  function makeToolWithRegistry(registry?: AgentRegistry): ReturnType<typeof createPrepareTool> {
    return createPrepareTool({
      store,
      agentId: agentId("agent-a"),
      registry,
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  test("resolves target by capability and returns resolvedTo", async () => {
    const registry = makeRegistry([makeRegistryEntry("deploy-agent")]);
    const tool = makeToolWithRegistry(registry);

    const result = (await tool.execute({
      capability: "deployment",
      completed: "Built the artifact",
      next: "Deploy to staging",
    } as JsonObject)) as { handoffId: string; status: string; resolvedTo: string };

    expect(result.handoffId).toBeDefined();
    expect(result.status).toBe("pending");
    expect(result.resolvedTo).toBe(agentId("deploy-agent"));

    // Verify envelope stored with resolved target
    const listResult = await store.listByAgent(agentId("agent-a"));
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value[0]?.to).toBe(agentId("deploy-agent"));
    }
  });

  test("returns error when no registry configured for capability handoff", async () => {
    const tool = makeToolWithRegistry(undefined);

    const result = await tool.execute({
      capability: "deployment",
      completed: "Done",
      next: "Deploy",
    } as JsonObject);

    expect(result).toEqual({
      error:
        "Cannot resolve capability-based handoff: no registry configured. " +
        "Provide a registry in HandoffConfig or use 'to' with a direct agent ID.",
    });
  });

  test("returns error when no running agent has the requested capability", async () => {
    const registry = makeRegistry([]);
    const tool = makeToolWithRegistry(registry);

    const result = await tool.execute({
      capability: "nonexistent",
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({
      error: 'No running agent found with capability "nonexistent"',
    });
  });

  test("selects first agent when multiple match capability", async () => {
    const registry = makeRegistry([makeRegistryEntry("deploy-1"), makeRegistryEntry("deploy-2")]);
    const tool = makeToolWithRegistry(registry);

    const result = (await tool.execute({
      capability: "deployment",
      completed: "Done",
      next: "Deploy",
    } as JsonObject)) as { resolvedTo: string };

    expect(result.resolvedTo).toBe(agentId("deploy-1"));
  });

  test("returns error when both 'to' and 'capability' are provided", async () => {
    const registry = makeRegistry([makeRegistryEntry("deploy-agent")]);
    const tool = makeToolWithRegistry(registry);

    const result = await tool.execute({
      to: "agent-b",
      capability: "deployment",
      completed: "Done",
      next: "Continue",
    } as JsonObject);

    expect(result).toEqual({
      error: "Provide exactly one of 'to' or 'capability', not both",
    });
  });

  test("direct 'to' handoff does not include resolvedTo in response", async () => {
    const registry = makeRegistry([makeRegistryEntry("deploy-agent")]);
    const tool = makeToolWithRegistry(registry);

    const result = (await tool.execute({
      to: "agent-b",
      completed: "Done",
      next: "Continue",
    } as JsonObject)) as Record<string, unknown>;

    expect(result.handoffId).toBeDefined();
    expect(result.status).toBe("pending");
    expect(result.resolvedTo).toBeUndefined();
  });

  test("handles registry errors gracefully", async () => {
    const registry = makeRegistry([]);
    // Override list to throw
    (registry as { list: unknown }).list = () => {
      throw new Error("connection refused");
    };
    const tool = makeToolWithRegistry(registry);

    const result = await tool.execute({
      capability: "deployment",
      completed: "Done",
      next: "Deploy",
    } as JsonObject);

    expect(result).toEqual({
      error: 'Registry lookup failed for capability "deployment": connection refused',
    });
  });

  test("emits handoff:prepared event for capability-based handoff", async () => {
    const registry = makeRegistry([makeRegistryEntry("deploy-agent")]);
    const tool = makeToolWithRegistry(registry);

    await tool.execute({
      capability: "deployment",
      completed: "Built it",
      next: "Deploy it",
    } as JsonObject);

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("handoff:prepared");
  });
});
