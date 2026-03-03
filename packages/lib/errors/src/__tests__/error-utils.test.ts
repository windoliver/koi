import { describe, expect, test } from "bun:test";
import {
  extractCode,
  extractMessage,
  isContextOverflowError,
  isKoiError,
  swallowError,
  toKoiError,
} from "../error-utils.js";

describe("extractMessage", () => {
  test("extracts message from Error instance", () => {
    expect(extractMessage(new Error("boom"))).toBe("boom");
  });

  test("returns string as-is", () => {
    expect(extractMessage("something failed")).toBe("something failed");
  });

  test("converts number to string", () => {
    expect(extractMessage(42)).toBe("42");
  });

  test("converts null to string", () => {
    expect(extractMessage(null)).toBe("null");
  });

  test("converts undefined to string", () => {
    expect(extractMessage(undefined)).toBe("undefined");
  });

  test("converts object to string", () => {
    expect(extractMessage({ foo: "bar" })).toBe("[object Object]");
  });
});

describe("extractCode", () => {
  test("extracts code from object with code property", () => {
    expect(extractCode({ code: "ENOENT" })).toBe("ENOENT");
  });

  test("converts numeric code to string", () => {
    expect(extractCode({ code: 42 })).toBe("42");
  });

  test("returns undefined for plain Error without code", () => {
    expect(extractCode(new Error("no code"))).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(extractCode(null)).toBeUndefined();
  });

  test("returns undefined for string", () => {
    expect(extractCode("not an object")).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(extractCode(undefined)).toBeUndefined();
  });

  test("extracts code from Error-like object with code", () => {
    const err = Object.assign(new Error("fail"), { code: "SQLITE_BUSY" });
    expect(extractCode(err)).toBe("SQLITE_BUSY");
  });
});

describe("isKoiError", () => {
  test("returns true for valid KoiError", () => {
    expect(isKoiError({ code: "INTERNAL", message: "fail", retryable: false })).toBe(true);
  });

  test("returns true for all 8 valid codes", () => {
    const codes = [
      "VALIDATION",
      "NOT_FOUND",
      "PERMISSION",
      "CONFLICT",
      "RATE_LIMIT",
      "TIMEOUT",
      "EXTERNAL",
      "INTERNAL",
    ] as const;
    for (const code of codes) {
      expect(isKoiError({ code, message: "test", retryable: false })).toBe(true);
    }
  });

  test("returns false for invalid code", () => {
    expect(isKoiError({ code: "UNKNOWN", message: "test", retryable: false })).toBe(false);
  });

  test("returns false for missing message", () => {
    expect(isKoiError({ code: "INTERNAL", retryable: false })).toBe(false);
  });

  test("returns false for missing retryable", () => {
    expect(isKoiError({ code: "INTERNAL", message: "fail" })).toBe(false);
  });

  test("returns false for non-boolean retryable", () => {
    expect(isKoiError({ code: "INTERNAL", message: "fail", retryable: "yes" })).toBe(false);
  });

  test("returns false for non-string message", () => {
    expect(isKoiError({ code: "INTERNAL", message: 42, retryable: false })).toBe(false);
  });

  test("returns false for null", () => {
    expect(isKoiError(null)).toBe(false);
  });

  test("returns false for string", () => {
    expect(isKoiError("not an error")).toBe(false);
  });
});

describe("toKoiError", () => {
  test("returns valid KoiError as-is", () => {
    const original = { code: "TIMEOUT" as const, message: "slow", retryable: true };
    expect(toKoiError(original)).toBe(original);
  });

  test("converts Error to KoiError with EXTERNAL code", () => {
    const result = toKoiError(new Error("upstream fail"));
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toBe("upstream fail");
    expect(result.retryable).toBe(false);
    expect(result.cause).toBeInstanceOf(Error);
  });

  test("converts string to KoiError", () => {
    const result = toKoiError("something broke");
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toBe("something broke");
    expect(result.retryable).toBe(false);
  });

  test("converts null to KoiError", () => {
    const result = toKoiError(null);
    expect(result.code).toBe("EXTERNAL");
    expect(result.message).toBe("null");
    expect(result.cause).toBeNull();
  });
});

describe("swallowError", () => {
  test("logs warning with package and operation context", () => {
    const messages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: readonly unknown[]) => {
      messages.push(args.map(String).join(" "));
    };

    try {
      swallowError(new Error("db timeout"), {
        package: "gateway",
        operation: "handler",
      });

      expect(messages).toHaveLength(1);
      const message = messages[0] ?? "";
      expect(message).toContain("[gateway]");
      expect(message).toContain("handler");
      expect(message).toContain("db timeout");
      expect(message).toContain("swallowed");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("handles string errors", () => {
    const messages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: readonly unknown[]) => {
      messages.push(args.map(String).join(" "));
    };

    try {
      swallowError("connection reset", {
        package: "mcp",
        operation: "reconnect",
      });

      expect(messages).toHaveLength(1);
      const message = messages[0] ?? "";
      expect(message).toContain("connection reset");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("isContextOverflowError", () => {
  test("detects OpenAI context_length_exceeded", () => {
    expect(isContextOverflowError({ code: "context_length_exceeded" })).toBe(true);
  });

  test("detects nested OpenAI error (raw API response)", () => {
    expect(
      isContextOverflowError({
        error: { code: "context_length_exceeded", message: "max tokens" },
      }),
    ).toBe(true);
  });

  test("detects Anthropic invalid_request_error with prompt too long", () => {
    expect(
      isContextOverflowError({
        type: "invalid_request_error",
        message: "Your prompt is too long. Please reduce the number of messages.",
      }),
    ).toBe(true);
  });

  test("detects nested Anthropic error (raw API response)", () => {
    expect(
      isContextOverflowError({
        error: {
          type: "invalid_request_error",
          message: "prompt is too long",
        },
      }),
    ).toBe(true);
  });

  test("rejects Anthropic invalid_request_error without prompt-too-long message", () => {
    expect(
      isContextOverflowError({
        type: "invalid_request_error",
        message: "temperature must be between 0 and 1",
      }),
    ).toBe(false);
  });

  test("rejects null and primitives", () => {
    expect(isContextOverflowError(null)).toBe(false);
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError("string")).toBe(false);
    expect(isContextOverflowError(42)).toBe(false);
  });

  test("rejects unrelated error objects", () => {
    expect(isContextOverflowError({ code: "rate_limit_exceeded" })).toBe(false);
    expect(isContextOverflowError({ type: "api_error", message: "server error" })).toBe(false);
    expect(isContextOverflowError(new Error("generic error"))).toBe(false);
  });

  test("rejects empty objects", () => {
    expect(isContextOverflowError({})).toBe(false);
  });

  test("follows one level of nesting", () => {
    expect(
      isContextOverflowError({
        error: { code: "context_length_exceeded" },
      }),
    ).toBe(true);
  });

  test("stops at depth limit (2+ levels)", () => {
    expect(
      isContextOverflowError({
        error: {
          error: { code: "context_length_exceeded" },
        },
      }),
    ).toBe(false);
  });

  test("handles circular references without stack overflow", () => {
    const circular: Record<string, unknown> = { type: "error" };
    circular.error = circular;
    expect(isContextOverflowError(circular)).toBe(false);
  });
});
