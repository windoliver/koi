/**
 * E2E integration tests for hook-blocked model/tool/stream calls.
 *
 * These tests use REAL hook execution (command spawns and HTTP servers)
 * through the full middleware pipeline — no mocked executors.
 * Verifies that stopReason: "hook_blocked" propagates end-to-end.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import type {
  HookConfig,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelStreamHandler,
  RunId,
  SessionContext,
  SessionId,
  ToolHandler,
  ToolRequest,
  TurnContext,
  TurnId,
} from "@koi/core";
import { createHookMiddleware } from "../middleware.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Type-narrowing assertion — fails the test if value is undefined. */
function assertDefined<T>(value: T | undefined): asserts value is T {
  expect(value).toBeDefined();
}

function makeSessionCtx(overrides?: Partial<SessionContext>): SessionContext {
  return {
    agentId: "agent-e2e",
    sessionId: "session-e2e" as SessionId,
    runId: "run-e2e" as RunId,
    metadata: {},
    ...overrides,
  };
}

function makeTurnCtx(overrides?: Partial<TurnContext>): TurnContext {
  return {
    session: makeSessionCtx(),
    turnIndex: 0,
    turnId: "turn-e2e" as TurnId,
    messages: [],
    metadata: {},
    ...overrides,
  };
}

async function collectChunks(stream: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Local HTTP test server (returns block decisions)
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let serverUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/block") {
        return new Response(JSON.stringify({ decision: "block", reason: "http hook says no" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/continue") {
        return new Response(JSON.stringify({ decision: "continue" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("ok", { status: 200 });
    },
  });
  serverUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// E2E: Command hook blocks model call
// ---------------------------------------------------------------------------

describe("E2E: command hook blocks model call", () => {
  it("returns stopReason hook_blocked with empty content via real command execution", async () => {
    const blockingHook: HookConfig = {
      kind: "command",
      name: "cmd-blocker",
      cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"budget exceeded"}\''],
      filter: { events: ["compact.before"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [blockingHook] });
    const sessionCtx = makeSessionCtx();
    const turnCtx = makeTurnCtx({ session: sessionCtx });

    await mw.onSessionStart?.(sessionCtx);

    const nextFn = mock<ModelHandler>().mockResolvedValue({
      content: "should never reach this",
      model: "real-model",
    });

    const request: ModelRequest = { messages: [], model: "test-model" };
    const result = await mw.wrapModelCall?.(turnCtx, request, nextFn);
    assertDefined(result);

    expect(nextFn).not.toHaveBeenCalled();
    expect(result.content).toBe("");
    expect(result.stopReason).toBe("hook_blocked");
    expect(result.model).toBe("test-model");
    assertDefined(result.metadata);
    expect((result.metadata as Record<string, unknown>).blockedByHook).toBe(true);
    expect((result.metadata as Record<string, unknown>).reason).toBe("budget exceeded");
    expect((result.metadata as Record<string, unknown>).hookName).toBe("cmd-blocker");

    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// E2E: HTTP hook blocks model call
// ---------------------------------------------------------------------------

describe("E2E: HTTP hook blocks model call", () => {
  it("returns stopReason hook_blocked via real HTTP hook execution", async () => {
    const blockingHook: HookConfig = {
      kind: "http",
      name: "http-blocker",
      url: `${serverUrl}/block`,
      filter: { events: ["compact.before"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [blockingHook] });
    const sessionCtx = makeSessionCtx();
    const turnCtx = makeTurnCtx({ session: sessionCtx });

    await mw.onSessionStart?.(sessionCtx);

    const nextFn = mock<ModelHandler>().mockResolvedValue({
      content: "should never reach",
      model: "real-model",
    });

    const request: ModelRequest = { messages: [], model: "gpt-4" };
    const result = await mw.wrapModelCall?.(turnCtx, request, nextFn);
    assertDefined(result);

    expect(nextFn).not.toHaveBeenCalled();
    expect(result.content).toBe("");
    expect(result.stopReason).toBe("hook_blocked");
    expect((result.metadata as Record<string, unknown>).blockedByHook).toBe(true);
    expect((result.metadata as Record<string, unknown>).reason).toBe("http hook says no");
    expect((result.metadata as Record<string, unknown>).hookName).toBe("http-blocker");

    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// E2E: Command hook blocks model stream
// ---------------------------------------------------------------------------

describe("E2E: command hook blocks model stream", () => {
  it("yields error chunk with PERMISSION code via real command execution", async () => {
    const blockingHook: HookConfig = {
      kind: "command",
      name: "stream-blocker",
      cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"stream denied"}\''],
      filter: { events: ["compact.before"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [blockingHook] });
    const sessionCtx = makeSessionCtx();
    const turnCtx = makeTurnCtx({ session: sessionCtx });

    await mw.onSessionStart?.(sessionCtx);

    const nextFn: ModelStreamHandler = () => {
      throw new Error("should not be called");
    };

    const stream = mw.wrapModelStream?.(turnCtx, { messages: [] }, nextFn);
    assertDefined(stream);
    const chunks = await collectChunks(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.kind).toBe("error");
    if (chunks[0]?.kind === "error") {
      expect(chunks[0].message).toContain("stream denied");
      expect(chunks[0].message).toContain("Hook blocked model_stream");
      expect(chunks[0].code).toBe("PERMISSION");
      expect(chunks[0].retryable).toBe(false);
    }

    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// E2E: Command hook blocks tool call
// ---------------------------------------------------------------------------

describe("E2E: command hook blocks tool call", () => {
  it("returns error output with blockedByHook metadata via real command execution", async () => {
    const blockingHook: HookConfig = {
      kind: "command",
      name: "tool-blocker",
      cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"tool not permitted"}\''],
      filter: { events: ["tool.before"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [blockingHook] });
    const sessionCtx = makeSessionCtx();
    const turnCtx = makeTurnCtx({ session: sessionCtx });

    await mw.onSessionStart?.(sessionCtx);

    const nextFn = mock<ToolHandler>().mockResolvedValue({
      output: "should never reach",
    });

    const request: ToolRequest = { toolId: "bash", input: { cmd: "rm -rf /" } };
    const result = await mw.wrapToolCall?.(turnCtx, request, nextFn);
    assertDefined(result);

    expect(nextFn).not.toHaveBeenCalled();
    expect(result.output).toEqual({ error: "Hook blocked tool_call: tool not permitted" });
    assertDefined(result.metadata);
    expect((result.metadata as Record<string, unknown>).blockedByHook).toBe(true);
    expect((result.metadata as Record<string, unknown>).hookName).toBe("tool-blocker");

    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// E2E: Non-blocking hook allows model call through
// ---------------------------------------------------------------------------

describe("E2E: non-blocking hook allows model call", () => {
  it("passes through to next() when hook returns continue", async () => {
    const passingHook: HookConfig = {
      kind: "http",
      name: "passthrough",
      url: `${serverUrl}/continue`,
      filter: { events: ["compact.before"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [passingHook] });
    const sessionCtx = makeSessionCtx();
    const turnCtx = makeTurnCtx({ session: sessionCtx });

    await mw.onSessionStart?.(sessionCtx);

    const nextFn = mock<ModelHandler>().mockResolvedValue({
      content: "real model response",
      model: "gpt-4",
      stopReason: "stop",
    });

    const request: ModelRequest = { messages: [], model: "gpt-4" };
    const result = await mw.wrapModelCall?.(turnCtx, request, nextFn);
    assertDefined(result);

    expect(nextFn).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("real model response");
    expect(result.stopReason).toBe("stop");

    await mw.onSessionEnd?.(sessionCtx);
  });
});

// ---------------------------------------------------------------------------
// E2E: Session blocked by hook
// ---------------------------------------------------------------------------

describe("E2E: session blocked by hook", () => {
  it("throws on session start when hook blocks with consistent message format", async () => {
    const sessionBlocker: HookConfig = {
      kind: "command",
      name: "session-guard",
      cmd: ["sh", "-c", 'echo \'{"decision":"block","reason":"quota exhausted"}\''],
      filter: { events: ["session.started"] },
      timeoutMs: 5000,
    };

    const mw = createHookMiddleware({ hooks: [sessionBlocker] });
    const sessionCtx = makeSessionCtx();

    await expect(mw.onSessionStart?.(sessionCtx)).rejects.toThrow(
      "Hook blocked session: quota exhausted",
    );
  });
});
