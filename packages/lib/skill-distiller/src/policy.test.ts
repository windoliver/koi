import { describe, expect, test } from "bun:test";
import type { TaskOutcome } from "./policy.js";
import { createDistillationPolicy } from "./policy.js";

const outcome = (overrides: Partial<TaskOutcome> = {}): TaskOutcome => ({
  traceId: "t1",
  verdict: "verified",
  turnCount: 5,
  toolCallCount: 3,
  ...overrides,
});

describe("createDistillationPolicy", () => {
  test("defaults: accepts verified outcome with enough turns and tools", () => {
    const p = createDistillationPolicy();
    expect(p.shouldDistill(outcome())).toBe(true);
    expect(p.explain(outcome())).toContain("accepted");
  });

  test("rejects failed verdict by default", () => {
    const p = createDistillationPolicy();
    const o = outcome({ verdict: "failed" });
    expect(p.shouldDistill(o)).toBe(false);
    expect(p.explain(o)).toContain("not in accepted set");
  });

  test("rejects when turnCount < minTurns", () => {
    const p = createDistillationPolicy({ minTurns: 3 });
    const o = outcome({ turnCount: 2 });
    expect(p.shouldDistill(o)).toBe(false);
    expect(p.explain(o)).toContain("turnCount 2 < minTurns 3");
  });

  test("rejects when toolCallCount < minToolCalls", () => {
    const p = createDistillationPolicy({ minToolCalls: 2 });
    const o = outcome({ toolCallCount: 1 });
    expect(p.shouldDistill(o)).toBe(false);
    expect(p.explain(o)).toContain("toolCallCount 1 < minToolCalls 2");
  });

  test("custom acceptedVerdicts can include or exclude defaults", () => {
    const onlyApproved = createDistillationPolicy({ acceptedVerdicts: ["approved"] });
    expect(onlyApproved.shouldDistill(outcome({ verdict: "verified" }))).toBe(false);
    expect(onlyApproved.shouldDistill(outcome({ verdict: "approved" }))).toBe(true);
  });

  test("zero minTurns / zero minToolCalls accept any non-failed outcome", () => {
    const p = createDistillationPolicy({ minTurns: 0, minToolCalls: 0 });
    expect(p.shouldDistill(outcome({ turnCount: 0, toolCallCount: 0 }))).toBe(true);
  });

  test("verdict precedence: verdict check fires before count checks", () => {
    const p = createDistillationPolicy({ minTurns: 100, minToolCalls: 100 });
    expect(p.explain(outcome({ verdict: "failed", turnCount: 0, toolCallCount: 0 }))).toContain(
      "not in accepted set",
    );
  });
});
