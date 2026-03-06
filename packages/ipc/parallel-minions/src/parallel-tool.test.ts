import { describe, expect, it } from "bun:test";
import type { AgentManifest } from "@koi/core/assembly";
import type { AttachResult, Tool } from "@koi/core/ecs";
import { isAttachResult } from "@koi/core/ecs";
import { createMockAgent } from "@koi/test-utils";
import { createParallelTool } from "./parallel-tool.js";
import { createParallelMinionsProvider } from "./provider.js";
import type { MinionSpawnFn, ParallelMinionsConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: AgentManifest = {
  name: "test-worker",
  version: "0.0.1",
  model: { name: "mock" },
};

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

function makeConfig(overrides?: Partial<ParallelMinionsConfig>): ParallelMinionsConfig {
  const spawn: MinionSpawnFn = async (req) => ({
    ok: true,
    output: `result-${req.taskIndex}`,
  });

  return {
    agents: new Map([
      [
        "worker",
        {
          name: "test-worker",
          description: "A test worker",
          manifest: TEST_MANIFEST,
        },
      ],
    ]),
    spawn,
    defaultAgent: "worker",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createParallelTool
// ---------------------------------------------------------------------------

describe("createParallelTool", () => {
  it("returns correct descriptor", () => {
    const tool = createParallelTool(makeConfig());
    expect(tool.descriptor.name).toBe("parallel_task");
    expect(tool.policy.sandbox).toBe(false);
  });

  it("executes valid tasks and returns formatted output", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({
      tasks: [{ description: "task A" }, { description: "task B" }],
    });

    expect(typeof result).toBe("string");
    const output = result as string;
    expect(output).toContain("2/2 succeeded");
    expect(output).toContain("task A");
    expect(output).toContain("task B");
  });

  it("returns error for missing tasks", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({});

    expect(result).toBe("Error: 'tasks' is required and must be an array");
  });

  it("returns error for non-array tasks", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({ tasks: "not-an-array" });

    expect(result).toBe("Error: 'tasks' is required and must be an array");
  });

  it("returns error for empty tasks array", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({ tasks: [] });

    expect(result).toBe("Error: 'tasks' must contain at least one task");
  });

  it("returns error when exceeding max tasks", async () => {
    const tool = createParallelTool(makeConfig());
    const tasks = Array.from({ length: 51 }, (_, i) => ({
      description: `task-${i}`,
    }));
    const result = await tool.execute({ tasks });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("maximum 50 tasks");
  });

  it("returns error for task with missing description", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({
      tasks: [{ agent_type: "worker" }],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("description");
  });

  it("returns error for task with empty description", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({
      tasks: [{ description: "" }],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("description");
  });

  it("returns error for non-object task items", async () => {
    const tool = createParallelTool(makeConfig());
    const result = await tool.execute({
      tasks: ["not an object"],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("tasks[0]");
  });
});

// ---------------------------------------------------------------------------
// createParallelMinionsProvider
// ---------------------------------------------------------------------------

describe("createParallelMinionsProvider", () => {
  it("creates tool:parallel_task component", async () => {
    const provider = createParallelMinionsProvider(makeConfig());
    expect(provider.name).toBe("parallel-minions");

    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    expect(tool).toBeDefined();
    expect(tool.descriptor.name).toBe("parallel_task");
  });

  it("caches components on repeated attach()", async () => {
    const provider = createParallelMinionsProvider(makeConfig());
    const agent = createMockAgent();

    const first = await provider.attach(agent);
    const second = await provider.attach(agent);

    expect(first).toBe(second);
  });

  it("tool executes through provider", async () => {
    const provider = createParallelMinionsProvider(makeConfig());
    const agent = createMockAgent();
    const components = extractMap(await provider.attach(agent));
    const tool = components.get("tool:parallel_task") as Tool;

    const result = await tool.execute({
      tasks: [{ description: "hello" }],
    });

    expect(typeof result).toBe("string");
    expect(result as string).toContain("1/1 succeeded");
  });
});
