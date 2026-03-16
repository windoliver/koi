/**
 * Integration test — verifies the full provider attachment flow.
 *
 * createContextHubProvider() → attach(agent) → tools + skill available via tokens.
 */

import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { skillToken, toolToken } from "@koi/core";
import type { ChubGetResult, ContextHubExecutor } from "../context-hub-executor.js";
import { createContextHubProvider } from "../provider.js";
import { CONTEXT_HUB_SKILL_NAME } from "../skill.js";

// ---------------------------------------------------------------------------
// Stub executor (returns empty results — we're testing wiring, not logic)
// ---------------------------------------------------------------------------

const stubExecutor: ContextHubExecutor = {
  search: async () => ({ ok: true as const, value: [] }),
  get: async () => ({
    ok: true as const,
    value: {
      id: "test",
      content: "# Test",
      language: "javascript",
      version: "1.0.0",
      truncated: false,
    } satisfies ChubGetResult,
  }),
};

// ---------------------------------------------------------------------------
// Stub agent (minimal implementation for attach)
// ---------------------------------------------------------------------------

function createStubAgent(): { readonly component: (key: string) => unknown } {
  return { component: () => undefined };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createContextHubProvider integration", () => {
  test("attaches both tools and skill component", async () => {
    const provider = createContextHubProvider({ executor: stubExecutor });
    const agent = createStubAgent();

    const components = (await provider.attach(agent as never)) as ReadonlyMap<string, unknown>;

    // Verify tools are registered
    const searchTool = components.get(toolToken("chub_search") as string);
    const getTool = components.get(toolToken("chub_get") as string);
    expect(searchTool).toBeDefined();
    expect(getTool).toBeDefined();

    // Verify tool shape
    const search = searchTool as Tool;
    expect(search.descriptor.name).toBe("chub_search");
    expect(search.origin).toBe("primordial");
    expect(typeof search.execute).toBe("function");

    const get = getTool as Tool;
    expect(get.descriptor.name).toBe("chub_get");
    expect(get.origin).toBe("primordial");
    expect(typeof get.execute).toBe("function");

    // Verify skill is registered
    const skill = components.get(skillToken(CONTEXT_HUB_SKILL_NAME) as string);
    expect(skill).toBeDefined();
  });

  test("provider has correct name", () => {
    const provider = createContextHubProvider({ executor: stubExecutor });
    expect(provider.name).toBe("context-hub:chub");
  });

  test("custom prefix changes tool names", async () => {
    const provider = createContextHubProvider({ executor: stubExecutor, prefix: "docs" });
    const agent = createStubAgent();

    const components = (await provider.attach(agent as never)) as ReadonlyMap<string, unknown>;

    const searchTool = components.get(toolToken("docs_search") as string) as Tool;
    expect(searchTool.descriptor.name).toBe("docs_search");

    const getTool = components.get(toolToken("docs_get") as string) as Tool;
    expect(getTool.descriptor.name).toBe("docs_get");
  });

  test("operations filter limits attached tools", async () => {
    const provider = createContextHubProvider({
      executor: stubExecutor,
      operations: ["search"],
    });
    const agent = createStubAgent();

    const components = (await provider.attach(agent as never)) as ReadonlyMap<string, unknown>;

    expect(components.get(toolToken("chub_search") as string)).toBeDefined();
    expect(components.get(toolToken("chub_get") as string)).toBeUndefined();
  });

  test("total component count matches tools + skill", async () => {
    const provider = createContextHubProvider({ executor: stubExecutor });
    const agent = createStubAgent();

    const components = (await provider.attach(agent as never)) as ReadonlyMap<string, unknown>;

    // 2 tools + 1 skill = 3 components
    expect(components.size).toBe(3);
  });
});
