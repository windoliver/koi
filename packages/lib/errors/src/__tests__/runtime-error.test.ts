import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { KoiRuntimeError } from "../runtime-error.js";

describe("KoiRuntimeError", () => {
  test("is an instance of Error", () => {
    const err = KoiRuntimeError.from("VALIDATION", "bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KoiRuntimeError);
  });

  test("has a stack trace", () => {
    const err = KoiRuntimeError.from("INTERNAL", "something broke");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("KoiRuntimeError");
  });

  test("sets name to KoiRuntimeError", () => {
    const err = KoiRuntimeError.from("NOT_FOUND", "missing");
    expect(err.name).toBe("KoiRuntimeError");
  });

  test("preserves code, message, and retryable from KoiError", () => {
    const koiError: KoiError = {
      code: "RATE_LIMIT",
      message: "slow down",
      retryable: true,
    };
    const err = new KoiRuntimeError(koiError);
    expect(err.code).toBe("RATE_LIMIT");
    expect(err.message).toBe("slow down");
    expect(err.retryable).toBe(true);
  });

  test("preserves optional fields when present", () => {
    const koiError: KoiError = {
      code: "TIMEOUT",
      message: "took too long",
      retryable: true,
      cause: new Error("upstream"),
      context: { toolId: "search" },
      retryAfterMs: 5000,
    };
    const err = new KoiRuntimeError(koiError);
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.context).toEqual({ toolId: "search" });
    expect(err.retryAfterMs).toBe(5000);
  });

  test("omits optional fields when absent", () => {
    const koiError: KoiError = {
      code: "VALIDATION",
      message: "bad",
      retryable: false,
    };
    const err = new KoiRuntimeError(koiError);
    expect(err.context).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
    expect(err.cause).toBeUndefined();
  });
});

describe("KoiRuntimeError.from", () => {
  test("uses RETRYABLE_DEFAULTS when retryable not specified", () => {
    const rateLimitErr = KoiRuntimeError.from("RATE_LIMIT", "slow");
    expect(rateLimitErr.retryable).toBe(true);

    const validationErr = KoiRuntimeError.from("VALIDATION", "bad");
    expect(validationErr.retryable).toBe(false);

    const timeoutErr = KoiRuntimeError.from("TIMEOUT", "late");
    expect(timeoutErr.retryable).toBe(true);
  });

  test("allows overriding retryable", () => {
    const err = KoiRuntimeError.from("VALIDATION", "bad", { retryable: true });
    expect(err.retryable).toBe(true);
  });

  test("accepts cause, context, and retryAfterMs", () => {
    const cause = new Error("root");
    const err = KoiRuntimeError.from("EXTERNAL", "upstream fail", {
      cause,
      context: { service: "api" },
      retryAfterMs: 3000,
    });
    expect(err.cause).toBe(cause);
    expect(err.context).toEqual({ service: "api" });
    expect(err.retryAfterMs).toBe(3000);
  });
});

describe("toKoiError", () => {
  test("converts back to a plain KoiError", () => {
    const err = KoiRuntimeError.from("PERMISSION", "denied", {
      context: { toolId: "bash" },
    });
    const koiError = err.toKoiError();
    expect(koiError.code).toBe("PERMISSION");
    expect(koiError.message).toBe("denied");
    expect(koiError.retryable).toBe(false);
    expect(koiError.context).toEqual({ toolId: "bash" });
    // Should not include undefined optional fields
    expect("retryAfterMs" in koiError).toBe(false);
    expect("cause" in koiError).toBe(false);
  });

  test("includes optional fields when present", () => {
    const err = KoiRuntimeError.from("TIMEOUT", "late", {
      cause: "boom",
      retryAfterMs: 1000,
    });
    const koiError = err.toKoiError();
    expect(koiError.cause).toBe("boom");
    expect(koiError.retryAfterMs).toBe(1000);
  });
});

describe("toJSON", () => {
  test("serializes required fields", () => {
    const err = KoiRuntimeError.from("VALIDATION", "bad input");
    const json = err.toJSON();
    expect(json.code).toBe("VALIDATION");
    expect(json.message).toBe("bad input");
    expect(json.retryable).toBe(false);
    expect(json.stack).toBeDefined();
  });

  test("includes optional fields when present", () => {
    const err = KoiRuntimeError.from("TIMEOUT", "slow", {
      context: { toolId: "search" },
      retryAfterMs: 5000,
    });
    const json = err.toJSON();
    expect(json.context).toEqual({ toolId: "search" });
    expect(json.retryAfterMs).toBe(5000);
  });

  test("omits optional fields when absent", () => {
    const err = KoiRuntimeError.from("INTERNAL", "oops");
    const json = err.toJSON();
    expect("context" in json).toBe(false);
    expect("retryAfterMs" in json).toBe(false);
  });

  test("produces valid JSON via JSON.stringify", () => {
    const err = KoiRuntimeError.from("RATE_LIMIT", "slow down", {
      context: { remaining: 0 },
      retryAfterMs: 3000,
    });
    const str = JSON.stringify(err);
    const parsed = JSON.parse(str);
    expect(parsed.code).toBe("RATE_LIMIT");
    expect(parsed.message).toBe("slow down");
    expect(parsed.retryable).toBe(true);
    expect(parsed.context).toEqual({ remaining: 0 });
    expect(parsed.retryAfterMs).toBe(3000);
  });

  test("does not include cause (non-serializable)", () => {
    const err = KoiRuntimeError.from("EXTERNAL", "fail", {
      cause: new Error("root"),
    });
    const json = err.toJSON();
    expect("cause" in json).toBe(false);
  });
});

describe("catch compatibility", () => {
  test("caught by instanceof Error", () => {
    try {
      throw KoiRuntimeError.from("INTERNAL", "bug");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(KoiRuntimeError);
      if (e instanceof KoiRuntimeError) {
        expect(e.code).toBe("INTERNAL");
      }
    }
  });

  test("works with Error.cause chaining", () => {
    const inner = KoiRuntimeError.from("EXTERNAL", "db down");
    const outer = new Error("operation failed", { cause: inner });
    expect(outer.cause).toBeInstanceOf(KoiRuntimeError);
  });
});
