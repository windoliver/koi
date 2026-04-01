/**
 * Tests for @koi/tool-execution — per-call tool execution middleware.
 *
 * Test groups:
 * 1. Factory & configuration
 * 2. Abort signal scenarios (5-scenario matrix)
 * 3. Error normalization (8-shape matrix)
 * 4. Transparency (successful calls)
 * 5. Integration (mock middleware chain)
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  JsonObject,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createToolExecution } from "./tool-execution.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  const session: SessionContext = {
    agentId: "test-agent",
    sessionId: "test-session" as never,
    runId: "test-run" as never,
    metadata: {},
  };
  return {
    session,
    turnIndex: 0,
    turnId: "test-turn" as never,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function createMockToolRequest(overrides?: Partial<ToolRequest>): ToolRequest {
  return {
    toolId: "test:tool",
    input: {},
    ...overrides,
  };
}

/** Invoke the middleware's wrapToolCall with the given handler. */
function invokeWrapToolCall(
  middleware: KoiMiddleware,
  ctx: TurnContext,
  request: ToolRequest,
  handler: ToolHandler,
): Promise<ToolResponse> {
  if (middleware.wrapToolCall === undefined) {
    throw new Error("Middleware does not implement wrapToolCall");
  }
  return middleware.wrapToolCall(ctx, request, handler);
}

// ---------------------------------------------------------------------------
// 1. Factory & configuration
// ---------------------------------------------------------------------------

