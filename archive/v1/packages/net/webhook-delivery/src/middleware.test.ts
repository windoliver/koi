import { describe, expect, mock, test } from "bun:test";
import type { EventBackend, SessionContext, ToolRequest, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createWebhookMiddleware } from "./middleware.js";

const TEST_RUN_ID = runId("run-test-001");

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sessionId("sess-test-001"),
    runId: TEST_RUN_ID,
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: makeSessionCtx(),
    turnIndex: 0,
    turnId: turnId(TEST_RUN_ID, 0),
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function makeEventBackend(): EventBackend & {
  readonly calls: Array<{
    readonly streamId: string;
    readonly event: { readonly type: string; readonly data: unknown };
  }>;
} {
  const calls: Array<{
    readonly streamId: string;
    readonly event: { readonly type: string; readonly data: unknown };
  }> = [];

  return {
    calls,
    append(streamId, event) {
      calls.push({ streamId, event: event as { readonly type: string; readonly data: unknown } });
      return {
        ok: true as const,
        value: {
          id: "evt_1",
          streamId,
          type: event.type,
          timestamp: Date.now(),
          sequence: 1,
          data: event.data,
        },
      };
    },
    read: mock(() => ({ ok: true as const, value: { events: [], hasMore: false } })),
    subscribe: mock(() => ({
      subscriptionName: "test",
      streamId: "test",
      unsubscribe: () => {},
      position: () => 0,
    })),
    queryDeadLetters: mock(() => ({ ok: true as const, value: [] })),
    retryDeadLetter: mock(() => ({ ok: true as const, value: true })),
    purgeDeadLetters: mock(() => ({ ok: true as const, value: undefined })),
    streamLength: mock(() => 0),
    firstSequence: mock(() => 0),
    close: mock(() => {}),
  };
}

describe("createWebhookMiddleware", () => {
  test("has correct name and priority", () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend);

    expect(mw.name).toBe("webhook");
    expect(mw.priority).toBe(900);
  });

  test("onSessionStart emits session.started event", async () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend);
    const ctx = makeSessionCtx({ agentId: "agent-1" });

    await mw.onSessionStart?.(ctx);

    // Fire-and-forget — give microtask a tick to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.streamId).toBe("webhook:agent-1");
    expect(backend.calls[0]?.event.type).toBe("session.started");
  });

  test("onSessionEnd emits session.ended event", async () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend);
    const ctx = makeSessionCtx({ agentId: "agent-2" });

    await mw.onSessionEnd?.(ctx);
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.event.type).toBe("session.ended");
  });

  test("wrapToolCall emits tool.succeeded on success", async () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend);
    const ctx = makeTurnCtx();
    const request: ToolRequest = { toolId: "file_read", input: {} };
    const response = { output: "file contents" };

    const result = await mw.wrapToolCall?.(ctx, request, async () => response);
    await new Promise((r) => setTimeout(r, 10));

    expect(result).toBe(response);
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.event.type).toBe("tool.succeeded");
  });

  test("wrapToolCall emits tool.failed on error and re-throws", async () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend);
    const ctx = makeTurnCtx();
    const request: ToolRequest = { toolId: "dangerous_tool", input: {} };

    const toolError = new Error("Tool exploded");
    await expect(
      mw.wrapToolCall?.(ctx, request, async () => {
        throw toolError;
      }),
    ).rejects.toThrow("Tool exploded");

    await new Promise((r) => setTimeout(r, 10));

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]?.event.type).toBe("tool.failed");
  });

  test("fire-and-forget: append failure does not block middleware", async () => {
    const failingBackend = makeEventBackend();
    // Override append to return failure
    (failingBackend as { append: EventBackend["append"] }).append = () => ({
      ok: false as const,
      error: {
        code: "INTERNAL" as const,
        message: "Storage unavailable",
        retryable: false,
      },
    });

    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg) };
    const mw = createWebhookMiddleware(failingBackend, undefined, logger);

    // Should not throw
    await mw.onSessionStart?.(makeSessionCtx());
    await new Promise((r) => setTimeout(r, 10));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("append failed");
  });

  test("uses custom stream prefix", async () => {
    const backend = makeEventBackend();
    const mw = createWebhookMiddleware(backend, { streamPrefix: "custom" });

    await mw.onSessionStart?.(makeSessionCtx({ agentId: "a1" }));
    await new Promise((r) => setTimeout(r, 10));

    expect(backend.calls[0]?.streamId).toBe("custom:a1");
  });
});
