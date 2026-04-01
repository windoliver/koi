import { describe, expect, test } from "bun:test";
import { createPlanStore } from "./plan-store.js";
import type { CodePlan } from "./types.js";

function makePlan(overrides: Partial<CodePlan> = {}): CodePlan {
  return {
    id: "test-plan-001",
    steps: [],
    state: "pending",
    createdAt: Date.now(),
    hashes: [],
    warnings: [],
    ...overrides,
  };
}

describe("createPlanStore", () => {
  test("starts empty", () => {
    const store = createPlanStore();
    expect(store.get()).toBeUndefined();
  });

  test("stores and retrieves a plan", () => {
    const store = createPlanStore();
    const plan = makePlan();
    store.set(plan);
    expect(store.get()).toEqual(plan);
  });

  test("new plan replaces old plan", () => {
    const store = createPlanStore();
    const old = makePlan({ id: "old" });
    const next = makePlan({ id: "new" });
    store.set(old);
    store.set(next);
    expect(store.get()?.id).toBe("new");
  });

  test("clear removes the plan", () => {
    const store = createPlanStore();
    store.set(makePlan());
    store.clear();
    expect(store.get()).toBeUndefined();
  });

  test("update patches plan state", () => {
    const store = createPlanStore();
    const plan = makePlan({ id: "abc" });
    store.set(plan);
    const updated = store.update("abc", { state: "applied" });
    expect(updated?.state).toBe("applied");
    expect(store.get()?.state).toBe("applied");
  });

  test("update returns undefined for wrong id", () => {
    const store = createPlanStore();
    store.set(makePlan({ id: "abc" }));
    const result = store.update("xyz", { state: "applied" });
    expect(result).toBeUndefined();
  });

  test("update returns undefined when store is empty", () => {
    const store = createPlanStore();
    const result = store.update("abc", { state: "applied" });
    expect(result).toBeUndefined();
  });
});
