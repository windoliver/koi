import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createRlmMiddleware } from "./rlm.js";
import type { RlmEvent } from "./types.js";

function turnCtx(): TurnContext {
  const rid = runId("r-1");
  return {
    session: { agentId: "a", sessionId: sessionId("s-1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function userMessage(text: string): InboundMessage {
  return { senderId: "user", timestamp: 0, content: [{ kind: "text", text }] };
}

interface RecordingHandler {
  readonly handler: ModelHandler;
  readonly calls: ReadonlyArray<ModelRequest>;
}

function recordingHandler(content: (req: ModelRequest, idx: number) => string): RecordingHandler {
  const calls: ModelRequest[] = [];
  const handler: ModelHandler = async (req) => {
    const idx = calls.length;
    calls.push(req);
    const part: ModelResponse = {
      content: content(req, idx),
      model: "test-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    return part;
  };
  return { handler, calls };
}

describe("createRlmMiddleware", () => {
  test("rejects malformed config", () => {
    expect(() => createRlmMiddleware({ maxInputTokens: -1 })).toThrow();
  });

  test("passes small requests through unchanged", async () => {
    const events: RlmEvent[] = [];
    const mw = createRlmMiddleware({
      maxInputTokens: 1_000,
      maxChunkChars: 50,
      onEvent: (e) => events.push(e),
    });
    const rec = recordingHandler(() => "answer");
    const req: ModelRequest = { messages: [userMessage("short")] };
    const out = await mw.wrapModelCall?.(turnCtx(), req, rec.handler);
    expect(out?.content).toBe("answer");
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0]).toBe(req);
    expect(events.some((e) => e.kind === "passthrough")).toBe(true);
  });

  test("segments oversized requests and reassembles in order", async () => {
    const events: RlmEvent[] = [];
    const mw = createRlmMiddleware({
      maxInputTokens: 5,
      maxChunkChars: 100,
      onEvent: (e) => events.push(e),
    });
    const rec = recordingHandler((_req, i) => `R${i}`);
    const big = "x".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)] };
    const out = await mw.wrapModelCall?.(turnCtx(), req, rec.handler);
    expect(rec.calls.length).toBe(3);
    expect(out?.content).toBe("R0\n\nR1\n\nR2");
    expect(out?.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
    const segmented = events.find((e) => e.kind === "segmented");
    if (segmented?.kind !== "segmented") throw new Error("expected segmented event");
    expect(segmented.segmentCount).toBe(3);
    const completed = events.filter((e) => e.kind === "segment-completed");
    expect(completed.length).toBe(3);
  });

  test("threshold boundary: tokens equal to maxInputTokens pass through", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 100,
      maxChunkChars: 10,
      estimator: {
        estimateText: () => 0,
        estimateMessages: () => 100,
      },
    });
    const rec = recordingHandler(() => "single");
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage("z")] }, rec.handler);
    expect(rec.calls.length).toBe(1);
    expect(out?.content).toBe("single");
  });

  test("threshold boundary: tokens just above maxInputTokens segments", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 100,
      maxChunkChars: 10,
      estimator: {
        estimateText: () => 0,
        estimateMessages: () => 101,
      },
    });
    const rec = recordingHandler(() => "part");
    const big = "y".repeat(100);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, rec.handler);
    expect(rec.calls.length).toBeGreaterThan(1);
    expect(out?.content.startsWith("part")).toBe(true);
  });

  test("composes with downstream middleware: next is invoked once per segment in order", async () => {
    const order: number[] = [];
    const mw = createRlmMiddleware({ maxInputTokens: 5, maxChunkChars: 100 });
    const handler: ModelHandler = async (_req) => {
      order.push(order.length);
      return { content: `seg${order.length - 1}`, model: "m" };
    };
    const big = "q".repeat(300);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler);
    expect(order).toEqual([0, 1, 2]);
    expect(out?.content).toBe("seg0\n\nseg1\n\nseg2");
  });

  test("segmentation tolerates a faulty onEvent callback", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 5,
      maxChunkChars: 100,
      onEvent: () => {
        throw new Error("boom");
      },
    });
    const rec = recordingHandler(() => "ok");
    const big = "w".repeat(300);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, rec.handler);
    expect(out?.content).toBe("ok\n\nok\n\nok");
  });

  test("fails closed when oversized but no single user text block exceeds maxChunkChars", async () => {
    // Total messages exceed the 5-token budget, but each user text block is
    // smaller than maxChunkChars (1000), so segmentation cannot reduce the
    // request. Middleware must fail closed rather than forwarding the
    // oversize request unchanged.
    const mw = createRlmMiddleware({ maxInputTokens: 5, maxChunkChars: 1000 });
    const rec = recordingHandler(() => "should-not-be-called");
    const req: ModelRequest = {
      messages: [
        userMessage("a".repeat(50)),
        userMessage("b".repeat(50)),
        userMessage("c".repeat(50)),
      ],
    };
    expect(mw.wrapModelCall?.(turnCtx(), req, rec.handler)).rejects.toThrow(
      /cannot reduce a request/i,
    );
    expect(rec.calls.length).toBe(0);
  });

  test("fails closed when oversized request carries tools", async () => {
    // Segmenting tool-enabled requests would fan out tool calls across
    // segments. Middleware must refuse rather than silently multiply
    // side-effecting tool executions.
    const mw = createRlmMiddleware({ maxInputTokens: 5, maxChunkChars: 100 });
    const rec = recordingHandler(() => "irrelevant");
    const big = "x".repeat(300);
    const req: ModelRequest = {
      messages: [userMessage(big)],
      tools: [
        {
          name: "delete_file",
          description: "delete a file",
          inputSchema: { type: "object" },
        },
      ],
    };
    expect(mw.wrapModelCall?.(turnCtx(), req, rec.handler)).rejects.toThrow(/tool descriptors/i);
    expect(rec.calls.length).toBe(0);
  });

  test("oversized requests with an empty tools array still segment", async () => {
    // tools: [] should be treated as "no tools" — the fan-out concern only
    // applies when tool descriptors are actually present.
    const mw = createRlmMiddleware({ maxInputTokens: 5, maxChunkChars: 100 });
    const rec = recordingHandler(() => "ok");
    const big = "y".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)], tools: [] };
    const out = await mw.wrapModelCall?.(turnCtx(), req, rec.handler);
    expect(rec.calls.length).toBeGreaterThan(1);
    expect(out?.content).toContain("ok");
  });

  test("describeCapabilities returns a label", () => {
    const mw = createRlmMiddleware();
    const cap = mw.describeCapabilities?.(turnCtx());
    expect(cap).toBeDefined();
    if (cap === undefined || Array.isArray(cap)) throw new Error("expected single fragment");
    expect(cap.label).toBe("rlm");
  });
});
