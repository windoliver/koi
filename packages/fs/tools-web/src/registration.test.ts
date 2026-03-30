import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, Tool } from "@koi/core";
import { createWebRegistration } from "./registration.js";
import type { WebExecutor } from "./web-executor.js";

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

function stubExecutor(): WebExecutor {
  return {
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: {},
      body: "stub",
      url: "https://example.com",
      cached: false,
    }),
    search: async () => ({
      results: [],
      cached: false,
    }),
  } as unknown as WebExecutor;
}

// ---------------------------------------------------------------------------
// createWebRegistration
// ---------------------------------------------------------------------------

describe("createWebRegistration", () => {
  test("returns a ToolRegistration with correct name", () => {
    const reg = createWebRegistration({ executor: stubExecutor() });
    expect(reg.name).toBe("web");
  });

  test("provides two tool factories", () => {
    const reg = createWebRegistration({ executor: stubExecutor() });
    expect(reg.tools).toHaveLength(2);
    expect(reg.tools[0]?.name).toBe("web_fetch");
    expect(reg.tools[1]?.name).toBe("web_search");
  });

  test("tool factories produce valid Tool objects", async () => {
    const reg = createWebRegistration({ executor: stubExecutor() });
    const agent = stubAgent();

    for (const factory of reg.tools) {
      const tool = (await factory.create(agent)) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.descriptor.name).toBe(factory.name);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("respects custom prefix", () => {
    const reg = createWebRegistration({
      executor: stubExecutor(),
      prefix: "browse",
    });
    expect(reg.tools[0]?.name).toBe("browse_fetch");
    expect(reg.tools[1]?.name).toBe("browse_search");
  });

  test("respects operations filter", () => {
    const reg = createWebRegistration({
      executor: stubExecutor(),
      operations: ["fetch"],
    });
    expect(reg.tools).toHaveLength(1);
    expect(reg.tools[0]?.name).toBe("web_fetch");
  });
});
