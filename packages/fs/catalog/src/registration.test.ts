import { describe, expect, test } from "bun:test";
import type { Agent, CatalogReader, Tool } from "@koi/core";
import { createCatalogRegistration } from "./registration.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function stubAgent(): Agent {
  const components = new Map<string, unknown>();
  return {
    pid: {
      id: "test-agent" as import("@koi/core").AgentId,
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

function stubReader(): CatalogReader {
  return {
    search: async () => ({ items: [] }),
    get: async () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "stub", retryable: false },
    }),
  };
}

// ---------------------------------------------------------------------------
// createCatalogRegistration
// ---------------------------------------------------------------------------

describe("createCatalogRegistration", () => {
  test("returns a ToolRegistration with correct name", () => {
    const reg = createCatalogRegistration({ reader: stubReader() });
    expect(reg.name).toBe("catalog");
  });

  test("provides two tool factories", () => {
    const reg = createCatalogRegistration({ reader: stubReader() });
    expect(reg.tools).toHaveLength(2);
    expect(reg.tools[0]?.name).toBe("search_catalog");
    expect(reg.tools[1]?.name).toBe("attach_capability");
  });

  test("tool factories produce valid Tool objects", async () => {
    const reg = createCatalogRegistration({ reader: stubReader() });
    const agent = stubAgent();

    for (const factory of reg.tools) {
      const tool = (await factory.create(agent)) as Tool;
      expect(tool.descriptor).toBeDefined();
      expect(tool.descriptor.name).toBe(factory.name);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("has no availability check (catalog is always available)", () => {
    const reg = createCatalogRegistration({ reader: stubReader() });
    expect(reg.checkAvailability).toBeUndefined();
  });
});
