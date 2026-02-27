import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { createWebProvider } from "./web-component-provider.js";
import type { WebExecutor } from "./web-executor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(): WebExecutor {
  return {
    fetch: async () => ({
      ok: true,
      value: { status: 200, statusText: "OK", headers: {}, body: "", truncated: false },
    }),
    search: async () => ({ ok: true, value: [] }),
  };
}

// Agent stub — only used as a parameter, not queried
const MOCK_AGENT = {} as Parameters<ReturnType<typeof createWebProvider>["attach"]>[0];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createWebProvider", () => {
  test("attaches all tools by default", async () => {
    const provider = createWebProvider({ executor: createMockExecutor() });
    const components = await provider.attach(MOCK_AGENT);

    expect(components.size).toBe(2);
    expect(components.has("tool:web_fetch")).toBe(true);
    expect(components.has("tool:web_search")).toBe(true);
  });

  test("respects custom prefix", async () => {
    const provider = createWebProvider({ executor: createMockExecutor(), prefix: "agent" });
    const components = await provider.attach(MOCK_AGENT);

    expect(components.has("tool:agent_fetch")).toBe(true);
    expect(components.has("tool:agent_search")).toBe(true);
  });

  test("respects operations filter", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      operations: ["fetch"],
    });
    const components = await provider.attach(MOCK_AGENT);

    expect(components.size).toBe(1);
    expect(components.has("tool:web_fetch")).toBe(true);
    expect(components.has("tool:web_search")).toBe(false);
  });

  test("sets trust tier on tools", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      trustTier: "promoted",
    });
    const components = await provider.attach(MOCK_AGENT);

    const fetchTool = components.get("tool:web_fetch") as Tool;
    expect(fetchTool.trustTier).toBe("promoted");
  });

  test("has correct provider name", () => {
    const provider = createWebProvider({ executor: createMockExecutor() });
    expect(provider.name).toBe("web:web");

    const custom = createWebProvider({ executor: createMockExecutor(), prefix: "custom" });
    expect(custom.name).toBe("web:custom");
  });
});
