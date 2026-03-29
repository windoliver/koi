import { describe, expect, test } from "bun:test";
import type { TaskBoardSnapshot } from "@koi/core";
import { taskItemId } from "@koi/core";
import { createPlanAutonomousProvider } from "./plan-autonomous-tool.js";

describe("createPlanAutonomousProvider", () => {
  test("creates a ComponentProvider with correct name", () => {
    const provider = createPlanAutonomousProvider({
      onPlanCreated: () => {},
    });
    expect(provider.name).toBe("plan-autonomous-provider");
  });

  test("provider attaches a plan_autonomous tool", async () => {
    const provider = createPlanAutonomousProvider({
      onPlanCreated: () => {},
    });

    // Create a minimal mock agent
    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    // Check if the result contains the tool
    const components = "components" in result ? result.components : result;
    expect(components.has("tool:plan_autonomous")).toBe(true);
  });

  test("plan_autonomous tool creates valid TaskBoardSnapshot", async () => {
    let capturedPlan: TaskBoardSnapshot | undefined;
    const provider = createPlanAutonomousProvider({
      onPlanCreated: (plan) => {
        capturedPlan = plan;
      },
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const output = await tool.execute({
      tasks: [
        { id: "t1", description: "First task" },
        { id: "t2", description: "Second task", dependencies: ["t1"] },
      ],
    });

    expect(capturedPlan).toBeDefined();
    expect(capturedPlan?.items).toHaveLength(2);
    expect(capturedPlan?.items[0]?.status).toBe("assigned");
    expect(capturedPlan?.items[1]?.dependencies).toEqual([taskItemId("t1")]);
    expect(output).toEqual({
      status: "plan_created",
      taskCount: 2,
      message: "Created autonomous plan with 2 tasks.",
    });
  });

  test("spawn-delegated tasks start as pending, self-delegated as assigned", async () => {
    let capturedPlan: TaskBoardSnapshot | undefined;
    const provider = createPlanAutonomousProvider({
      onPlanCreated: (plan) => {
        capturedPlan = plan;
      },
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    await tool.execute({
      tasks: [
        { id: "self-task", description: "Self-delegated task" },
        { id: "spawn-task", description: "Spawn-delegated task", delegation: "spawn" },
        { id: "explicit-self", description: "Explicit self", delegation: "self" },
      ],
    });

    expect(capturedPlan).toBeDefined();
    expect(capturedPlan?.items).toHaveLength(3);
    // Self-delegated (default) → assigned
    expect(capturedPlan?.items[0]?.status).toBe("assigned");
    expect(capturedPlan?.items[0]?.delegation).toBe("self");
    // Spawn-delegated → pending
    expect(capturedPlan?.items[1]?.status).toBe("pending");
    expect(capturedPlan?.items[1]?.delegation).toBe("spawn");
    // Explicit self → assigned
    expect(capturedPlan?.items[2]?.status).toBe("assigned");
    expect(capturedPlan?.items[2]?.delegation).toBe("self");
  });

  test("agentType is passed through to snapshot items", async () => {
    let capturedPlan: TaskBoardSnapshot | undefined;
    const provider = createPlanAutonomousProvider({
      onPlanCreated: (plan) => {
        capturedPlan = plan;
      },
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    await tool.execute({
      tasks: [
        {
          id: "research",
          description: "Research task",
          delegation: "spawn",
          agentType: "researcher",
        },
        { id: "code", description: "Code task", delegation: "spawn" },
        { id: "review", description: "Review task" },
      ],
    });

    expect(capturedPlan).toBeDefined();
    // agentType set explicitly
    expect(capturedPlan?.items[0]?.agentType).toBe("researcher");
    // agentType omitted → not present on item
    expect(capturedPlan?.items[1]?.agentType).toBeUndefined();
    // Self-delegated → no agentType
    expect(capturedPlan?.items[2]?.agentType).toBeUndefined();
  });

  test("invalid delegation value defaults to self", async () => {
    let capturedPlan: TaskBoardSnapshot | undefined;
    const provider = createPlanAutonomousProvider({
      onPlanCreated: (plan) => {
        capturedPlan = plan;
      },
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const result1 = (await tool.execute({
      tasks: [{ id: "t1", description: "Task with invalid delegation", delegation: "invalid" }],
    })) as Record<string, unknown>;

    // Invalid delegation values are now rejected, not silently coerced
    expect(result1.error).toContain("invalid delegation");
    expect(capturedPlan).toBeUndefined();

    const result2 = (await tool.execute({
      tasks: [{ id: "t2", description: "Task with numeric delegation", delegation: 42 }],
    })) as Record<string, unknown>;

    expect(result2.error).toContain("invalid delegation");
  });

  test("mixed plan with dependencies preserves delegation across snapshot", async () => {
    let capturedPlan: TaskBoardSnapshot | undefined;
    const provider = createPlanAutonomousProvider({
      onPlanCreated: (plan) => {
        capturedPlan = plan;
      },
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    await tool.execute({
      tasks: [
        { id: "research", description: "Research", delegation: "spawn", agentType: "researcher" },
        { id: "impl", description: "Implement", delegation: "self", dependencies: ["research"] },
        {
          id: "test",
          description: "Test",
          delegation: "spawn",
          agentType: "tester",
          dependencies: ["impl"],
        },
      ],
    });

    expect(capturedPlan).toBeDefined();
    expect(capturedPlan?.items).toHaveLength(3);
    // research: spawn, pending, has agentType
    expect(capturedPlan?.items[0]?.status).toBe("pending");
    expect(capturedPlan?.items[0]?.agentType).toBe("researcher");
    // impl: self, assigned, depends on research
    expect(capturedPlan?.items[1]?.status).toBe("assigned");
    expect(capturedPlan?.items[1]?.dependencies).toEqual([taskItemId("research")]);
    // test: spawn, pending, depends on impl, has agentType
    expect(capturedPlan?.items[2]?.status).toBe("pending");
    expect(capturedPlan?.items[2]?.agentType).toBe("tester");
    expect(capturedPlan?.items[2]?.dependencies).toEqual([taskItemId("impl")]);
  });

  test("plan_autonomous tool rejects empty tasks", async () => {
    const provider = createPlanAutonomousProvider({
      onPlanCreated: () => {},
    });

    const result = await provider.attach({
      pid: { id: "test" as never, name: "test", type: "copilot", depth: 0 },
      manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
      state: "created",
      component: () => undefined,
      has: () => false,
      hasAll: () => false,
      query: () => new Map(),
      components: () => new Map(),
    });

    const components = "components" in result ? result.components : result;
    const tool = components.get("tool:plan_autonomous") as {
      execute: (args: Record<string, unknown>) => Promise<unknown>;
    };

    const output = (await tool.execute({ tasks: [] })) as { error: string };
    expect(output.error).toContain("No valid tasks");
  });
});
