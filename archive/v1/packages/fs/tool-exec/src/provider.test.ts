import { describe, expect, it } from "bun:test";
import { skillToken } from "@koi/core";
import type { Agent } from "@koi/core/ecs";
import type { SandboxExecutor } from "@koi/core/sandbox-executor";
import { createExecProvider } from "./provider.js";
import { EXEC_SKILL_NAME } from "./skill.js";

/** Minimal mock executor for provider tests. */
const mockExecutor: SandboxExecutor = {
  execute: async () => ({ ok: true as const, value: { output: null, durationMs: 0 } }),
};

/** Helper to get component map from attach result. */
async function attachAndGetMap(
  provider: ReturnType<typeof createExecProvider>,
): Promise<ReadonlyMap<string, unknown>> {
  const result = await provider.attach({} as Agent);
  return result instanceof Map
    ? result
    : (result as { components: ReadonlyMap<string, unknown> }).components;
}

describe("createExecProvider", () => {
  it("has name tool-exec", () => {
    const provider = createExecProvider({ executor: mockExecutor });
    expect(provider.name).toBe("tool-exec");
  });

  it("attaches a tool:exec component", async () => {
    const provider = createExecProvider({ executor: mockExecutor });
    const map = await attachAndGetMap(provider);
    expect(map.has("tool:exec")).toBe(true);
  });

  it("returns a tool with descriptor name exec", async () => {
    const provider = createExecProvider({ executor: mockExecutor });
    const map = await attachAndGetMap(provider);
    const tool = map.get("tool:exec") as { descriptor: { name: string } };
    expect(tool.descriptor.name).toBe("exec");
  });

  it("attaches the exec-guide skill component", async () => {
    const provider = createExecProvider({ executor: mockExecutor });
    const map = await attachAndGetMap(provider);
    const key = skillToken(EXEC_SKILL_NAME) as string;
    expect(map.has(key)).toBe(true);
    const skill = map.get(key) as { name: string; content: string };
    expect(skill.name).toBe("exec-guide");
    expect(skill.content).toContain("exec vs execute_script");
  });

  it("caches components across multiple attach calls", async () => {
    const provider = createExecProvider({ executor: mockExecutor });
    const agent = {} as Agent;
    const first = await provider.attach(agent);
    const second = await provider.attach(agent);
    expect(first).toBe(second);
  });
});
