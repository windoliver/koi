import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "./assembly.js";
import { createSingleToolProvider } from "./create-single-tool-provider.js";
import type { Agent, AttachResult, ProcessId, SubsystemToken, Tool } from "./ecs.js";
import { agentId, isAttachResult } from "./ecs.js";

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Test helpers — inline (core has zero deps)
// ---------------------------------------------------------------------------

const DEFAULT_PID: ProcessId = {
  id: agentId("test-agent-1"),
  name: "Test Agent",
  type: "worker",
  depth: 0,
};

const DEFAULT_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "0.0.1",
  description: "Test agent",
  model: { name: "test-model" },
};

function createMockAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: DEFAULT_PID,
    manifest: DEFAULT_MANIFEST,
    state: "running",
    component: <T>(t: { toString(): string }): T | undefined =>
      components.get(t as string) as T | undefined,
    has: (t: { toString(): string }): boolean => components.has(t as string),
    hasAll: (...tokens: readonly { toString(): string }[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

function createMockTool(name: string): Tool {
  return {
    descriptor: {
      name,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" },
    },
    trustTier: "verified",
    execute: async () => `${name}-result`,
  };
}

// ---------------------------------------------------------------------------
// createSingleToolProvider
// ---------------------------------------------------------------------------

describe("createSingleToolProvider", () => {
  test("provider name matches config", () => {
    const provider = createSingleToolProvider({
      name: "my-tool-provider",
      toolName: "my_tool",
      createTool: () => createMockTool("my_tool"),
    });
    expect(provider.name).toBe("my-tool-provider");
  });

  test("attaches a single tool under tool:<toolName>", async () => {
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => createMockTool("task"),
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.size).toBe(1);
    expect(components.has("tool:task")).toBe(true);
  });

  test("attached tool is the one returned by createTool", async () => {
    const tool = createMockTool("task");
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => tool,
    });
    const components = extractMap(await provider.attach(createMockAgent()));

    expect(components.get("tool:task")).toBe(tool);
  });

  test("caches components on repeated attach calls", async () => {
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => createMockTool("task"),
    });

    const first = await provider.attach(createMockAgent());
    const second = await provider.attach(createMockAgent());

    expect(first).toBe(second); // same reference
  });

  test("createTool is called only once (cached)", async () => {
    // let justified: counting factory invocations
    let callCount = 0;
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => {
        callCount++;
        return createMockTool("task");
      },
    });

    await provider.attach(createMockAgent());
    await provider.attach(createMockAgent());

    expect(callCount).toBe(1);
  });

  test("forwards priority to provider", () => {
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => createMockTool("task"),
      priority: 50,
    });
    expect(provider.priority).toBe(50);
  });

  test("priority is undefined when not specified", () => {
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => createMockTool("task"),
    });
    expect(provider.priority).toBeUndefined();
  });

  test("does not expose detach", () => {
    const provider = createSingleToolProvider({
      name: "task-spawn",
      toolName: "task",
      createTool: () => createMockTool("task"),
    });
    expect(provider.detach).toBeUndefined();
  });
});
