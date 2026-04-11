import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AuditEntry,
  AuditSink,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { ConfigChange } from "@koi/core/middleware";
import type { PermissionDecision, PermissionQuery } from "@koi/core/permission-backend";
import type { AuditMiddleware } from "./audit.js";
import { createAuditMiddleware } from "./audit.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createInMemorySink(): AuditSink & { readonly entries: readonly AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    get entries(): readonly AuditEntry[] {
      return entries;
    },
    async log(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },
    async flush(): Promise<void> {
      // no-op
    },
  };
}

function createSession(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "test-session" as SessionContext["sessionId"],
    runId: "test-run" as SessionContext["runId"],
    metadata: {},
  };
}

function createTurnContext(overrides?: Partial<TurnContext>): TurnContext {
  const session = createSession();
  return {
    session,
    turnIndex: 0,
    turnId: "test-turn" as TurnContext["turnId"],
    messages: [],
    metadata: {},
    ...overrides,
  };
}

function makeModelHandler(
  content = "mock response",
): (req: ModelRequest) => Promise<ModelResponse> {
  return async (_req: ModelRequest): Promise<ModelResponse> => ({
    content,
    model: "test-model",
  });
}

function makeFailingModelHandler(message: string): (req: ModelRequest) => Promise<ModelResponse> {
  return async (): Promise<ModelResponse> => {
    throw new Error(message);
  };
}

function makeToolHandler(output: unknown = "ok"): (req: ToolRequest) => Promise<ToolResponse> {
  return async (_req: ToolRequest): Promise<ToolResponse> => ({ output });
}

function makeFailingToolHandler(message: string): (req: ToolRequest) => Promise<ToolResponse> {
  return async (): Promise<ToolResponse> => {
    throw new Error(message);
  };
}

function makeStreamHandler(chunks: ModelChunk[]): (req: ModelRequest) => AsyncIterable<ModelChunk> {
  return (_req: ModelRequest): AsyncIterable<ModelChunk> => ({
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next(): Promise<IteratorResult<ModelChunk>> {
          const chunk = chunks[i++];
          if (chunk !== undefined) {
            return { value: chunk, done: false };
          }
          return { value: undefined as unknown as ModelChunk, done: true };
        },
      };
    },
  });
}

