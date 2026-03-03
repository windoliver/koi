import { describe, expect, test } from "bun:test";
import {
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createThrowingValidator,
} from "@koi/test-utils";
import { runGates } from "./gate.js";

const ctx = createMockTurnContext();

describe("runGates", () => {
  test("returns valid when no gates", async () => {
    const result = await runGates("output", [], ctx);
    expect(result.valid).toBe(true);
  });

  test("returns valid when all gates pass", async () => {
    const gates = [createMockValidator("g1"), createMockValidator("g2")];
    const result = await runGates("output", gates, ctx);
    expect(result.valid).toBe(true);
  });

  test("reports first failing gate name", async () => {
    const gates = [
      createMockValidator("pass"),
      createFailingValidator([{ validator: "blocker", message: "blocked" }], "blocker"),
      createFailingValidator([{ validator: "also-fail", message: "also" }], "also-fail"),
    ];
    const result = await runGates("output", gates, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.failedGate).toBe("blocker");
    }
  });

  test("collects errors from all failing gates", async () => {
    const gates = [
      createFailingValidator([{ validator: "g1", message: "err1" }], "g1"),
      createFailingValidator([{ validator: "g2", message: "err2" }], "g2"),
    ];
    const result = await runGates("output", gates, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(2);
    }
  });

  test("runs gates sequentially", async () => {
    const order: string[] = [];
    const gates = [
      {
        name: "first",
        validate: () => {
          order.push("first");
          return { valid: true as const };
        },
      },
      {
        name: "second",
        validate: () => {
          order.push("second");
          return { valid: true as const };
        },
      },
    ];
    await runGates("output", gates, ctx);
    expect(order).toEqual(["first", "second"]);
  });

  test("wraps gate throws as error with gate name", async () => {
    const gates = [createThrowingValidator(new Error("gate exploded"), "boom-gate")];
    const result = await runGates("output", gates, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.failedGate).toBe("boom-gate");
      expect(result.errors[0]?.message).toContain("gate exploded");
      expect(result.errors[0]?.retryable).toBe(false);
    }
  });
});
