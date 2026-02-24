import { describe, expect, mock, test } from "bun:test";
import type { KoiMiddleware, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createResultPruner } from "./result-pruner.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockTurnContext(): TurnContext {
  const rid = runId("r1");
  return {
    session: { agentId: "a1", sessionId: sessionId("s1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function mockToolRequest(toolId = "read_file"): ToolRequest {
  return { toolId, input: { path: "/test.txt" } };
}

function mockToolResponse(output: unknown = "short"): ToolResponse {
  return { output };
}

/** Unwrap the wrapToolCall from the middleware for direct testing. */
function getWrapToolCall(mw: KoiMiddleware): NonNullable<KoiMiddleware["wrapToolCall"]> {
  if (!mw.wrapToolCall) {
    throw new Error("Middleware missing wrapToolCall");
  }
  return mw.wrapToolCall;
}

// ---------------------------------------------------------------------------
// createResultPruner — basic behavior
// ---------------------------------------------------------------------------

describe("createResultPruner", () => {
  test("has correct middleware name", () => {
    const mw = createResultPruner();
    expect(mw.name).toBe("koi:result-pruner");
  });

  test("passes through small string output unchanged", async () => {
    const mw = createResultPruner();
    const wrap = getWrapToolCall(mw);
    const next = mock(() => Promise.resolve(mockToolResponse("hello world")));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(result.output).toBe("hello world");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("passes through small object output unchanged", async () => {
    const mw = createResultPruner();
    const wrap = getWrapToolCall(mw);
    const obj = { key: "value", num: 42 };
    const next = mock(() => Promise.resolve(mockToolResponse(obj)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(result.output).toBe(obj);
  });

  test("truncates string output exceeding maxOutputBytes", async () => {
    const mw = createResultPruner({ maxOutputBytes: 100 });
    const wrap = getWrapToolCall(mw);
    const largeOutput = "x".repeat(500);
    const next = mock(() => Promise.resolve(mockToolResponse(largeOutput)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(typeof result.output).toBe("string");
    const output = result.output as string;
    expect(output).toContain("[truncated from 500 bytes to 100 bytes]");
    // The truncated part should start with x's
    expect(output.startsWith("x")).toBe(true);
  });

  test("truncates object output exceeding maxOutputBytes", async () => {
    const mw = createResultPruner({ maxOutputBytes: 50 });
    const wrap = getWrapToolCall(mw);
    const largeObj = { data: "y".repeat(200) };
    const next = mock(() => Promise.resolve(mockToolResponse(largeObj)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(typeof result.output).toBe("string");
    const output = result.output as string;
    expect(output).toContain("[truncated from");
  });

  test("uses default maxOutputBytes of 51200", async () => {
    const mw = createResultPruner();
    const wrap = getWrapToolCall(mw);
    // Just under 50KB — should pass through
    const justUnder = "a".repeat(51_200);
    const next = mock(() => Promise.resolve(mockToolResponse(justUnder)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(result.output).toBe(justUnder);
  });

  test("truncates at exactly maxOutputBytes + 1", async () => {
    const mw = createResultPruner({ maxOutputBytes: 100 });
    const wrap = getWrapToolCall(mw);
    const exactlyOver = "b".repeat(101);
    const next = mock(() => Promise.resolve(mockToolResponse(exactlyOver)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(typeof result.output).toBe("string");
    expect(result.output as string).toContain("[truncated from 101 bytes to 100 bytes]");
  });

  test("preserves metadata on truncated response", async () => {
    const mw = createResultPruner({ maxOutputBytes: 10 });
    const wrap = getWrapToolCall(mw);
    const response: ToolResponse = { output: "x".repeat(100), metadata: { source: "test" } };
    const next = mock(() => Promise.resolve(response));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(result.metadata).toEqual({ source: "test" });
    expect(typeof result.output).toBe("string");
  });

  test("does not add metadata when original response has none", async () => {
    const mw = createResultPruner({ maxOutputBytes: 10 });
    const wrap = getWrapToolCall(mw);
    const next = mock(() => Promise.resolve(mockToolResponse("x".repeat(100))));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    expect(result.metadata).toBeUndefined();
  });

  test("handles non-serializable output gracefully", async () => {
    const mw = createResultPruner({ maxOutputBytes: 5 });
    const wrap = getWrapToolCall(mw);
    // Circular reference — JSON.stringify will throw
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const next = mock(() => Promise.resolve(mockToolResponse(circular)));

    const result = await wrap(mockTurnContext(), mockToolRequest(), next);

    // Falls back to String(output) which is "[object Object]" (15 bytes > 5)
    expect(typeof result.output).toBe("string");
    expect(result.output as string).toContain("[truncated from");
  });

  test("propagates errors from next without catching", async () => {
    const mw = createResultPruner();
    const wrap = getWrapToolCall(mw);
    const next = mock(() => Promise.reject(new Error("tool failed")));

    await expect(wrap(mockTurnContext(), mockToolRequest(), next)).rejects.toThrow("tool failed");
  });
});
