import { describe, expect, mock, test } from "bun:test";
import type { AuditEntry, AuditSink } from "@koi/core";
import {
  createAuditTrajectoryAdapter,
  mapAuditEntryToRichStep,
  mapPayloadToContent,
} from "./audit-adapter.js";

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: 1000,
    sessionId: "sess-1",
    agentId: "agent-1",
    turnIndex: 0,
    kind: "model_call",
    durationMs: 42,
    ...overrides,
  };
}

function makeSink(overrides?: Partial<AuditSink>): AuditSink {
  return {
    log: mock(() => Promise.resolve()),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createAuditTrajectoryAdapter
// ---------------------------------------------------------------------------

describe("createAuditTrajectoryAdapter", () => {
  test("throws when sink has no query method", () => {
    const sink = makeSink({ query: undefined });
    expect(() => createAuditTrajectoryAdapter({ sink })).toThrow(
      "Audit sink must implement query()",
    );
  });

  test("returns empty array for empty session", async () => {
    const queryFn = mock(() => Promise.resolve([] as readonly AuditEntry[]));
    const sink = makeSink({ query: queryFn });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-empty");

    expect(result).toEqual([]);
    expect(queryFn).toHaveBeenCalledWith("sess-empty");
  });

  test("filters out session_start entries", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({ kind: "session_start", turnIndex: 0 }),
      makeEntry({
        kind: "model_call",
        turnIndex: 1,
        request: { model: "gpt-4" },
        response: { text: "hi" },
      }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("model_call");
  });

  test("filters out session_end entries", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({
        kind: "model_call",
        turnIndex: 0,
        request: { model: "gpt-4" },
        response: { text: "hi" },
      }),
      makeEntry({ kind: "session_end", turnIndex: 1 }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("model_call");
  });

  test("filters out secret_access entries", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({ kind: "secret_access", turnIndex: 0 }),
      makeEntry({
        kind: "tool_call",
        turnIndex: 1,
        request: { toolId: "read-file" },
        response: { data: "ok" },
      }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("tool_call");
  });

  test("maps model_call entries with correct source and stepIndex", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({
        kind: "model_call",
        turnIndex: 0,
        request: { model: "claude-3" },
        response: { text: "hello" },
      }),
      makeEntry({
        kind: "model_call",
        turnIndex: 1,
        request: { model: "claude-3" },
        response: { text: "world" },
      }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(2);
    expect(result[0]?.stepIndex).toBe(0);
    expect(result[0]?.source).toBe("agent");
    expect(result[0]?.identifier).toBe("claude-3");
    expect(result[1]?.stepIndex).toBe(1);
    expect(result[1]?.source).toBe("agent");
  });

  test("maps tool_call entries with correct source", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({
        kind: "tool_call",
        turnIndex: 0,
        request: { toolId: "search" },
        response: { results: [] },
      }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("tool");
    expect(result[0]?.kind).toBe("tool_call");
    expect(result[0]?.identifier).toBe("search");
  });

  test("uses maxContentChars from config", async () => {
    const longText = "x".repeat(100);
    const entries: readonly AuditEntry[] = [
      makeEntry({ kind: "model_call", request: { model: "m" }, response: longText }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink, maxContentChars: 10 });

    const result = await adapter("sess-1");

    expect(result[0]?.response?.truncated).toBe(true);
    expect(result[0]?.response?.originalSize).toBe(100);
  });

  test("mixed entry types filters correctly and re-indexes steps", async () => {
    const entries: readonly AuditEntry[] = [
      makeEntry({ kind: "session_start", turnIndex: 0 }),
      makeEntry({ kind: "model_call", turnIndex: 1, request: { model: "m" }, response: "ok" }),
      makeEntry({ kind: "secret_access", turnIndex: 2 }),
      makeEntry({ kind: "tool_call", turnIndex: 3, request: { toolId: "t" }, response: "done" }),
      makeEntry({ kind: "session_end", turnIndex: 4 }),
    ];
    const sink = makeSink({ query: mock(() => Promise.resolve(entries)) });
    const adapter = createAuditTrajectoryAdapter({ sink });

    const result = await adapter("sess-1");

    expect(result).toHaveLength(2);
    expect(result[0]?.stepIndex).toBe(0);
    expect(result[0]?.kind).toBe("model_call");
    expect(result[1]?.stepIndex).toBe(1);
    expect(result[1]?.kind).toBe("tool_call");
  });
});

// ---------------------------------------------------------------------------
// mapAuditEntryToRichStep
// ---------------------------------------------------------------------------

describe("mapAuditEntryToRichStep", () => {
  // --- Normal model_call ---
  test("maps normal model_call with request and response", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { model: "claude-3", messages: [{ role: "user", content: "hi" }] },
      response: { text: "hello" },
      durationMs: 123,
      timestamp: 5000,
    });

    const step = mapAuditEntryToRichStep(entry, 7);

    expect(step.stepIndex).toBe(7);
    expect(step.timestamp).toBe(5000);
    expect(step.source).toBe("agent");
    expect(step.kind).toBe("model_call");
    expect(step.identifier).toBe("claude-3");
    expect(step.outcome).toBe("success");
    expect(step.durationMs).toBe(123);
    expect(step.request).toBeDefined();
    expect(step.response).toBeDefined();
    expect(step.error).toBeUndefined();
  });

  // --- Normal tool_call ---
  test("maps normal tool_call with request and response", () => {
    const entry = makeEntry({
      kind: "tool_call",
      request: { toolId: "read-file", path: "/foo" },
      response: { content: "file data" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.source).toBe("tool");
    expect(step.kind).toBe("tool_call");
    expect(step.identifier).toBe("read-file");
    expect(step.outcome).toBe("success");
    expect(step.request).toBeDefined();
    expect(step.response).toBeDefined();
  });

  // --- Redacted payload ---
  test("handles redacted request payload", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: "[redacted]",
      response: { text: "ok" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.request?.text).toBe("[redacted]");
    expect(step.request?.truncated).toBeUndefined();
    expect(step.identifier).toBe("unknown");
  });

  test("handles redacted response payload", () => {
    const entry = makeEntry({
      kind: "tool_call",
      request: { toolId: "secret-tool" },
      response: "[redacted]",
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.response?.text).toBe("[redacted]");
    expect(step.response?.truncated).toBeUndefined();
    expect(step.outcome).toBe("success");
  });

  // --- Truncated payload ---
  test("truncates request payload exceeding maxContentChars", () => {
    const longPayload = "a".repeat(500);
    const entry = makeEntry({
      kind: "model_call",
      request: longPayload,
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0, 50);

    expect(step.request?.truncated).toBe(true);
    expect(step.request?.originalSize).toBe(500);
    expect(step.request?.text?.length).toBe(53); // 50 + "..."
  });

  // --- Missing response (error case) ---
  test("maps entry with error and no response as failure", () => {
    const entry = makeEntry({
      kind: "tool_call",
      request: { toolId: "fail-tool" },
      error: { message: "timeout" },
    });

    const step = mapAuditEntryToRichStep(entry, 3);

    expect(step.outcome).toBe("failure");
    expect(step.error).toBeDefined();
    expect(step.response).toBeUndefined();
  });

  // --- Missing request ---
  test("maps entry with no request field", () => {
    const entry = makeEntry({
      kind: "model_call",
      response: { text: "spontaneous" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.request).toBeUndefined();
    expect(step.identifier).toBe("unknown");
    expect(step.outcome).toBe("success");
  });

  // --- Identifier extraction ---
  test("extracts model identifier from request.model", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { model: "gpt-4-turbo" },
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.identifier).toBe("gpt-4-turbo");
  });

  test("extracts toolId identifier from request.toolId", () => {
    const entry = makeEntry({
      kind: "tool_call",
      request: { toolId: "web-search" },
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.identifier).toBe("web-search");
  });

  test("falls back to unknown when request has no model or toolId", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { prompt: "hello" },
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.identifier).toBe("unknown");
  });

  test("falls back to unknown when request is a string", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: "raw prompt",
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.identifier).toBe("unknown");
  });

  test("falls back to unknown when request is null", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: null,
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.identifier).toBe("unknown");
  });

  // --- Outcome determination ---
  test("outcome is success when response present and no error", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { model: "m" },
      response: { text: "ok" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.outcome).toBe("success");
  });

  test("outcome is failure when error present even with response", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { model: "m" },
      response: { text: "partial" },
      error: { code: "TIMEOUT" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.outcome).toBe("failure");
  });

  test("outcome is failure when neither response nor error present", () => {
    const entry = makeEntry({
      kind: "model_call",
      request: { model: "m" },
    });

    const step = mapAuditEntryToRichStep(entry, 0);
    expect(step.outcome).toBe("failure");
  });

  // --- Error field ---
  test("includes error content when error present", () => {
    const entry = makeEntry({
      kind: "tool_call",
      request: { toolId: "t" },
      error: "something went wrong",
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.error).toBeDefined();
    expect(step.error?.text).toBe("something went wrong");
  });

  // --- Default maxContentChars ---
  test("uses default maxContentChars of 2000 when not provided", () => {
    const longPayload = "b".repeat(2001);
    const entry = makeEntry({
      kind: "model_call",
      request: longPayload,
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.request?.truncated).toBe(true);
    expect(step.request?.originalSize).toBe(2001);
  });

  test("does not truncate payload exactly at maxContentChars", () => {
    const exactPayload = "c".repeat(2000);
    const entry = makeEntry({
      kind: "model_call",
      request: exactPayload,
      response: "ok",
    });

    const step = mapAuditEntryToRichStep(entry, 0);

    expect(step.request?.truncated).toBeUndefined();
    expect(step.request?.text).toBe(exactPayload);
  });
});

