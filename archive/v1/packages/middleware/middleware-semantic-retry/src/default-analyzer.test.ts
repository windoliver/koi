import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { createDefaultFailureAnalyzer } from "./default-analyzer.js";
import type { FailureContext, RetryRecord } from "./types.js";

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
    request: {
      messages: [],
    },
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

describe("createDefaultFailureAnalyzer", () => {
  const analyzer = createDefaultFailureAnalyzer();

  describe("classify", () => {
    test("maps TIMEOUT error code to api_error", async () => {
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "TIMEOUT" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("api_error");
    });

    test("maps RATE_LIMIT error code to api_error", async () => {
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "RATE_LIMIT" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("api_error");
    });

    test("maps EXTERNAL error code to api_error", async () => {
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "EXTERNAL" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("api_error");
    });

    test("maps VALIDATION error code to validation_failure", async () => {
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "VALIDATION" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("validation_failure");
    });

    test("classifies tool failure request as tool_misuse", async () => {
      const ctx = makeFailureContext({
        error: new Error("tool not found"),
        request: { kind: "tool", toolId: "unknown-tool", input: {} },
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("tool_misuse");
    });

    test("falls back to unknown for unrecognized errors", async () => {
      const ctx = makeFailureContext({
        error: new Error("some random error"),
      });
      const result = await analyzer.classify(ctx);
      expect(result.kind).toBe("unknown");
    });

    test("returns reason explaining classification", async () => {
      const ctx = makeFailureContext({
        error: makeKoiError({ code: "TIMEOUT", message: "request timed out" }),
      });
      const result = await analyzer.classify(ctx);
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // selectAction()
  // ---------------------------------------------------------------------------

  describe("selectAction", () => {
    test("returns add_context on first failure", () => {
      const action = analyzer.selectAction({ kind: "api_error", reason: "timeout" }, []);
      expect(action.kind).toBe("add_context");
    });

    test("returns narrow_scope on second failure", () => {
      const records = [makeRecord()];
      const action = analyzer.selectAction({ kind: "api_error", reason: "timeout" }, records);
      expect(action.kind).toBe("narrow_scope");
    });

    test("returns escalate_model on third failure with repeated class", () => {
      const records = [
        makeRecord({ failureClass: { kind: "api_error", reason: "timeout" } }),
        makeRecord({ failureClass: { kind: "api_error", reason: "timeout" } }),
      ];
      const action = analyzer.selectAction({ kind: "api_error", reason: "timeout" }, records);
      expect(action.kind).toBe("escalate_model");
    });

    test("returns redirect on third failure with changed class", () => {
      const records = [
        makeRecord({ failureClass: { kind: "api_error", reason: "timeout" } }),
        makeRecord({ failureClass: { kind: "validation_failure", reason: "bad format" } }),
      ];
      const action = analyzer.selectAction({ kind: "unknown", reason: "something else" }, records);
      expect(action.kind).toBe("redirect");
    });

    test("returns abort after max retries exceeded", () => {
      const records = [makeRecord(), makeRecord(), makeRecord()];
      const action = analyzer.selectAction({ kind: "api_error", reason: "still failing" }, records);
      expect(action.kind).toBe("abort");
    });

    test("returns decompose when scope_drift is detected", () => {
      const action = analyzer.selectAction(
        { kind: "scope_drift", reason: "agent went off-task" },
        [],
      );
      expect(action.kind).toBe("decompose");
    });

    // Table-driven escalation scenarios
    const escalationScenarios = [
      { priorRetries: 0, failureKind: "api_error" as const, expected: "add_context" },
      { priorRetries: 1, failureKind: "api_error" as const, expected: "narrow_scope" },
      { priorRetries: 0, failureKind: "scope_drift" as const, expected: "decompose" },
    ] as const;

    for (const { priorRetries, failureKind, expected } of escalationScenarios) {
      test(`escalation: ${priorRetries} prior retries + ${failureKind} → ${expected}`, () => {
        const records = Array.from({ length: priorRetries }, () => makeRecord());
        const action = analyzer.selectAction({ kind: failureKind, reason: "test" }, records);
        expect(action.kind).toBe(expected);
      });
    }
  });
});
