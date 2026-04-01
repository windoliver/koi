/**
 * Tests for @koi/tool-execution — per-call tool execution middleware.
 *
 * Test groups:
 * 1. Factory & configuration (including validation)
 * 2. Abort signal scenarios (5-scenario matrix)
 * 3. Error propagation (8-shape matrix)
 * 4. Transparency (successful calls)
 * 5. Per-tool timeout configuration
 * 6. Integration (mock middleware chain / governance accounting)
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

    test("accepts valid full config", () => {
      const mw = createToolExecution({
        defaultTimeoutMs: 30_000,
        toolTimeouts: { "exec:run": 60_000 },
      });
      expect(mw.name).toBe("koi:tool-execution");
    });
  });

  describe("config validation", () => {
    test("rejects negative defaultTimeoutMs", () => {
      expect(() => createToolExecution({ defaultTimeoutMs: -1 })).toThrow("finite positive");
    });

    test("rejects NaN defaultTimeoutMs", () => {
      expect(() => createToolExecution({ defaultTimeoutMs: NaN })).toThrow("finite positive");
    });

    test("rejects Infinity defaultTimeoutMs", () => {
      expect(() => createToolExecution({ defaultTimeoutMs: Infinity })).toThrow("finite positive");
    });

    test("rejects zero defaultTimeoutMs", () => {
      expect(() => createToolExecution({ defaultTimeoutMs: 0 })).toThrow("finite positive");
    });

    test("rejects invalid per-tool timeout", () => {
      expect(() => createToolExecution({ toolTimeouts: { "bad:tool": -5 } })).toThrow(
        "finite positive",
      );
    });

    test("rejects NaN per-tool timeout", () => {
      expect(() => createToolExecution({ toolTimeouts: { "bad:tool": NaN } })).toThrow(
        "finite positive",
      );
    });

    test("validation error is a KoiRuntimeError with VALIDATION code", () => {
      try {
        createToolExecution({ defaultTimeoutMs: -1 });
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("VALIDATION");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Abort signal scenarios
  // ---------------------------------------------------------------------------

  describe("abort signals", () => {
    test("scenario 1: pre-aborted signal throws KoiRuntimeError immediately", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("user_cancel");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() =>
        Promise.resolve({ output: "should not reach" } satisfies ToolResponse),
      );

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        // Handler should NOT have been called
        expect(handler).not.toHaveBeenCalled();
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("aborted");
        expect((e as KoiRuntimeError).retryable).toBe(false);
      }
    });

    test("scenario 2: signal fires during tool execution throws abort error", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () =>
        new Promise((_resolve, reject) => {
          controller.abort("user_cancel");
          reject(new DOMException("The operation was aborted", "AbortError"));
        });

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("aborted");
      }
    });

    test("scenario 2b: signal aborts during next() with never-settling handler", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 5000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () => {
        controller.abort("user_cancel");
        return new Promise(() => {});
      };

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("aborted");
      }
    });

    test("scenario 3: per-tool timeout fires throws timeout error", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 50 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => new Promise(() => {});

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("timed out");
        expect((e as KoiRuntimeError).retryable).toBe(false);
      }
    });

    test("scenario 4: race between parent abort and timeout — first wins", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 10_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("user_cancel");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() =>
        Promise.resolve({ output: "should not reach" } satisfies ToolResponse),
      );

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(handler).not.toHaveBeenCalled();
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("aborted");
      }
    });

    test("scenario 5: no signal provided — tool executes normally", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ signal: undefined });

      const expected: ToolResponse = { output: "success" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(response).toEqual(expected);
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
  });

  // ---------------------------------------------------------------------------
  // 3. Error propagation (tool errors re-thrown as-is)
  // ---------------------------------------------------------------------------

  describe("error propagation", () => {
    test("shape 1: standard Error re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = new Error("something broke");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        // Tool errors are NOT wrapped — re-thrown as-is for outer middleware
        expect(e).toBe(original);
      }
    });

    test("shape 2: KoiRuntimeError re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = KoiRuntimeError.from("RATE_LIMIT", "Too many requests", { retryable: true });

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
        expect((e as KoiRuntimeError).code).toBe("RATE_LIMIT");
        expect((e as KoiRuntimeError).retryable).toBe(true);
      }
    });

    test("shape 3: plain string throw re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => Promise.reject("oops");

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe("oops");
      }
    });

    test("shape 4: null throw re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => Promise.reject(null);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeNull();
      }
    });

    test("shape 5: object with message re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = { message: "object error", statusCode: 500 };

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
      }
    });

    test("shape 6: DOMException AbortError becomes KoiRuntimeError TIMEOUT", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:abort" });

      const handler: ToolHandler = () =>
        Promise.reject(new DOMException("The operation was aborted", "AbortError"));

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("aborted");
      }
    });

    test("shape 7: DOMException TimeoutError becomes KoiRuntimeError TIMEOUT", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "test:timeout" });

      const handler: ToolHandler = () =>
        Promise.reject(new DOMException("The operation timed out", "TimeoutError"));

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("timed out");
      }
    });

    test("shape 8: non-standard DOMException re-thrown as-is", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = new DOMException("something else", "SyntaxError");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
      }
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
      // Verify referential equality for pure transparency
      expect(response).toBe(expected);
    });

    test("successful call forwards request to handler unchanged", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const input: JsonObject = { file: "/tmp/test.txt", encoding: "utf-8" };
      const request = createMockToolRequest({
        toolId: "fs:read",
        input,
        metadata: { trace: "abc" },
      });

      const handler = mock(() => Promise.resolve({ output: "content" } satisfies ToolResponse));

      await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
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

      const handler: ToolHandler = () => new Promise(() => {});

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
        expect((e as KoiRuntimeError).message).toContain("timed out");
      }
    });

    test("falls back to defaultTimeoutMs for non-matching toolId", async () => {
      const mw = createToolExecution({
        defaultTimeoutMs: 50,
        toolTimeouts: { "other:tool": 60_000 },
      });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ toolId: "unmatched:tool" });

      const handler: ToolHandler = () => new Promise(() => {});

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("TIMEOUT");
      }
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
  // 6. Integration: governance accounting
  // ---------------------------------------------------------------------------

  describe("integration with middleware chain", () => {
    test("tool errors propagate to outer middleware (governance sees failure)", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const toolError = new Error("tool crashed");

      const handler: ToolHandler = () => Promise.reject(toolError);

      // Simulate what governance extension does: try/catch around next()
      let recordedEvent: string | undefined;
      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        recordedEvent = "tool_success";
      } catch {
        recordedEvent = "tool_error";
      }

      // Governance must see the failure — NOT success
      expect(recordedEvent).toBe("tool_error");
    });

    test("timeout errors propagate to outer middleware (governance sees failure)", async () => {
      const mw = createToolExecution({ defaultTimeoutMs: 50 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => new Promise(() => {});

      let recordedEvent: string | undefined;
      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        recordedEvent = "tool_success";
      } catch {
        recordedEvent = "tool_error";
      }

      expect(recordedEvent).toBe("tool_error");
    });

    test("abort errors propagate to outer middleware (governance sees failure)", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("user_cancel");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() => Promise.resolve({ output: "nope" } satisfies ToolResponse));

      let recordedEvent: string | undefined;
      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        recordedEvent = "tool_success";
      } catch {
        recordedEvent = "tool_error";
      }

      expect(recordedEvent).toBe("tool_error");
    });

    test("successful calls propagate to outer middleware (governance sees success)", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler = mock(() => Promise.resolve({ output: "ok" } satisfies ToolResponse));

      let recordedEvent: string | undefined;
      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        recordedEvent = "tool_success";
      } catch {
        recordedEvent = "tool_error";
      }

      expect(recordedEvent).toBe("tool_success");
    });

    test("middleware composes with a pass-through wrapper", async () => {
      const mw = createToolExecution();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = { output: "from-tool" };

      const outerHandler: ToolHandler = async (req) => {
        return invokeWrapToolCall(mw, ctx, req, () => Promise.resolve(expected));
      };

      const response = await outerHandler(request);

      expect(response).toBe(expected);
    });
  });
});
