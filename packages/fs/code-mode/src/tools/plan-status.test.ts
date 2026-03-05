import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createPlanStore } from "../plan-store.js";
import type { CodePlan } from "../types.js";
import { createPlanStatusTool } from "./plan-status.js";

function makePlan(overrides: Partial<CodePlan> = {}): CodePlan {
  return {
    id: "plan-001",
    steps: [{ kind: "create", path: "/f.ts", content: "x" }],
    state: "pending",
    createdAt: Date.now(),
    hashes: [],
    warnings: [],
    ...overrides,
  };
}

describe("createPlanStatusTool", () => {
  test("returns empty status when no plan", async () => {
    const store = createPlanStore();
    const tool = createPlanStatusTool(store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as {
      planId: undefined;
      state: undefined;
      stepCount: number;
    };
    expect(result.planId).toBeUndefined();
    expect(result.state).toBeUndefined();
    expect(result.stepCount).toBe(0);
  });

  test("returns plan status when plan exists", async () => {
    const store = createPlanStore();
    store.set(makePlan({ id: "abc", state: "pending" }));
    const tool = createPlanStatusTool(store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as { planId: string; state: string; stepCount: number };
    expect(result.planId).toBe("abc");
    expect(result.state).toBe("pending");
    expect(result.stepCount).toBe(1);
  });

  test("reflects applied state", async () => {
    const store = createPlanStore();
    store.set(makePlan({ state: "applied" }));
    const tool = createPlanStatusTool(store, "code_plan", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as { state: string };
    expect(result.state).toBe("applied");
  });
});