// ---------------------------------------------------------------------------
// mapPayloadToContent
// ---------------------------------------------------------------------------

describe("mapPayloadToContent", () => {
  // --- String payload ---
  test("returns string payload as text", () => {
    const result = mapPayloadToContent("hello world", 100);

    expect(result.text).toBe("hello world");
    expect(result.truncated).toBeUndefined();
  });

  // --- Object payload ---
  test("serializes object payload to JSON text", () => {
    const payload = { key: "value", count: 42 };
    const result = mapPayloadToContent(payload, 1000);

    expect(result.text).toBe(JSON.stringify(payload));
    expect(result.truncated).toBeUndefined();
  });

  // --- Array payload ---
  test("serializes array payload to JSON text", () => {
    const payload = [1, 2, 3];
    const result = mapPayloadToContent(payload, 1000);

    expect(result.text).toBe("[1,2,3]");
  });

  // --- Redacted string ---
  test("preserves redacted string without truncation", () => {
    const result = mapPayloadToContent("[redacted]", 5);

    expect(result.text).toBe("[redacted]");
    expect(result.truncated).toBeUndefined();
    expect(result.originalSize).toBeUndefined();
  });

  // --- Long string truncation ---
  test("truncates long string with truncated flag and originalSize", () => {
    const longStr = "x".repeat(200);
    const result = mapPayloadToContent(longStr, 50);

    expect(result.text).toBe(`${"x".repeat(50)}...`);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(200);
  });

  // --- Long object truncation ---
  test("truncates long serialized object", () => {
    const payload = { data: "y".repeat(500) };
    const result = mapPayloadToContent(payload, 20);

    expect(result.truncated).toBe(true);
    expect(result.text?.endsWith("...")).toBe(true);
    const serialized = JSON.stringify(payload);
    expect(result.originalSize).toBe(serialized.length);
  });

  // --- Unserializable object ---
  test("returns unserializable marker for circular objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = mapPayloadToContent(circular, 100);

    expect(result.text).toBe("[unserializable]");
  });

  // --- Primitive types ---
  test("converts number to string", () => {
    const result = mapPayloadToContent(42, 100);
    expect(result.text).toBe("42");
  });

  test("converts boolean true to string", () => {
    const result = mapPayloadToContent(true, 100);
    expect(result.text).toBe("true");
  });

  test("converts boolean false to string", () => {
    const result = mapPayloadToContent(false, 100);
    expect(result.text).toBe("false");
  });

  test("converts undefined to string", () => {
    const result = mapPayloadToContent(undefined, 100);
    expect(result.text).toBe("undefined");
  });

  test("converts null via object branch to JSON", () => {
    // null has typeof "object" but is handled by the null check
    // In the source: `typeof payload === "object" && payload !== null`
    // So null falls through to the primitive branch
    const result = mapPayloadToContent(null, 100);
    expect(result.text).toBe("null");
  });

  // --- Boundary: exactly at maxChars ---
  test("does not truncate string exactly at maxChars", () => {
    const exact = "z".repeat(50);
    const result = mapPayloadToContent(exact, 50);

    expect(result.text).toBe(exact);
    expect(result.truncated).toBeUndefined();
  });

  // --- Boundary: one char over maxChars ---
  test("truncates string one char over maxChars", () => {
    const overByOne = "z".repeat(51);
    const result = mapPayloadToContent(overByOne, 50);

    expect(result.text).toBe(`${"z".repeat(50)}...`);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(51);
  });

  // --- Empty string ---
  test("handles empty string payload", () => {
    const result = mapPayloadToContent("", 100);
    expect(result.text).toBe("");
    expect(result.truncated).toBeUndefined();
  });

  // --- Empty object ---
  test("handles empty object payload", () => {
    const result = mapPayloadToContent({}, 100);
    expect(result.text).toBe("{}");
  });
});
