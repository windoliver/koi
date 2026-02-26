import { describe, expect, test } from "bun:test";
import type { Agent } from "@koi/core";
import { agentId, GOVERNANCE } from "@koi/core";
import type { GovernanceControllerBuilder } from "./governance-controller.js";
import { createGovernanceProvider } from "./governance-provider.js";

function mockAgent(depth = 0): Agent {
  return {
    pid: { id: agentId("test-agent"), name: "test", type: "copilot", depth },
    manifest: { name: "test", version: "0.0.0", model: { name: "test" } },
    state: "created",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

describe("createGovernanceProvider", () => {
  test("returns a ComponentProvider with correct name and priority", () => {
    const provider = createGovernanceProvider();
    expect(provider.name).toBe("koi:governance");
    expect(provider.priority).toBe(100);
  });

  test("attaches GovernanceControllerBuilder under GOVERNANCE key", async () => {
    const provider = createGovernanceProvider();
    const components = await provider.attach(mockAgent());
    const builder = components.get(GOVERNANCE as string) as GovernanceControllerBuilder | undefined;
    expect(builder).toBeDefined();
    expect(typeof builder?.check).toBe("function");
    expect(typeof builder?.register).toBe("function");
    expect(typeof builder?.seal).toBe("function");
    expect(builder?.sealed).toBe(false);
  });

  test("passes agent depth to controller", async () => {
    const provider = createGovernanceProvider({ spawn: { maxDepth: 2, maxFanOut: 5 } });
    const agent = mockAgent(3);
    const components = await provider.attach(agent);
    const builder = components.get(GOVERNANCE as string) as GovernanceControllerBuilder | undefined;
    expect(builder).toBeDefined();
    if (builder === undefined) throw new Error("builder not found");
    // Depth 3 > maxDepth 2 → check should fail
    const result = await builder.check("spawn_depth");
    expect(result.ok).toBe(false);
  });

  test("passes custom config to controller", async () => {
    const provider = createGovernanceProvider({
      iteration: { maxTurns: 5, maxTokens: 1000, maxDurationMs: 10000 },
    });
    const components = await provider.attach(mockAgent());
    const builder = components.get(GOVERNANCE as string) as GovernanceControllerBuilder | undefined;
    expect(builder).toBeDefined();
    if (builder === undefined) throw new Error("builder not found");
    const vars = builder.variables();
    const turnVar = vars.get("turn_count");
    expect(turnVar?.limit).toBe(5);
  });
});