async function drainStream(stream: AsyncIterable<ModelChunk>): Promise<void> {
  for await (const _ of stream) {
    /* drain */
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAuditMiddleware", () => {
  let sink: AuditSink & { readonly entries: readonly AuditEntry[] };
  let mw: AuditMiddleware;
  const ctx = createTurnContext();
  const sessionCtx = createSession();

  beforeEach(() => {
    sink = createInMemorySink();
    mw = createAuditMiddleware({ sink });
  });

  afterEach(async () => {
    await mw.flush();
  });

  test("has name 'audit'", () => {
    expect(mw.name).toBe("audit");
  });

  test("has priority 300", () => {
    expect(mw.priority).toBe(300);
  });

  test("has phase 'observe'", () => {
    expect(mw.phase).toBe("observe");
  });

  test("describeCapabilities returns label 'audit'", () => {
    const fragment = mw.describeCapabilities(ctx);
    expect(fragment?.label).toBe("audit");
  });

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  test("logs session_start on onSessionStart", async () => {
    await mw.onSessionStart?.(sessionCtx);
    await mw.flush();
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("session_start");
    expect(sink.entries[0]?.sessionId).toBe("test-session");
    expect(sink.entries[0]?.schema_version).toBe(1);
  });

  test("logs session_end on onSessionEnd and flushes", async () => {
    await mw.onSessionEnd?.(sessionCtx);
    // onSessionEnd awaits flush internally
    expect(sink.entries).toHaveLength(1);
    expect(sink.entries[0]?.kind).toBe("session_end");
  });

  // ---------------------------------------------------------------------------
  // Model calls
  // ---------------------------------------------------------------------------

  test("logs model_call with timing", async () => {
    await mw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler());
    await mw.flush();
    expect(sink.entries).toHaveLength(1);
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected entry");
    expect(entry.kind).toBe("model_call");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.schema_version).toBe(1);
  });

  test("logs model error and re-throws", async () => {
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [] }, makeFailingModelHandler("model crash")),
    ).rejects.toThrow("model crash");
    await mw.flush();
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected entry");
    expect(entry.kind).toBe("model_call");
    expect(entry.error).toBeDefined();
    expect(entry.response).toBeUndefined();
  });

  test("logs tool_call with timing", async () => {
    await mw.wrapToolCall?.(ctx, { toolId: "calc", input: {} }, makeToolHandler());
    await mw.flush();
    expect(sink.entries).toHaveLength(1);
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected entry");
    expect(entry.kind).toBe("tool_call");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs tool error and re-throws", async () => {
    await expect(
      mw.wrapToolCall?.(ctx, { toolId: "bad", input: {} }, makeFailingToolHandler("tool crash")),
    ).rejects.toThrow("tool crash");
    await mw.flush();
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected entry");
    expect(entry.error).toBeDefined();
    expect(entry.response).toBeUndefined();
  });

  test("fire-and-forget does not block model call", async () => {
    const slowSink: AuditSink = {
      log: async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 500));
      },
    };
    const slowMw = createAuditMiddleware({ sink: slowSink });
    const start = Date.now();
    await slowMw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler());
    expect(Date.now() - start).toBeLessThan(200);
  });

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  test("logs model_call after stream completes", async () => {
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "done", response: { content: "hi", model: "test-model" } },
    ];
    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    const stream = mw.wrapModelStream(ctx, { messages: [] }, makeStreamHandler(chunks));
    await drainStream(stream);
    await mw.flush();
    const entry = sink.entries.find((e) => e.kind === "model_call");
    expect(entry).toBeDefined();
    expect(entry?.response).toBeDefined();
  });

  test("re-throws stream errors", async () => {
    const throwingHandler = (): AsyncIterable<ModelChunk> => ({
      [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
        return {
          next: async (): Promise<IteratorResult<ModelChunk>> => {
            throw new Error("stream-error");
          },
        };
      },
    });
    if (!mw.wrapModelStream) throw new Error("wrapModelStream not defined");
    await expect(
      drainStream(mw.wrapModelStream(ctx, { messages: [] }, throwingHandler)),
    ).rejects.toThrow("stream-error");
    await mw.flush();
    const entry = sink.entries.find((e) => e.kind === "model_call");
    expect(entry?.error).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Redaction + truncation
  // ---------------------------------------------------------------------------

  test("redactRequestBodies replaces request with [redacted]", async () => {
    const redactMw = createAuditMiddleware({ sink, redactRequestBodies: true });
    await redactMw.wrapModelCall?.(
      ctx,
      { messages: [], model: "secret-model" },
      makeModelHandler(),
    );
    await redactMw.flush();
    expect(sink.entries[0]?.request).toBe("[redacted]");
  });

  test("large payloads are truncated", async () => {
    const largeMw = createAuditMiddleware({ sink, maxEntrySize: 50 });
    const bigContent = "x".repeat(200);
    await largeMw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler(bigContent));
    await largeMw.flush();
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected entry");
    expect(JSON.stringify(entry.response ?? "").length).toBeLessThan(200);
  });

  // ---------------------------------------------------------------------------
  // Sink failure resilience
  // ---------------------------------------------------------------------------

  test("sink failure does not crash the middleware", async () => {
    const errors: unknown[] = [];
    const failSink: AuditSink = {
      log: async (): Promise<void> => {
        throw new Error("sink down");
      },
    };
    const failMw = createAuditMiddleware({
      sink: failSink,
      onError: (err) => errors.push(err),
    });
    const response = await failMw.wrapModelCall?.(ctx, { messages: [] }, makeModelHandler());
    await failMw.flush();
    expect(response?.content).toBe("mock response");
    expect(errors).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Permission + config hooks
  // ---------------------------------------------------------------------------

  describe("permission and config hooks", () => {
    const permCtx = createTurnContext({ turnIndex: 2 });

    test("onPermissionDecision logs permission_decision entry for allow", async () => {
      const query: PermissionQuery = { principal: "agent", action: "execute", resource: "bash" };
      const decision: PermissionDecision = { effect: "allow" };
      mw.onPermissionDecision?.(permCtx, query, decision);
      await mw.flush();
      const entry = sink.entries.find((e) => e.kind === "permission_decision");
      expect(entry).toBeDefined();
      expect(entry?.schema_version).toBe(1);
      expect(entry?.turnIndex).toBe(2);
    });

    test("onPermissionDecision logs permission_decision entry for deny", async () => {
      const query: PermissionQuery = { principal: "agent", action: "execute", resource: "bash" };
      const decision: PermissionDecision = { effect: "deny", reason: "not allowed" };
      mw.onPermissionDecision?.(permCtx, query, decision);
      await mw.flush();
      const entry = sink.entries.find((e) => e.kind === "permission_decision");
      expect(entry).toBeDefined();
      const response = entry?.response as { effect: string } | undefined;
      expect(response?.effect).toBe("deny");
    });

    test("onConfigChange logs config_change entry", async () => {
      const change: ConfigChange = { key: "model", oldValue: "gpt-4", newValue: "claude-3" };
      mw.onConfigChange?.(sessionCtx, change);
      await mw.flush();
      const entry = sink.entries.find((e) => e.kind === "config_change");
      expect(entry).toBeDefined();
      expect(entry?.schema_version).toBe(1);
      expect(entry?.turnIndex).toBe(-1);
    });

    test("redaction is applied through permission hook", async () => {
      const redactMw = createAuditMiddleware({
        sink,
        redaction: {
          customPatterns: [],
          patterns: [],
          fieldNames: ["resource"],
        },
      });
      const query: PermissionQuery = {
        principal: "agent",
        action: "read",
        resource: "secret-file",
      };
      const decision: PermissionDecision = { effect: "allow" };
      redactMw.onPermissionDecision?.(permCtx, query, decision);
      await redactMw.flush();
      const entry = sink.entries.find((e) => e.kind === "permission_decision");
      const req = entry?.request as { resource?: string } | undefined;
      // resource field should be censored (field-name match)
      expect(req?.resource).not.toBe("secret-file");
    });
  });
});
