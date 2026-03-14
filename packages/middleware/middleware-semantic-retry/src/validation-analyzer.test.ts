import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { createValidationAnalyzer } from "./validation-analyzer.js";
import type { FailureAnalyzer, FailureClass, FailureContext, RetryRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKoiError(overrides: Partial<KoiError>): KoiError {
  return {
    code: "INTERNAL",
    message: "test error",
    retryable: false,
    ...overrides,
  };
}

function makeFailureContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    error: new Error("test"),
    request: { messages: [] },
    records: [],
    turnIndex: 0,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<RetryRecord> = {}): RetryRecord {
  return {
    timestamp: Date.now(),
    failureClass: { kind: "unknown", reason: "test" },
    actionTaken: { kind: "add_context", context: "test" },
    succeeded: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classify()
// ---------------------------------------------------------------------------

describe("createValidationAnalyzer", () => {
  describe("classify", () => {
    test("VALIDATION KoiError is classified as validation_failure", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "VALIDATION", message: "Invalid JSON output" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("validation_failure");
    });

    test("reason includes the VALIDATION error message", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "VALIDATION", message: "Expected string, got number" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.reason).toContain("Expected string, got number");
    });

    test("KoiError with context.issues includes issue details in reason", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({
        error: makeKoiError({
          code: "VALIDATION",
          message: "Schema validation failed",
          context: {
            issues: [
              { path: "name", message: "Required" },
              { path: "age", message: "Expected number" },
            ],
          },
        }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("validation_failure");
      expect(result.reason).toContain("Issues:");
      expect(result.reason).toContain("Required");
      expect(result.reason).toContain("Expected number");
    });

    test("KoiError with string context.issues includes string in reason", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({
        error: makeKoiError({
          code: "VALIDATION",
          message: "Parse error",
          context: { issues: "Unexpected token at position 42" },
        }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.reason).toContain("Unexpected token at position 42");
    });

    test("non-VALIDATION error is delegated to fallback analyzer", async () => {
      const fallback: FailureAnalyzer = {
        classify: () => ({ kind: "api_error", reason: "fallback classified" }),
        selectAction: () => ({ kind: "add_context", context: "fallback action" }),
      };
      const analyzer = createValidationAnalyzer(fallback);
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "TIMEOUT", message: "timed out" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("api_error");
      expect(result.reason).toBe("fallback classified");
    });

    test("non-VALIDATION error without fallback returns unknown", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({
        error: new Error("random failure"),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("unknown");
      expect(result.reason).toContain("random failure");
    });

    test("plain Error (non-KoiError) without fallback returns unknown", async () => {
      const analyzer = createValidationAnalyzer();
      const ctx = makeFailureContext({ error: new Error("something broke") });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("unknown");
    });
  });

  // ---------------------------------------------------------------------------
  // selectAction()
  // ---------------------------------------------------------------------------

  describe("selectAction", () => {
    test("returns add_context with error details on first validation failure", () => {
      const analyzer = createValidationAnalyzer();
      const failure: FailureClass = {
        kind: "validation_failure",
        reason: "Validation failed: Expected string, got number",
      };
      const action = analyzer.selectAction(failure, []);
      expect(action.kind).toBe("add_context");
      if (action.kind === "add_context") {
        expect(action.context).toContain("Validation failed");
      }
    });

    test("returns abort when prior validation retry exists", () => {
      const analyzer = createValidationAnalyzer();
      const failure: FailureClass = {
        kind: "validation_failure",
        reason: "Validation failed: still wrong",
      };
      const records = [
        makeRecord({ failureClass: { kind: "validation_failure", reason: "first attempt" } }),
      ];
      const action = analyzer.selectAction(failure, records);
      expect(action.kind).toBe("abort");
      if (action.kind === "abort") {
        expect(action.reason).toContain("persist");
      }
    });

    test("never returns escalate_model for validation failures", () => {
      const analyzer = createValidationAnalyzer();
      const failure: FailureClass = {
        kind: "validation_failure",
        reason: "Validation failed: bad output",
      };
      // Even with many prior records, should abort rather than escalate
      const records = [
        makeRecord({ failureClass: { kind: "validation_failure", reason: "attempt 1" } }),
        makeRecord({ failureClass: { kind: "validation_failure", reason: "attempt 2" } }),
        makeRecord({ failureClass: { kind: "validation_failure", reason: "attempt 3" } }),
      ];
      const action = analyzer.selectAction(failure, records);
      expect(action.kind).not.toBe("escalate_model");
      expect(action.kind).not.toBe("narrow_scope");
    });

    test("non-validation failure delegates to fallback selectAction", () => {
      const fallback: FailureAnalyzer = {
        classify: () => ({ kind: "api_error", reason: "classified" }),
        selectAction: () => ({ kind: "narrow_scope", focusArea: "fallback scope" }),
      };
      const analyzer = createValidationAnalyzer(fallback);
      const failure: FailureClass = { kind: "api_error", reason: "timeout" };
      const action = analyzer.selectAction(failure, []);
      expect(action.kind).toBe("narrow_scope");
    });

    test("non-validation failure without fallback returns add_context", () => {
      const analyzer = createValidationAnalyzer();
      const failure: FailureClass = { kind: "api_error", reason: "server error" };
      const action = analyzer.selectAction(failure, []);
      expect(action.kind).toBe("add_context");
      if (action.kind === "add_context") {
        expect(action.context).toContain("server error");
      }
    });
  });
});
