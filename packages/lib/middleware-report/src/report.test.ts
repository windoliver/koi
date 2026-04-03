import { describe, expect, it } from "bun:test";
import type {
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  SessionId,
  ToolHandler,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";

import { createReportMiddleware } from "./report.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionCtx(sid?: SessionId): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: sid ?? sessionId("s1"),
    runId: runId("r1"),
    metadata: {},
  };
}

function makeTurnCtx(session: SessionContext, opts?: { turnIndex?: number }): TurnContext {
  const ti = opts?.turnIndex ?? 0;
  return {
    session,
    turnIndex: ti,
    turnId: turnId(runId("r1"), ti),
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(): ModelRequest {
  return { messages: [] };
}

function makeModelResponse(opts?: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}): ModelResponse {
  return {
    content: "Hello",
    model: opts?.model ?? "test-model",
    usage: {
      inputTokens: opts?.inputTokens ?? 100,
      outputTokens: opts?.outputTokens ?? 50,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createReportMiddleware", () => {
  it("returns a ReportHandle with middleware", () => {
    const handle = createReportMiddleware();
    expect(handle.middleware.name).toBe("report");
    expect(handle.middleware.priority).toBe(275);
    expect(handle.middleware.phase).toBe("observe");
  });

  it("throws on invalid config", () => {
    expect(() => createReportMiddleware({ maxActions: -1 })).toThrow();
  });

  it("records model calls", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const handler: ModelHandler = async () => makeModelResponse();
    await mw.wrapModelCall?.(ctx, makeModelRequest(), handler);

    const progress = handle.getProgress(session.sessionId);
    expect(progress.totalActions).toBe(1);
    expect(progress.inputTokens).toBe(100);
    expect(progress.outputTokens).toBe(50);
  });

  it("records tool calls", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const handler: ToolHandler = async () => ({ output: "ok" });
    await mw.wrapToolCall?.(ctx, { toolId: "file_read", input: {} }, handler);

    const progress = handle.getProgress(session.sessionId);
    expect(progress.totalActions).toBe(1);
  });

  it("records model call failures as critical issues", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const handler: ModelHandler = async () => {
      throw new Error("rate limit");
    };

    await expect(mw.wrapModelCall?.(ctx, makeModelRequest(), handler)).rejects.toThrow(
      "rate limit",
    );

    const progress = handle.getProgress(session.sessionId);
    expect(progress.totalActions).toBe(1);
    expect(progress.issueCount).toBe(1);
  });

  it("records tool call failures as warning issues", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const handler: ToolHandler = async () => {
      throw new Error("permission denied");
    };

    await expect(
      mw.wrapToolCall?.(ctx, { toolId: "file_write", input: {} }, handler),
    ).rejects.toThrow("permission denied");

    const progress = handle.getProgress(session.sessionId);
    expect(progress.issueCount).toBe(1);
  });

  it("generates RunReport on session end", async () => {
    const handle = createReportMiddleware({ objective: "Test objective" });
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse());
    await mw.onAfterTurn?.(ctx);
    await mw.onSessionEnd?.(session);

    const report = handle.getReport(session.sessionId);
    if (report === undefined) throw new Error("report should be defined");
    expect(report.objective).toBe("Test objective");
    expect(report.duration.totalTurns).toBe(1);
    expect(report.duration.totalActions).toBe(1);
    expect(report.actions).toHaveLength(1);
    expect(report.cost.inputTokens).toBe(100);
    expect(report.cost.outputTokens).toBe(50);
    expect(report.summary).toContain("Completed 1 actions");
  });

  it("fires onProgress callback after each turn", async () => {
    const snapshots: unknown[] = [];
    const handle = createReportMiddleware({
      onProgress: async (snap) => {
        snapshots.push(snap);
      },
    });
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse());
    await mw.onAfterTurn?.(ctx);

    expect(snapshots).toHaveLength(1);
  });

  it("fires onReport callback at session end", async () => {
    const reports: unknown[] = [];
    const handle = createReportMiddleware({
      onReport: async (report, formatted) => {
        reports.push({ report, formatted });
      },
    });
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await mw.onSessionEnd?.(session);

    expect(reports).toHaveLength(1);
  });

  it("returns zeroed progress before session start", () => {
    const handle = createReportMiddleware();
    const progress = handle.getProgress(sessionId("nonexistent"));
    expect(progress.totalActions).toBe(0);
    expect(progress.elapsedMs).toBe(0);
  });

  it("returns undefined report before session end", () => {
    const handle = createReportMiddleware();
    expect(handle.getReport(sessionId("nonexistent"))).toBeUndefined();
  });

  it("describes capabilities with action/token count", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    await mw.wrapModelCall?.(ctx, makeModelRequest(), async () => makeModelResponse());

    const cap = mw.describeCapabilities(ctx);
    expect(cap).toEqual({ label: "report", description: "1 actions, 150 tokens used" });
  });

  it("cleans up session state after end", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);
    await mw.onSessionEnd?.(session);

    const ctx = makeTurnCtx(session);
    expect(mw.describeCapabilities(ctx)).toBeUndefined();
  });

  it("records streamed model calls with token usage", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const streamHandler: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "Hello" } as ModelChunk;
      yield { kind: "usage", inputTokens: 80, outputTokens: 40 } as ModelChunk;
      yield {
        kind: "done",
        response: makeModelResponse({ model: "streamed-model" }),
      } as ModelChunk;
    };

    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      for await (const _chunk of stream) {
        // consume
      }
    }

    const progress = handle.getProgress(session.sessionId);
    expect(progress.totalActions).toBe(1);
    expect(progress.inputTokens).toBe(80);
    expect(progress.outputTokens).toBe(40);
  });

  it("records streamed model failures as critical issues", async () => {
    const handle = createReportMiddleware();
    const mw = handle.middleware;
    const session = makeSessionCtx();
    await mw.onSessionStart?.(session);

    const ctx = makeTurnCtx(session);
    const streamHandler: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "partial" } as ModelChunk;
      throw new Error("stream interrupted");
    };

    const stream = mw.wrapModelStream?.(ctx, makeModelRequest(), streamHandler);
    if (stream) {
      try {
        for await (const _chunk of stream) {
          // consume
        }
      } catch {
        // expected
      }
    }

    const progress = handle.getProgress(session.sessionId);
    expect(progress.totalActions).toBe(1);
    expect(progress.issueCount).toBe(1);
  });

  it("evicts oldest reports when exceeding maxReports", async () => {
    const handle = createReportMiddleware({ maxReports: 2 });
    const mw = handle.middleware;

    // Create 3 sessions
    for (const id of ["s1", "s2", "s3"]) {
      const session = makeSessionCtx(sessionId(id));
      await mw.onSessionStart?.(session);
      await mw.onSessionEnd?.(session);
    }

    // s1 should be evicted, s2 and s3 retained
    expect(handle.getReport(sessionId("s1"))).toBeUndefined();
    expect(handle.getReport(sessionId("s2"))).toBeDefined();
    expect(handle.getReport(sessionId("s3"))).toBeDefined();
  });
});
