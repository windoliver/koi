import { describe, expect, test } from "bun:test";
import { KoiEngineError } from "./errors.js";

describe("KoiEngineError", () => {
  test("extends Error", () => {
    const err = KoiEngineError.from("INTERNAL", "something broke");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KoiEngineError);
  });

  test("has correct name", () => {
    const err = KoiEngineError.from("TIMEOUT", "too slow");
    expect(err.name).toBe("KoiEngineError");
  });

  test("carries code and message", () => {
    const err = KoiEngineError.from("NOT_FOUND", "user missing");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("user missing");
  });

  test("defaults retryable to false", () => {
    const err = KoiEngineError.from("INTERNAL", "fail");
    expect(err.retryable).toBe(false);
  });

  test("accepts retryable override", () => {
    const err = KoiEngineError.from("TIMEOUT", "slow", { retryable: true });
    expect(err.retryable).toBe(true);
  });

  test("carries cause via ES2022 chain", () => {
    const original = new Error("root cause");
    const err = KoiEngineError.from("EXTERNAL", "upstream fail", { cause: original });
    expect(err.cause).toBe(original);
  });

  test("carries context metadata", () => {
    const err = KoiEngineError.from("TIMEOUT", "limit", {
      context: { turns: 25, maxTurns: 25 },
    });
    expect(err.context).toEqual({ turns: 25, maxTurns: 25 });
  });

  test("carries retryAfterMs", () => {
    const err = KoiEngineError.from("RATE_LIMIT", "too fast", {
      retryable: true,
      retryAfterMs: 5000,
    });
    expect(err.retryAfterMs).toBe(5000);
  });

  test("context and retryAfterMs are undefined when not provided", () => {
    const err = KoiEngineError.from("INTERNAL", "fail");
    expect(err.context).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
  });

  test("constructor accepts KoiError interface", () => {
    const err = new KoiEngineError({
      code: "VALIDATION",
      message: "invalid input",
      retryable: false,
    });
    expect(err.code).toBe("VALIDATION");
    expect(err.message).toBe("invalid input");
    expect(err.retryable).toBe(false);
  });

  test("is catchable as Error", () => {
    try {
      throw KoiEngineError.from("PERMISSION", "denied");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(KoiEngineError);
      if (e instanceof KoiEngineError) {
        expect(e.code).toBe("PERMISSION");
      }
    }
  });

  test("stack trace is available", () => {
    const err = KoiEngineError.from("INTERNAL", "bug");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("KoiEngineError");
  });
});
