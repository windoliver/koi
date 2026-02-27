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

  test("attach returns 4 tool components", async () => {
    const provider = createOrchestratorProvider(config);
    const components = extractMap(await provider.attach(mockAgent));
    expect(components.size).toBe(4);
    expect(components.has("tool:orchestrate")).toBe(true);
    expect(components.has("tool:assign_worker")).toBe(true);
    expect(components.has("tool:review_output")).toBe(true);
    expect(components.has("tool:synthesize")).toBe(true);
  });

  test("attach is idempotent (returns cached result)", async () => {
    const provider = createOrchestratorProvider(config);
    const first = extractMap(await provider.attach(mockAgent));
    const second = extractMap(await provider.attach(mockAgent));
    expect(first).toBe(second);
  });

  test("tools have execute methods", async () => {
    const provider = createOrchestratorProvider(config);
    const components = extractMap(await provider.attach(mockAgent));
    for (const [, value] of components) {
      const tool = value as { execute: unknown };
      expect(typeof tool.execute).toBe("function");
    }
  });
});
