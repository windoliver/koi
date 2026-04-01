import { describe, expect, test } from "bun:test";
import type { MemoryComponent } from "@koi/core";
import { MEMORY } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { resolveMemorySource } from "./memory.js";

function createAgentWithMemory(
  results: readonly { content: string }[],
): ReturnType<typeof createMockAgent> {
  const memory: MemoryComponent = {
    async recall() {
      return results.map((r) => ({ content: r.content }));
    },
    async store() {},
  };
  return createMockAgent({
    components: new Map([[MEMORY as string, memory]]),
  });
}

describe("resolveMemorySource", () => {
  test("recalls memory results and joins them", async () => {
    const agent = createAgentWithMemory([{ content: "fact 1" }, { content: "fact 2" }]);

    const result = await resolveMemorySource({ kind: "memory", query: "user preferences" }, agent);
    expect(result.content).toBe("fact 1\n\nfact 2");
  });

  test("uses query as part of default label", async () => {
    const agent = createAgentWithMemory([{ content: "test" }]);
    const result = await resolveMemorySource({ kind: "memory", query: "my query" }, agent);
    expect(result.label).toBe("Memory: my query");
  });

  test("uses custom label when provided", async () => {
    const agent = createAgentWithMemory([{ content: "test" }]);
    const result = await resolveMemorySource(
      { kind: "memory", query: "q", label: "User Prefs" },
      agent,
    );
    expect(result.label).toBe("User Prefs");
  });

  test("throws when agent has no MemoryComponent", async () => {
    const agent = createMockAgent();
    await expect(resolveMemorySource({ kind: "memory", query: "q" }, agent)).rejects.toThrow(
      "Agent has no MemoryComponent attached",
    );
  });

  test("returns empty content when recall returns empty", async () => {
    const agent = createAgentWithMemory([]);
    const result = await resolveMemorySource({ kind: "memory", query: "nothing" }, agent);
    expect(result.content).toBe("");
  });
});
