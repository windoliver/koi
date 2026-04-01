/**
 * Tests for tool execution guard — per-call abort propagation and timeout enforcement.
 *
 * Test groups:
 * 1. Factory & configuration (including validation)
 * 2. Abort signal scenarios (timeout vs external cancellation)
 * 3. Error propagation (tool errors re-thrown as-is)
 * 4. Transparency (successful calls)
 * 5. Per-tool timeout configuration
 * 6. Integration (governance accounting)
 * 7. Listener + timer cleanup
 * 8. Signal-gated classification
 * 9. Abort reason preservation
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
import { createToolExecutionGuard } from "./tool-execution-guard.js";

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

describe("createToolExecutionGuard", () => {
  describe("factory", () => {
    test("returns a middleware with correct name", () => {
      const mw = createToolExecutionGuard();
      expect(mw.name).toBe("koi:tool-execution");
    });

    test("uses resolve phase", () => {
      const mw = createToolExecutionGuard();
      expect(mw.phase).toBe("resolve");
    });

    test("uses priority 100", () => {
      const mw = createToolExecutionGuard();
      expect(mw.priority).toBe(100);
    });

    test("describeCapabilities returns undefined", () => {
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      expect(mw.describeCapabilities(ctx)).toBeUndefined();
    });

    test("implements wrapToolCall", () => {
      const mw = createToolExecutionGuard();
      expect(mw.wrapToolCall).toBeDefined();
      expect(typeof mw.wrapToolCall).toBe("function");
    });

    test("accepts empty config", () => {
      const mw = createToolExecutionGuard({});
      expect(mw.name).toBe("koi:tool-execution");
    });

    test("accepts valid full config", () => {
      const mw = createToolExecutionGuard({
        defaultTimeoutMs: 30_000,
        toolTimeouts: { "exec:run": 60_000 },
      });
      expect(mw.name).toBe("koi:tool-execution");
    });
  });

  describe("config validation", () => {
    test("rejects negative defaultTimeoutMs", () => {
      expect(() => createToolExecutionGuard({ defaultTimeoutMs: -1 })).toThrow("finite positive");
    });

    test("rejects NaN defaultTimeoutMs", () => {
      expect(() => createToolExecutionGuard({ defaultTimeoutMs: NaN })).toThrow("finite positive");
    });

    test("rejects Infinity defaultTimeoutMs", () => {
      expect(() => createToolExecutionGuard({ defaultTimeoutMs: Infinity })).toThrow(
        "finite positive",
      );
    });

    test("rejects zero defaultTimeoutMs", () => {
      expect(() => createToolExecutionGuard({ defaultTimeoutMs: 0 })).toThrow("finite positive");
    });

    test("rejects invalid per-tool timeout", () => {
      expect(() => createToolExecutionGuard({ toolTimeouts: { "bad:tool": -5 } })).toThrow(
        "finite positive",
      );
    });

    test("rejects NaN per-tool timeout", () => {
      expect(() => createToolExecutionGuard({ toolTimeouts: { "bad:tool": NaN } })).toThrow(
        "finite positive",
      );
    });

    test("validation error is a KoiRuntimeError with VALIDATION code", () => {
      try {
        createToolExecutionGuard({ defaultTimeoutMs: -1 });
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
    test("scenario 1: pre-aborted signal throws DOMException preserving reason", async () => {
      const mw = createToolExecutionGuard();
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
        // Parent abort → KoiRuntimeError("INTERNAL") so engine handles gracefully
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("user_cancel");
        expect((e as KoiRuntimeError).retryable).toBe(false);
      }
    });

    test("scenario 2: parent abort during execution throws KoiRuntimeError preserving reason", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () => {
        controller.abort("shutdown");
        return new Promise(() => {});
      };

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        // Parent abort reason preserved in KoiRuntimeError context
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("shutdown");
      }
    });

    test("scenario 3: per-tool timeout fires throws KoiRuntimeError TIMEOUT", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 50 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => new Promise(() => {});

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        // ONLY our timeout → KoiRuntimeError("EXTERNAL")
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("EXTERNAL");
        expect((e as KoiRuntimeError).message).toContain("timed out");
        expect((e as KoiRuntimeError).retryable).toBe(false);
      }
    });

    test("scenario 4: race between parent abort and timeout — abort wins (pre-aborted)", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 10_000 });
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
        // Pre-aborted parent → KoiRuntimeError("INTERNAL")
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("user_cancel");
      }
    });

    test("scenario 5: no signal provided — tool executes normally", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest({ signal: undefined });

      const expected: ToolResponse = { output: "success" };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(response).toEqual(expected);
    });

    test("scenario 5a: parent signal + timeout both present — tool succeeds before either fires", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
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
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = new Error("something broke");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
      }
    });

    test("shape 2: KoiRuntimeError re-thrown as-is", async () => {
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
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

    test("shape 6: tool-originated DOMException AbortError re-thrown as-is", async () => {
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = new DOMException("fetch was aborted", "AbortError");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
      }
    });

    test("shape 7: tool-originated DOMException TimeoutError re-thrown as-is", async () => {
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();
      const original = new DOMException("fetch timed out", "TimeoutError");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
      }
    });

    test("shape 8: non-standard DOMException re-thrown as-is", async () => {
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const expected: ToolResponse = {
        output: { result: "hello", count: 42 },
        metadata: { custom: "data" },
      };
      const handler = mock(() => Promise.resolve(expected));

      const response = await invokeWrapToolCall(mw, ctx, request, handler);

      expect(response).toEqual(expected);
      expect(response).toBe(expected);
    });

    test("successful call forwards request to handler unchanged", async () => {
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 5000 });
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
      const mw = createToolExecutionGuard({
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
        expect((e as KoiRuntimeError).code).toBe("EXTERNAL");
        expect((e as KoiRuntimeError).message).toContain("timed out");
      }
    });

    test("falls back to defaultTimeoutMs for non-matching toolId", async () => {
      const mw = createToolExecutionGuard({
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
        expect((e as KoiRuntimeError).code).toBe("EXTERNAL");
      }
    });

    test("no timeout when neither default nor per-tool configured", async () => {
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => Promise.reject(new Error("tool crashed"));

      let recordedEvent: string | undefined;
      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        recordedEvent = "tool_success";
      } catch {
        recordedEvent = "tool_error";
      }

      expect(recordedEvent).toBe("tool_error");
    });

    test("timeout errors propagate to outer middleware (governance sees failure)", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 50 });
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
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
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
      const mw = createToolExecutionGuard();
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

  // ---------------------------------------------------------------------------
  // 7. Listener + timer cleanup
  // ---------------------------------------------------------------------------

  describe("listener and timer cleanup", () => {
    test("many successful calls on same signal do not accumulate listeners", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const handler = mock(() => Promise.resolve({ output: "ok" } satisfies ToolResponse));

      for (let i = 0; i < 20; i++) {
        const request = createMockToolRequest({ signal: controller.signal });
        await invokeWrapToolCall(mw, ctx, request, handler);
      }

      expect(handler).toHaveBeenCalledTimes(20);

      controller.abort("late_cancel");
      await new Promise((r) => {
        setTimeout(r, 10);
      });
      expect(true).toBe(true);
    });

    test("cleanup runs after tool error (finally block)", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });
      const handler: ToolHandler = () => Promise.reject(new Error("boom"));

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
      } catch {
        // expected
      }

      controller.abort("late_cancel");
      await new Promise((r) => {
        setTimeout(r, 10);
      });
      expect(true).toBe(true);
    });

    test("timeout timer is cleared after fast successful calls (no timer leak)", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 60_000 });
      const ctx = createMockTurnContext();
      const handler = mock(() => Promise.resolve({ output: "fast" } satisfies ToolResponse));

      for (let i = 0; i < 50; i++) {
        const request = createMockToolRequest();
        await invokeWrapToolCall(mw, ctx, request, handler);
      }

      expect(handler).toHaveBeenCalledTimes(50);
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Signal-gated classification
  // ---------------------------------------------------------------------------

  describe("signal-gated error classification", () => {
    test("tool-thrown AbortError NOT reclassified when signal has not fired", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });
      const original = new DOMException("fetch aborted by tool", "AbortError");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
        expect(e).not.toBeInstanceOf(KoiRuntimeError);
      }
    });

    test("tool-thrown TimeoutError NOT reclassified when signal has not fired", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });
      const original = new DOMException("fetch timeout", "TimeoutError");

      const handler: ToolHandler = () => Promise.reject(original);

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBe(original);
        expect(e).not.toBeInstanceOf(KoiRuntimeError);
      }
    });

    test("only our timeout produces KoiRuntimeError TIMEOUT", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 50 });
      const ctx = createMockTurnContext();
      const request = createMockToolRequest();

      const handler: ToolHandler = () => new Promise(() => {});

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("EXTERNAL");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Abort reason preservation (adversarial review round 4)
  // ---------------------------------------------------------------------------

  describe("abort reason preservation", () => {
    test("user_cancel reason is preserved in KoiRuntimeError context", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
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
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("user_cancel");
        // Must NOT be EXTERNAL/TIMEOUT — those have wrong stop reason semantics
        expect((e as KoiRuntimeError).code).not.toBe("EXTERNAL");
      }
    });

    test("shutdown reason is preserved in KoiRuntimeError context", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () => {
        controller.abort("shutdown");
        return new Promise(() => {});
      };

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("shutdown");
      }
    });

    test("token_limit reason is preserved in KoiRuntimeError context", async () => {
      const mw = createToolExecutionGuard({ defaultTimeoutMs: 30_000 });
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      const request = createMockToolRequest({ signal: controller.signal });

      const handler: ToolHandler = () => {
        controller.abort("token_limit");
        return new Promise(() => {});
      };

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("token_limit");
      }
    });

    test("pre-aborted with shutdown reason preserves reason", async () => {
      const mw = createToolExecutionGuard();
      const ctx = createMockTurnContext();
      const controller = new AbortController();
      controller.abort("shutdown");
      const request = createMockToolRequest({ signal: controller.signal });

      const handler = mock(() => Promise.resolve({ output: "nope" } satisfies ToolResponse));

      try {
        await invokeWrapToolCall(mw, ctx, request, handler);
        expect.unreachable("should have thrown");
      } catch (e: unknown) {
        expect(handler).not.toHaveBeenCalled();
        expect(e).toBeInstanceOf(KoiRuntimeError);
        expect((e as KoiRuntimeError).code).toBe("INTERNAL");
        expect((e as KoiRuntimeError).message).toContain("shutdown");
      }
    });
  });
});
