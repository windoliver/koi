import { describe, expect, test } from "bun:test";
import type { Agent } from "@koi/core";
import { createOrchestratorProvider } from "./provider.js";
import type { OrchestratorConfig } from "./types.js";

// Minimal mock Agent for testing attach()
const mockAgent = {
  pid: "test-pid",
  manifest: { name: "test" },
  state: "running",
  component: () => undefined,
  has: () => false,
  hasAll: () => false,
  query: () => new Map(),
  components: () => new Map(),
} as unknown as Agent;

describe("createOrchestratorProvider", () => {
  const config: OrchestratorConfig = {
    spawn: async () => ({ ok: true, output: "done" }),
  };

  test("returns a ComponentProvider with name 'orchestrator'", () => {
    const provider = createOrchestratorProvider(config);
    expect(provider.name).toBe("orchestrator");
  });

  test("attach returns 4 tool components", async () => {
    const provider = createOrchestratorProvider(config);
    const components = await provider.attach(mockAgent);
    expect(components.size).toBe(4);
    expect(components.has("tool:orchestrate")).toBe(true);
    expect(components.has("tool:assign_worker")).toBe(true);
    expect(components.has("tool:review_output")).toBe(true);
    expect(components.has("tool:synthesize")).toBe(true);
  });

  test("attach is idempotent (returns cached result)", async () => {
    const provider = createOrchestratorProvider(config);
    const first = await provider.attach(mockAgent);
    const second = await provider.attach(mockAgent);
    expect(first).toBe(second);
  });

  test("tools have execute methods", async () => {
    const provider = createOrchestratorProvider(config);
    const components = await provider.attach(mockAgent);
    for (const [, value] of components) {
      const tool = value as { execute: unknown };
      expect(typeof tool.execute).toBe("function");
    }
  });
});
