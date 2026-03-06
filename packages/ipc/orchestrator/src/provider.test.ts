import { describe, expect, test } from "bun:test";
import type { AttachResult } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createOrchestratorProvider } from "./provider.js";
import type { OrchestratorConfig } from "./types.js";

function extractMap(
  result: AttachResult | ReadonlyMap<string, unknown>,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

const mockAgent = createMockAgent();

describe("createOrchestratorProvider", () => {
  const config: OrchestratorConfig = {
    spawn: async () => ({ ok: true, output: "done" }),
  };

  test("returns a ComponentProvider with name 'orchestrator'", () => {
    const provider = createOrchestratorProvider(config);
    expect(provider.name).toBe("orchestrator");
  });

  test("attach returns 4 tool components and 1 skill component", async () => {
    const provider = createOrchestratorProvider(config);
    const components = extractMap(await provider.attach(mockAgent));
    expect(components.size).toBe(5);
    expect(components.has("tool:orchestrate")).toBe(true);
    expect(components.has("tool:assign_worker")).toBe(true);
    expect(components.has("tool:review_output")).toBe(true);
    expect(components.has("tool:synthesize")).toBe(true);
    expect(components.has("skill:orchestrator")).toBe(true);
  });

  test("attach returns fresh state per agent (no shared state)", async () => {
    const provider = createOrchestratorProvider(config);
    const first = extractMap(await provider.attach(mockAgent));
    const second = extractMap(await provider.attach(createMockAgent()));
    // Different map instances — each agent gets its own board, controller, and tools
    expect(first).not.toBe(second);
    expect(first.size).toBe(second.size);
  });

  test("tool components have execute methods", async () => {
    const provider = createOrchestratorProvider(config);
    const components = extractMap(await provider.attach(mockAgent));
    for (const [key, value] of components) {
      if (key.startsWith("tool:")) {
        const tool = value as { execute: unknown };
        expect(typeof tool.execute).toBe("function");
      }
    }
  });
});
