import { describe, expect, test } from "bun:test";
import {
  createAsyncValidator,
  createFailingValidator,
  createMockTurnContext,
  createMockValidator,
  createThrowingValidator,
} from "@koi/test-utils";
import { runValidators } from "./validators.js";

const ctx = createMockTurnContext();

describe("runValidators", () => {
  test("returns valid when no validators", async () => {
    const result = await runValidators("output", [], ctx);
    expect(result.valid).toBe(true);
  });

  test("returns valid when all validators pass", async () => {
    const validators = [createMockValidator("v1"), createMockValidator("v2")];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(true);
  });

  test("collects errors from all failing validators", async () => {
    const validators = [
      createFailingValidator([{ validator: "v1", message: "bad format" }], "v1"),
      createFailingValidator([{ validator: "v2", message: "too long" }], "v2"),
    ];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]?.validator).toBe("v1");
      expect(result.errors[1]?.validator).toBe("v2");
    }
  });

  test("collects multiple errors from one validator", async () => {
    const validators = [
      createFailingValidator(
        [
          { validator: "v1", message: "err 1" },
          { validator: "v1", message: "err 2" },
        ],
        "v1",
      ),
    ];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(2);
    }
  });

  test("runs validators sequentially (order preserved)", async () => {
    const order: string[] = [];
    const validators = [
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
    await runValidators("output", validators, ctx);
    expect(order).toEqual(["first", "second"]);
  });

  test("awaits async validators", async () => {
    const validators = [createAsyncValidator(10, { valid: true }, "async-v")];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(true);
  });

  test("wraps validator throws as non-retryable error", async () => {
    const validators = [createThrowingValidator(new Error("boom"), "thrower")];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.validator).toBe("thrower");
      expect(result.errors[0]?.message).toContain("boom");
      expect(result.errors[0]?.retryable).toBe(false);
    }
  });

  test("continues after validator throws and collects remaining errors", async () => {
    const validators = [
      createThrowingValidator(new Error("exploded"), "thrower"),
      createFailingValidator([{ validator: "v2", message: "also bad" }], "v2"),
    ];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(2);
    }
  });

  test("mixes passing and failing validators", async () => {
    const validators = [
      createMockValidator("pass"),
      createFailingValidator([{ validator: "fail", message: "nope" }], "fail"),
      createMockValidator("pass2"),
    ];
    const result = await runValidators("output", validators, ctx);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.validator).toBe("fail");
    }
  });
});
