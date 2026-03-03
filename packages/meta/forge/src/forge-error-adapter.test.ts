import { describe, expect, test } from "bun:test";
import type { ForgeError } from "./errors.js";
import { forgeErrorToKoiError } from "./forge-error-adapter.js";

describe("forgeErrorToKoiError", () => {
  // -----------------------------------------------------------------------
  // Static stage
  // -----------------------------------------------------------------------

  test.each([
    "INVALID_SCHEMA",
    "INVALID_NAME",
    "SIZE_EXCEEDED",
    "MISSING_FIELD",
    "INVALID_TYPE",
    "MANIFEST_PARSE_FAILED",
    "SYNTAX_ERROR",
  ] as const)("static/%s maps to VALIDATION", (code) => {
    const error: ForgeError = { stage: "static", code, message: `test: ${code}` };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("VALIDATION");
    expect(result.retryable).toBe(false);
    expect(result.message).toContain(code);
    expect(result.context).toEqual({ stage: "static", forgeCode: code });
  });

  // -----------------------------------------------------------------------
  // Sandbox stage
  // -----------------------------------------------------------------------

  test("sandbox/TIMEOUT maps to TIMEOUT (retryable)", () => {
    const error: ForgeError = { stage: "sandbox", code: "TIMEOUT", message: "timed out" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("TIMEOUT");
    expect(result.retryable).toBe(true);
  });

  test("sandbox/OOM maps to EXTERNAL", () => {
    const error: ForgeError = { stage: "sandbox", code: "OOM", message: "out of memory" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("sandbox/CRASH maps to EXTERNAL", () => {
    const error: ForgeError = { stage: "sandbox", code: "CRASH", message: "segfault" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("EXTERNAL");
    expect(result.retryable).toBe(false);
  });

  test("sandbox/PERMISSION maps to PERMISSION", () => {
    const error: ForgeError = { stage: "sandbox", code: "PERMISSION", message: "denied" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Self-test stage
  // -----------------------------------------------------------------------

  test("self_test/TEST_FAILED maps to VALIDATION", () => {
    const error: ForgeError = { stage: "self_test", code: "TEST_FAILED", message: "2/3 failed" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("VALIDATION");
    expect(result.retryable).toBe(false);
  });

  test("self_test/VERIFIER_REJECTED maps to VALIDATION", () => {
    const error: ForgeError = {
      stage: "self_test",
      code: "VERIFIER_REJECTED",
      message: "unsafe",
    };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("VALIDATION");
    expect(result.retryable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Trust stage
  // -----------------------------------------------------------------------

  test("trust/GOVERNANCE_REJECTED maps to PERMISSION", () => {
    const error: ForgeError = {
      stage: "trust",
      code: "GOVERNANCE_REJECTED",
      message: "policy denied",
    };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  test("trust/RATE_LIMITED maps to RATE_LIMIT (retryable)", () => {
    const error: ForgeError = { stage: "trust", code: "RATE_LIMITED", message: "slow down" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
  });

  test("trust/DEPTH_EXCEEDED maps to PERMISSION", () => {
    const error: ForgeError = { stage: "trust", code: "DEPTH_EXCEEDED", message: "too deep" };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Governance stage
  // -----------------------------------------------------------------------

  test.each([
    "FORGE_DISABLED",
    "MAX_DEPTH",
    "SCOPE_VIOLATION",
    "DEPTH_TOOL_RESTRICTED",
  ] as const)("governance/%s maps to PERMISSION", (code) => {
    const error: ForgeError = { stage: "governance", code, message: `test: ${code}` };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("PERMISSION");
    expect(result.retryable).toBe(false);
  });

  test("governance/MAX_SESSION_FORGES maps to RATE_LIMIT (retryable)", () => {
    const error: ForgeError = {
      stage: "governance",
      code: "MAX_SESSION_FORGES",
      message: "limit reached",
    };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("RATE_LIMIT");
    expect(result.retryable).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Store stage
  // -----------------------------------------------------------------------

  test.each([
    "SAVE_FAILED",
    "LOAD_FAILED",
    "SEARCH_FAILED",
  ] as const)("store/%s maps to INTERNAL", (code) => {
    const error: ForgeError = { stage: "store", code, message: `test: ${code}` };
    const result = forgeErrorToKoiError(error);
    expect(result.code).toBe("INTERNAL");
    expect(result.retryable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Message format
  // -----------------------------------------------------------------------

  test("includes stage and code in message", () => {
    const error: ForgeError = { stage: "static", code: "INVALID_SCHEMA", message: "bad yaml" };
    const result = forgeErrorToKoiError(error);
    expect(result.message).toBe("Forge [static/INVALID_SCHEMA]: bad yaml");
  });
});
