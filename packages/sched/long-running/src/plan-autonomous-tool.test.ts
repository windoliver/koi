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
