import { describe, expect, test } from "bun:test";
import { safeBackendError, safeCatchError } from "./safe-error.js";

describe("safeBackendError", () => {
  test("maps known error codes to stable messages", () => {
    const result = safeBackendError(
      { code: "NOT_FOUND", message: "/var/data/mem.md", retryable: false },
      "fallback",
    );
    expect(result.error).toBe("Memory not found");
    expect(result.code).toBe("NOT_FOUND");
  });

  test("uses fallback for unknown error codes", () => {
    const result = safeBackendError(
      { code: "INTERNAL", message: "ENOENT: /secret/path", retryable: false },
      "Failed to store",
    );
    expect(result.error).toBe("Failed to store");
    expect(result.error).not.toContain("ENOENT");
    expect(result.code).toBe("INTERNAL");
  });
});

describe("safeCatchError", () => {
  test("returns stable fallback message", () => {
    const result = safeCatchError("Failed to delete");
    expect(result.error).toBe("Failed to delete");
    expect(result.code).toBe("INTERNAL");
  });
});
