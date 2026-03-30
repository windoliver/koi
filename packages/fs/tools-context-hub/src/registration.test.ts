import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, Tool } from "@koi/core";
import type { ContextHubExecutor } from "./context-hub-executor.js";
import { createContextHubRegistration } from "./registration.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: "test-agent" as AgentId,
      name: "test",
      type: "copilot",
      depth: 0,
    },
    manifest: { name: "test", version: "0.1.0", model: { name: "test-model" } },
    state: "created",
    component: (token) => components.get(token as string) as undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
}

function stubExecutor(): ContextHubExecutor {
  return {
    search: async () => ({
      results: [],
      cached: false,
    }),
    get: async () => ({
      ok: true as const,
      content: "stub",
      cached: false,
    }),
  } as unknown as ContextHubExecutor;
}

// ---------------------------------------------------------------------------
// createContextHubRegistration
// ---------------------------------------------------------------------------

describe("createContextHubRegistration", () => {
  test("returns a ToolRegistration with correct name", () => {
    const reg = createContextHubRegistration({ executor: stubExecutor() });
    expect(reg.name).toBe("context-hub");
  });

  test("provides two tool factories", () => {
    const reg = createContextHubRegistration({ executor: stubExecutor() });
    expect(reg.tools).toHaveLength(2);
    expect(reg.tools[0]?.name).toBe("chub_search");
    expect(reg.tools[1]?.name).toBe("chub_get");
  });

  test("tool factories produce valid Tool objects", async () => {
    const reg = createContextHubRegistration({ executor: stubExecutor() });
    const agent = stubAgent();

    for (const factory of reg.tools) {
      const tool = (await factory.create(agent)) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.descriptor.name).toBe(factory.name);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("respects custom prefix", () => {
    const reg = createContextHubRegistration({
      executor: stubExecutor(),
      prefix: "docs",
    });
    expect(reg.tools[0]?.name).toBe("docs_search");
    expect(reg.tools[1]?.name).toBe("docs_get");
  });

  test("respects operations filter", () => {
    const reg = createContextHubRegistration({
      executor: stubExecutor(),
      operations: ["get"],
    });
    expect(reg.tools).toHaveLength(1);
    expect(reg.tools[0]?.name).toBe("chub_get");
  });
});