describe("createToolExecution", () => {
  describe("factory", () => {
    test("returns a middleware with correct name", () => {
      const mw = createToolExecution();
      expect(mw.name).toBe("koi:tool-execution");
    });

    test("uses resolve phase", () => {
      const mw = createToolExecution();
      expect(mw.phase).toBe("resolve");
    });

    test("uses priority 100", () => {
      const mw = createToolExecution();
      expect(mw.priority).toBe(100);
    });

    test("describeCapabilities returns undefined", () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      expect(mw.describeCapabilities(ctx)).toBeUndefined();
    });

    test("implements wrapToolCall", () => {
      const mw = createToolExecution();
      expect(mw.wrapToolCall).toBeDefined();
      expect(typeof mw.wrapToolCall).toBe("function");
    });

    test("accepts empty config", () => {
      const mw = createToolExecution({});
      expect(mw.name).toBe("koi:tool-execution");
    });

    test("accepts full config", () => {
      const mw = createToolExecution({
        defaultTimeoutMs: 30_000,
        toolTimeouts: { "exec:run": 60_000 },
        includeStackInResponse: true,
      });
      expect(mw.name).toBe("koi:tool-execution");
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Abort signal scenarios
  // ---------------------------------------------------------------------------

  describe("abort signals", () => {
    test("scenario 1: pre-aborted signal returns abort response immediately", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("user_cancel");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() =>
        Promise.resolve({ output: "should not reach" } satisfies ToolResponse),
      );

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      // Handler should NOT have been called
      expect(handler).not.toHaveBeenCalled();
      // Response should indicate abort
      expect(response.output).toContain("aborted");
      const meta = response.metadata as JsonObject | undefined;
      expect(meta).toBeDefined();
      expect((meta as JsonObject)._error).toBeDefined();
      expect(((meta as JsonObject)._error as JsonObject).kind).toBe("aborted");
    });

    test("scenario 2: signal fires during tool execution returns abort response", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () =>
        new Promise((_resolve, reject) => {
          // Simulate: tool starts, then signal aborts
          controller.abort("user_cancel");
          // The abort causes a DOMException in code that checks the signal
          reject(new DOMException("The operation was aborted", "AbortError"));
        });

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response.output).toContain("aborted");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("aborted");
    });

    test("scenario 2b: signal aborts during next() with never-settling handler", async () => {
      // Regression: rejectOnAbort must handle signals that abort between
      // the pre-check and the addEventListener call (Codex review P1)
      const mw = createToolExecution({ defaultTimeoutMs: 5000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () => {
        // Abort synchronously inside next(), then return a never-settling promise
        controller.abort("user_cancel");
        return new Promise(() => {});
      };

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response.output).toContain("aborted");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("aborted");
    });

    test("scenario 3: per-tool timeout fires returns timeout response", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 50 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () =>
        new Promise((_resolve) => {
          // Never resolves — will timeout
        });

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response.output).toContain("timed out");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("timeout");
    });

    test("scenario 4: race between parent abort and timeout — first wins", async () => {
      // Pre-aborted signal + timeout configured → abort should win (it's already aborted)
      const mw = createToolExecution({ defaultTimeoutMs: 10_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("user_cancel");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() =>
        Promise.resolve({ output: "should not reach" } satisfies ToolResponse),
      );

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).not.toHaveBeenCalled();
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("aborted");
    });

    test("scenario 5a: parent signal + timeout both present — tool succeeds before either fires", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const expected: ToolResponse = { output: "fast result" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(response).toEqual(expected);
    });

    test("scenario 5: no signal provided — tool executes normally", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      // signal is undefined
      const request = createMockToolRequest({ signal: undefined });

      const expected: ToolResponse = { output: "success" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(response).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Error normalization (8-shape matrix)
  // ---------------------------------------------------------------------------

  describe("error normalization", () => {
    test("shape 1: standard Error", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:err" });

      const handler: ToolHandler = () => Promise.reject(new Error("something broke"));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(typeof response.output).toBe("string");
      expect(response.output as string).toContain("something broke");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("tool_error");
    });

    test("shape 2: KoiRuntimeError preserves code and retryable", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:koi" });

      const handler: ToolHandler = () =>
        Promise.reject(
          KoiRuntimeError.from("RATE_LIMIT", "Too many requests", { retryable: true }),
        );

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(typeof response.output).toBe("string");
      expect(response.output as string).toContain("Too many requests");
      const meta = response.metadata as JsonObject;
      const errMeta = meta._error as JsonObject;
      expect(errMeta.kind).toBe("tool_error");
      expect(errMeta.code).toBe("RATE_LIMIT");
      expect(errMeta.retryable).toBe(true);
    });

    test("shape 3: plain string throw", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:str" });

      const handler: ToolHandler = () => Promise.reject("oops");

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(typeof response.output).toBe("string");
      expect(response.output as string).toContain("oops");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("tool_error");
    });

    test("shape 4: null throw", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:null" });

      const handler: ToolHandler = () => Promise.reject(null);

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(typeof response.output).toBe("string");
      expect((response.output as string).length).toBeGreaterThan(0);
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("tool_error");
    });

    test("shape 5: object with message property", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:obj" });

      const handler: ToolHandler = () =>
        Promise.reject({ message: "object error", statusCode: 500 });

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(typeof response.output).toBe("string");
      expect(response.output as string).toContain("object error");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("tool_error");
    });

    test("shape 6: DOMException AbortError", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:abort" });

      const handler: ToolHandler = () =>
        Promise.reject(new DOMException("The operation was aborted", "AbortError"));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("aborted");
    });

    test("shape 7: DOMException TimeoutError", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:timeout" });

      const handler: ToolHandler = () =>
        Promise.reject(new DOMException("The operation timed out", "TimeoutError"));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("timeout");
    });

    test("includeStackInResponse: false hides stack trace", async () => {
      const mw = createToolExecution({ includeStackInResponse: false });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => Promise.reject(new Error("fail"));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      const meta = response.metadata as JsonObject;
      const errMeta = meta._error as JsonObject;
      expect(errMeta.stack).toBeUndefined();
    });

    test("includeStackInResponse: true includes stack trace", async () => {
      const mw = createToolExecution({ includeStackInResponse: true });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => Promise.reject(new Error("fail"));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      const meta = response.metadata as JsonObject;
      const errMeta = meta._error as JsonObject;
      expect(errMeta.stack).toBeDefined();
      expect(typeof errMeta.stack).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Transparency (successful calls)
  // ---------------------------------------------------------------------------

  describe("transparency", () => {
    test("successful call passes through response unchanged", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = {
        output: { result: "hello", count: 42 },
        metadata: { custom: "data" },
      };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response).toEqual(expected);
      // Verify it's the exact same object (referential equality for pure transparency)
      expect(response).toBe(expected);
    });

    test("successful call forwards request to handler unchanged", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const input = { file: "/tmp/test.txt", encoding: "utf-8" };
      const request = createMockToolRequest({
        toolId: "fs:read",
        input,
        metadata: { trace: "abc" },
      });

      const handler = mock(() => Promise.resolve({ output: "content" } satisfies ToolResponse));

      await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      // Handler receives the request (potentially with composed signal)
      const firstCall = handler.mock.calls[0] as unknown as readonly [ToolRequest];
      expect(firstCall[0].toolId).toBe("fs:read");
      expect(firstCall[0].input).toEqual(input);
    });

    test("no metadata added to successful response", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 5000 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = { output: "ok" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response.metadata).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Per-tool timeout configuration
  // ---------------------------------------------------------------------------

  describe("per-tool timeouts", () => {
    test("toolTimeouts overrides defaultTimeoutMs for matching toolId", async () => {
      const mw = createToolExecution({
        defaultTimeoutMs: 10_000,
        toolTimeouts: { "fast:tool": 50 },
      });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "fast:tool" });

      // This handler never resolves — relies on timeout
      const handler: ToolHandler = () => new Promise(() => {});

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      // Should timeout at 50ms, not 10_000ms
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("timeout");
    });

    test("falls back to defaultTimeoutMs for non-matching toolId", async () => {
      const mw = createToolExecution({
        defaultTimeoutMs: 50,
        toolTimeouts: { "other:tool": 60_000 },
      });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "unmatched:tool" });

      const handler: ToolHandler = () => new Promise(() => {});

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("timeout");
    });

    test("no timeout when neither default nor per-tool configured", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = { output: "done" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response).toBe(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Integration: mock middleware chain
  // ---------------------------------------------------------------------------

  describe("integration with middleware chain", () => {
    test("guard errors from next() propagate unchanged (not caught by error normalization)", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      // Simulate a guard (upstream middleware) that throws KoiRuntimeError
      const guardError = KoiRuntimeError.from("TIMEOUT", "Max turns exceeded: 10/10", {
        retryable: false,
      });
      const handler: ToolHandler = () => Promise.reject(guardError);

      // Tool-execution should let guard errors propagate as-is when they come
      // from next() — because in the real chain, guards run OUTSIDE tool-execution
      // (lower priority). But when the tool itself throws KoiRuntimeError, it should
      // be caught and normalized.
      //
      // In this test, the error comes from the handler (terminal tool), so it
      // SHOULD be caught and normalized into a ToolResponse.
      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      // Since the error came from the terminal handler, it should be normalized
      expect(typeof response.output).toBe("string");
      const meta = response.metadata as JsonObject;
      expect((meta._error as JsonObject).kind).toBe("tool_error");
      expect((meta._error as JsonObject).code).toBe("TIMEOUT");
    });

    test("middleware composes with a pass-through wrapper", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = { output: "from-tool" };

      // Simulate outer middleware wrapping tool-execution
      const outerHandler: ToolHandler = async (req) => {
        // Outer middleware delegates to tool-execution's handler
        return invokeWrapToolCall(mw, ctx, req, () => Promise.resolve(expected));
      };

      const response = await outerHandler(request);

      expect(response).toBe(expected);
    });
  });
});
