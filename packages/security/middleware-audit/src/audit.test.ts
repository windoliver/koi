import { describe, expect, test } from "bun:test";
import { runId, sessionId } from "@koi/core";
import {
  createMockModelStreamHandler,
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
  createSpyModelStreamHandler,
  createSpyToolHandler,
} from "@koi/test-utils";
import { createAuditMiddleware } from "./audit.js";
import type { AuditSink } from "./sink.js";
import { createInMemoryAuditSink } from "./sink.js";

describe("createAuditMiddleware", () => {
  const ctx = createMockTurnContext();
  const sessionCtx = createMockSessionContext();

  test("has name 'audit'", () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    expect(mw.name).toBe("audit");
  });

  test("has priority 300", () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    expect(mw.priority).toBe(300);
  });

  test("logs session_start on onSessionStart", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    await mw.onSessionStart?.(sessionCtx);
    // Allow fire-and-forget to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("session_start");
    expect(sink.entries[0]?.sessionId).toBe("session-test-1");
  });

  test("logs session_end on onSessionEnd", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    await mw.onSessionEnd?.(sessionCtx);
    // flush is called in onSessionEnd
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("session_end");
  });

  test("calls flush on onSessionEnd", async () => {
    let flushed = false;
    const sink: AuditSink = {
      log: async () => {},
      flush: async () => {
        flushed = true;
      },
    };
    const mw = createAuditMiddleware({ sink });
    await mw.onSessionEnd?.(sessionCtx);
    expect(flushed).toBe(true);
  });

  test("logs model_call with timing", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("model_call");
    expect(sink.entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs tool_call with timing", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const spy = createSpyToolHandler();
    await mw.wrapToolCall?.(ctx, { toolId: "calc", input: {} }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("tool_call");
    expect(sink.entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs error path for model call", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const failingHandler = async () => {
      throw new Error("model crash");
    };
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, failingHandler);
    } catch {
      // expected
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.error).toBeDefined();
    expect(sink.entries[0]?.response).toBeUndefined();
  });

  test("logs error path for tool call", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const failingHandler = async () => {
      throw new Error("tool crash");
    };
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "bad", input: {} }, failingHandler);
    } catch {
      // expected
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.error).toBeDefined();
  });

  test("re-throws errors from model call", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const failingHandler = async () => {
      throw new Error("model crash");
    };
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, failingHandler);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("model crash");
    }
  });

  test("re-throws errors from tool call", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const failingHandler = async () => {
      throw new Error("tool crash");
    };
    try {
      await mw.wrapToolCall?.(ctx, { toolId: "bad", input: {} }, failingHandler);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect((e as Error).message).toBe("tool crash");
    }
  });

  test("PII redacted from entries", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({
      sink,
      redactionRules: [{ pattern: /secret-key-\w+/g, replacement: "[REDACTED]" }],
    });
    const spy = createSpyModelHandler({ content: "contains secret-key-abc123" });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    const entry = sink.entries[0];
    expect(entry).toBeDefined();
    const responseStr = JSON.stringify(entry?.response);
    expect(responseStr).not.toContain("secret-key-abc123");
    expect(responseStr).toContain("[REDACTED]");
  });

  test("large payloads truncated", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink, maxEntrySize: 50 });
    const largeContent = "x".repeat(200);
    const spy = createSpyModelHandler({ content: largeContent });
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    const entry = sink.entries[0];
    expect(entry).toBeDefined();
    const responseStr = JSON.stringify(entry?.response);
    expect(responseStr.length).toBeLessThan(200);
  });

  test("redactRequestBodies hides request data", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink, redactRequestBodies: true });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctx, { messages: [], model: "secret-model" }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries[0]?.request).toBe("[redacted]");
  });

  test("audit sink failure does not crash middleware", async () => {
    const errors: unknown[] = [];
    const failingSink: AuditSink = {
      log: async () => {
        throw new Error("sink down");
      },
    };
    const mw = createAuditMiddleware({
      sink: failingSink,
      onError: (err) => {
        errors.push(err);
      },
    });
    const spy = createSpyModelHandler();
    const response = await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    // Give fire-and-forget time to resolve
    await new Promise((r) => setTimeout(r, 50));
    expect(response?.content).toBe("mock response");
    expect(errors).toHaveLength(1);
  });

  test("fire-and-forget does not block chain", async () => {
    const slowSink: AuditSink = {
      log: async () => {
        await new Promise((r) => setTimeout(r, 500));
      },
    };
    const mw = createAuditMiddleware({ sink: slowSink });
    const spy = createSpyModelHandler();
    const startTime = Date.now();
    await mw.wrapModelCall?.(ctx, { messages: [] }, spy.handler);
    const elapsed = Date.now() - startTime;
    // Should return much faster than 500ms since log is fire-and-forget
    expect(elapsed).toBeLessThan(200);
  });

  test("logs agentId and sessionId correctly", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const customCtx = createMockTurnContext({
      session: {
        agentId: "custom-agent",
        sessionId: sessionId("custom-session"),
        runId: runId("custom-run"),
        metadata: {},
      },
    });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(customCtx, { messages: [] }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries[0]?.agentId).toBe("custom-agent");
    expect(sink.entries[0]?.sessionId).toBe("custom-session");
  });

  test("logs turnIndex correctly", async () => {
    const sink = createInMemoryAuditSink();
    const mw = createAuditMiddleware({ sink });
    const ctxTurn5 = createMockTurnContext({ turnIndex: 5 });
    const spy = createSpyModelHandler();
    await mw.wrapModelCall?.(ctxTurn5, { messages: [] }, spy.handler);
    await new Promise((r) => setTimeout(r, 10));
    expect(sink.entries[0]?.turnIndex).toBe(5);
  });

  describe("wrapModelStream", () => {
    async function drainStream(iter: AsyncIterable<unknown>): Promise<void> {
      for await (const _ of iter) {
        /* drain */
      }
    }

    // Unwrap the optional wrapModelStream method, throwing if not implemented.
    function streamOf(
      mw: ReturnType<typeof createAuditMiddleware>,
    ): NonNullable<(typeof mw)["wrapModelStream"]> {
      const fn = mw.wrapModelStream;
      if (!fn) throw new Error("wrapModelStream not defined on audit middleware");
      return fn;
    }

    test("logs model_call entry after stream completes", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const spy = createSpyModelStreamHandler([
        { kind: "text_delta", delta: "hi" },
        { kind: "done", response: { content: "hi", model: "test-model" } },
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, spy.handler));

      // Allow fire-and-forget
      await new Promise((r) => setTimeout(r, 10));
      const entry = sink.entries.find((e) => e.kind === "model_call");
      expect(entry).toBeDefined();
      expect(entry?.kind).toBe("model_call");
      expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    });

    test("captures done chunk response in audit entry", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const response = {
        content: "answer",
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      const handler = createMockModelStreamHandler([{ kind: "done", response }]);

      await drainStream(streamOf(mw)(ctx, { messages: [] }, handler));
      await new Promise((r) => setTimeout(r, 10));

      const entry = sink.entries.find((e) => e.kind === "model_call");
      expect(entry).toBeDefined();
      // Response should be captured (not undefined)
      expect(entry?.response).toBeDefined();
    });

    test("logs model_call with error when stream throws", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const throwingHandler = (): AsyncIterable<never> => ({
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: async (): Promise<IteratorResult<never>> => {
              throw new Error("stream-failed");
            },
          };
        },
      });

      await expect(
        drainStream(streamOf(mw)(ctx, { messages: [] }, throwingHandler)),
      ).rejects.toThrow("stream-failed");

      await new Promise((r) => setTimeout(r, 10));
      const entry = sink.entries.find((e) => e.kind === "model_call");
      expect(entry).toBeDefined();
      expect(entry?.error).toBeDefined();
    });

    test("re-throws stream errors", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const throwingHandler = (): AsyncIterable<never> => ({
        [Symbol.asyncIterator](): AsyncIterator<never> {
          return {
            next: async (): Promise<IteratorResult<never>> => {
              throw new Error("propagated-error");
            },
          };
        },
      });

      await expect(
        drainStream(streamOf(mw)(ctx, { messages: [] }, throwingHandler)),
      ).rejects.toThrow("propagated-error");
    });

    test("redactRequestBodies hides request in stream entry", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink, redactRequestBodies: true });
      const handler = createMockModelStreamHandler([
        { kind: "done", response: { content: "ok", model: "test-model" } },
      ]);

      await drainStream(streamOf(mw)(ctx, { messages: [], model: "secret-model" }, handler));
      await new Promise((r) => setTimeout(r, 10));

      const entry = sink.entries.find((e) => e.kind === "model_call");
      expect(entry?.request).toBe("[redacted]");
    });

    test("yields all chunks from next handler", async () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const spy = createSpyModelStreamHandler([
        { kind: "text_delta", delta: "hello" },
        { kind: "text_delta", delta: " world" },
        { kind: "done", response: { content: "hello world", model: "test-model" } },
      ]);

      const collected: string[] = [];
      for await (const chunk of streamOf(mw)(ctx, { messages: [] }, spy.handler)) {
        if (chunk.kind === "text_delta") collected.push(chunk.delta);
      }

      expect(collected).toEqual(["hello", " world"]);
      expect(spy.calls).toHaveLength(1);
    });
  });

  describe("describeCapabilities", () => {
    test("is defined on the middleware", () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      expect(mw.describeCapabilities).toBeDefined();
    });

    test("returns label 'audit' and expected description", () => {
      const sink = createInMemoryAuditSink();
      const mw = createAuditMiddleware({ sink });
      const result = mw.describeCapabilities?.(ctx);
      expect(result?.label).toBe("audit");
      expect(result?.description).toBe("Compliance audit logging active");
    });
  });
});
