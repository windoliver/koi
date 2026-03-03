import { describe, expect, test } from "bun:test";
import type { AttachResult, Tool } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createWebProvider } from "./web-component-provider.js";
import type { WebExecutor } from "./web-executor.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockExecutor(): WebExecutor {
  return {
    fetch: async () => ({
      ok: true,
      value: {
        status: 200,
        statusText: "OK",
        headers: {},
        body: "",
        truncated: false,
        finalUrl: "",
      },
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
    const components = extractMap(await provider.attach(MOCK_AGENT));

    // 2 tools + 1 skill
    expect(components.size).toBe(3);
    expect(components.has("tool:web_fetch")).toBe(true);
    expect(components.has("tool:web_search")).toBe(true);
    expect(components.has("skill:web")).toBe(true);
  });

  test("respects custom prefix", async () => {
    const provider = createWebProvider({ executor: createMockExecutor(), prefix: "agent" });
    const components = extractMap(await provider.attach(MOCK_AGENT));

    expect(components.has("tool:agent_fetch")).toBe(true);
    expect(components.has("tool:agent_search")).toBe(true);
  });

  test("respects operations filter", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      operations: ["fetch"],
    });
    const components = extractMap(await provider.attach(MOCK_AGENT));

    // 1 tool + 1 skill
    expect(components.size).toBe(2);
    expect(components.has("tool:web_fetch")).toBe(true);
    expect(components.has("tool:web_search")).toBe(false);
    expect(components.has("skill:web")).toBe(true);
  });

  test("sets trust tier on tools", async () => {
    const provider = createWebProvider({
      executor: createMockExecutor(),
      trustTier: "promoted",
    });
    const components = extractMap(await provider.attach(MOCK_AGENT));

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
