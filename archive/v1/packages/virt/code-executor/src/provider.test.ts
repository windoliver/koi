import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AgentManifest,
  AttachResult,
  ProcessId,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { agentId, DEFAULT_UNSANDBOXED_POLICY, isAttachResult, toolToken } from "@koi/core";
import { createCodeExecutorProvider } from "./provider.js";

/** Extract ReadonlyMap from attach() result (handles both AttachResult and bare Map). */
function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

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

function createMockTool(name: string): Tool {
  return {
    descriptor: {
      name,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object" },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async () => `${name}-result`,
  };
}

function createMockAgent(existingTools?: readonly Tool[]): Agent {
  const components = new Map<string, unknown>();
  if (existingTools) {
    for (const tool of existingTools) {
      components.set(toolToken(tool.descriptor.name) as string, tool);
    }
  }

  return {
    pid: DEFAULT_PID,
    manifest: DEFAULT_MANIFEST,
    state: "running",
    component: <T>(t: { toString(): string }): T | undefined =>
      components.get(t as string) as T | undefined,
    has: (t: { toString(): string }): boolean => components.has(t as string),
    hasAll: (...tokens: readonly { toString(): string }[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(prefix: string): ReadonlyMap<SubsystemToken<T>, T> => {
      const result = new Map<SubsystemToken<T>, T>();
      for (const [key, value] of components) {
        if (key.startsWith(prefix)) {
          result.set(key as SubsystemToken<T>, value as T);
        }
      }
      return result;
    },
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

describe("createCodeExecutorProvider", () => {
  test("provider name is 'code-executor'", () => {
    const provider = createCodeExecutorProvider();
    expect(provider.name).toBe("code-executor");
  });

  test("attaches execute_script tool", async () => {
    const agent = createMockAgent([createMockTool("file_read")]);
    const provider = createCodeExecutorProvider();
    const components = extractMap(await provider.attach(agent));

    expect(components.size).toBe(1);
    expect(components.has(toolToken("execute_script") as string)).toBe(true);
  });

  test("execute_script excludes itself from tool map", async () => {
    // If agent already has execute_script (shouldn't happen, but defensive)
    const agent = createMockAgent([createMockTool("file_read"), createMockTool("execute_script")]);
    const provider = createCodeExecutorProvider();
    const components = extractMap(await provider.attach(agent));

    // Provider should still attach its own execute_script (first-write-wins at assembly)
    expect(components.has(toolToken("execute_script") as string)).toBe(true);
  });

  test("attaches with correct priority (after bundled)", () => {
    const provider = createCodeExecutorProvider();
    expect(provider.priority).toBe(110); // COMPONENT_PRIORITY.BUNDLED (100) + 10
  });

  test("works with no existing tools", async () => {
    const agent = createMockAgent();
    const provider = createCodeExecutorProvider();
    const components = extractMap(await provider.attach(agent));

    expect(components.size).toBe(1);
    const tool = components.get(toolToken("execute_script") as string) as Tool;
    expect(tool.descriptor.name).toBe("execute_script");
  });
});
