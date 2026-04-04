import { describe, expect, test } from "bun:test";
import { toolToken } from "@koi/core";
import { createMemoryToolProvider } from "./provider.js";
import { mockBackend } from "./tools/__test-utils.js";

describe("createMemoryToolProvider", () => {
  test("builds successfully with default config", () => {
    const result = createMemoryToolProvider({ backend: mockBackend() });
    expect(result.ok).toBe(true);
  });

  test("provider has correct name", () => {
    const result = createMemoryToolProvider({ backend: mockBackend() });
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.name).toBe("memory-tools");
  });

  test("provider has custom prefix in name", () => {
    const result = createMemoryToolProvider({
      backend: mockBackend(),
      prefix: "agent",
    });
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.name).toBe("agent-tools");
  });

  test("attach returns all 4 tools", async () => {
    const result = createMemoryToolProvider({ backend: mockBackend() });
    if (!result.ok) throw new Error("Expected ok");

    // Use a minimal mock agent
    const mockAgent = {} as Parameters<typeof result.value.attach>[0];
    const attachResult = await result.value.attach(mockAgent);

    // AttachResult has components map
    const components = "components" in attachResult ? attachResult.components : attachResult;

    expect(components.has(toolToken("memory_store") as string)).toBe(true);
    expect(components.has(toolToken("memory_recall") as string)).toBe(true);
    expect(components.has(toolToken("memory_search") as string)).toBe(true);
    expect(components.has(toolToken("memory_delete") as string)).toBe(true);
  });

  test("attach returns tools with custom prefix", async () => {
    const result = createMemoryToolProvider({
      backend: mockBackend(),
      prefix: "m",
    });
    if (!result.ok) throw new Error("Expected ok");

    const mockAgent = {} as Parameters<typeof result.value.attach>[0];
    const attachResult = await result.value.attach(mockAgent);
    const components = "components" in attachResult ? attachResult.components : attachResult;

    expect(components.has(toolToken("m_store") as string)).toBe(true);
    expect(components.has(toolToken("m_recall") as string)).toBe(true);
    expect(components.has(toolToken("m_search") as string)).toBe(true);
    expect(components.has(toolToken("m_delete") as string)).toBe(true);
  });
});
