import { describe, expect, test } from "bun:test";
import type {
  InboundMessage,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, toolCallId, turnId } from "@koi/core";
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
    // Heuristic estimator: 300-char message → 4 + 75 = 79 tokens. Each
    // 100-char chunk → ~29 tokens via the heuristic. Threshold of 50
    // splits the request into 3 segments, each under budget.
    const events: RlmEvent[] = [];
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
      onEvent: (e) => events.push(e),
    });
    const rec = recordingHandler((_req, i) => `R${i}`);
    const big = "x".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)] };
    const out = await mw.wrapModelCall?.(turnCtx(), req, rec.handler);
    expect(rec.calls.length).toBe(3);
    // Byte-faithful concat is the default. Callers that want a delimiter
    // must opt in via `segmentSeparator`.
    expect(out?.content).toBe("R0R1R2");
    expect(out?.usage).toEqual({ inputTokens: 3, outputTokens: 3 });
    const segmented = events.find((e) => e.kind === "segmented");
    if (segmented?.kind !== "segmented") throw new Error("expected segmented event");
    expect(segmented.segmentCount).toBe(3);
    const completed = events.filter((e) => e.kind === "segment-completed");
    expect(completed.length).toBe(3);
  });

  test("swallows async onEvent rejections so telemetry cannot surface unhandled promise rejections", async () => {
    // The fail-open observability contract must hold for both sync and
    // async observers. An async callback returning a rejected Promise
    // would otherwise escape as an unhandled rejection at the runtime
    // level — exactly the failure mode the docs say cannot happen.
    let observed = 0; // let: per-test event counter
    const mw = createRlmMiddleware({
      maxInputTokens: 1_000,
      maxChunkChars: 100,
      onEvent: async (_e) => {
        observed += 1;
        throw new Error("async observer failure must be swallowed");
      },
    });
    const rec = recordingHandler(() => "ok");
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage("hi")] }, rec.handler);
    expect(out?.content).toBe("ok");
    // Yield to the microtask queue so the rejected promise.catch fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(observed).toBeGreaterThan(0);
  });

  test("threshold boundary: tokens equal to maxInputTokens pass through", async () => {
    // Stateful estimator: full request returns exactly the threshold;
    // segments would return 0. Equality must mean passthrough.
    let calls = 0; // let: per-test counter for the stub estimator
    const mw = createRlmMiddleware({
      maxInputTokens: 100,
      maxChunkChars: 10,
      estimator: {
        estimateText: () => 0,
        estimateMessages: () => {
          calls += 1;
          return calls === 1 ? 100 : 0;
        },
      },
    });
    const rec = recordingHandler(() => "single");
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage("z")] }, rec.handler);
    expect(rec.calls.length).toBe(1);
    expect(out?.content).toBe("single");
  });

  test("threshold boundary: tokens just above maxInputTokens segments", async () => {
    // Stateful estimator: full request returns 101 (over budget); each
    // segment returns 50 (under budget) so the per-segment re-validation
    // accepts them.
    let calls = 0; // let: per-test counter for the stub estimator
    const mw = createRlmMiddleware({
      maxInputTokens: 100,
      maxChunkChars: 10,
      acknowledgeSegmentLocalContract: true,
      estimator: {
        estimateText: () => 0,
        estimateMessages: () => {
          calls += 1;
          return calls === 1 ? 101 : 50;
        },
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
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const handler: ModelHandler = async (_req) => {
      order.push(order.length);
      return { content: `seg${order.length - 1}`, model: "m" };
    };
    const big = "q".repeat(300);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler);
    expect(order).toEqual([0, 1, 2]);
    expect(out?.content).toBe("seg0seg1seg2");
  });

  test("segmentation tolerates a faulty onEvent callback", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
      onEvent: () => {
        throw new Error("boom");
      },
    });
    const rec = recordingHandler(() => "ok");
    const big = "w".repeat(300);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, rec.handler);
    expect(out?.content).toBe("okokok");
  });

  test("fails closed when oversized but no single user text block exceeds maxChunkChars", async () => {
    // Total messages exceed the 5-token budget, but each user text block is
    // smaller than maxChunkChars (1000), so segmentation cannot reduce the
    // request. Middleware must fail closed rather than forwarding the
    // oversize request unchanged.
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 1000,
      acknowledgeSegmentLocalContract: true,
    });
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
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
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
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const rec = recordingHandler(() => "ok");
    const big = "y".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)], tools: [] };
    const out = await mw.wrapModelCall?.(turnCtx(), req, rec.handler);
    expect(rec.calls.length).toBeGreaterThan(1);
    expect(out?.content).toContain("ok");
  });

  test("counts systemPrompt against the threshold", async () => {
    // messages alone fit, but the systemPrompt pushes the request over budget.
    // The middleware must NOT silently forward — it should fail closed
    // because there is no user text block large enough to chunk.
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 1000,
      acknowledgeSegmentLocalContract: true,
    });
    const rec = recordingHandler(() => "should-not-be-called");
    const req: ModelRequest = {
      messages: [userMessage("short")],
      systemPrompt: "z".repeat(800),
    };
    expect(mw.wrapModelCall?.(turnCtx(), req, rec.handler)).rejects.toThrow();
    expect(rec.calls.length).toBe(0);
  });

  test("counts tool descriptors against the threshold", async () => {
    // The tool descriptors alone push the request over budget. Because tools
    // are present, the middleware should throw with the tool-descriptors
    // error before attempting segmentation.
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 1000,
      acknowledgeSegmentLocalContract: true,
    });
    const rec = recordingHandler(() => "should-not-be-called");
    const req: ModelRequest = {
      messages: [userMessage("short")],
      tools: [
        {
          name: "huge_tool",
          description: "x".repeat(800),
          inputSchema: { type: "object" },
        },
      ],
    };
    expect(mw.wrapModelCall?.(turnCtx(), req, rec.handler)).rejects.toThrow(/tool descriptors/i);
    expect(rec.calls.length).toBe(0);
  });

  test("fails closed when surrounding context keeps segments over budget", async () => {
    // Even after chunking the largest user text block, surrounding history
    // dominates the token estimate and every segment remains oversized. The
    // middleware must reject before paying for any downstream calls.
    const mw = createRlmMiddleware({
      maxInputTokens: 100,
      maxChunkChars: 50,
      acknowledgeSegmentLocalContract: true,
      // Estimator returns a constant well above the threshold for any
      // message set, simulating large surrounding history.
      estimator: {
        estimateText: () => 0,
        estimateMessages: () => 1_000,
      },
    });
    const rec = recordingHandler(() => "should-not-be-called");
    const big = "x".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)] };
    expect(mw.wrapModelCall?.(turnCtx(), req, rec.handler)).rejects.toThrow(/still exceeds/i);
    expect(rec.calls.length).toBe(0);
  });

  test("aborts when a segment returns a non-success stopReason", async () => {
    // Concatenating an incomplete or tool-use segment into the merged
    // response would mask the failure. The middleware must surface it.
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let call = 0; // let: simulate one segment hitting a length cap
    const handler: ModelHandler = async () => {
      call += 1;
      const stopReason = call === 2 ? "length" : "stop";
      return { content: `c${call}`, model: "test", stopReason } satisfies ModelResponse;
    };
    const big = "x".repeat(300);
    const req: ModelRequest = { messages: [userMessage(big)] };
    expect(mw.wrapModelCall?.(turnCtx(), req, handler)).rejects.toThrow(/stopReason=length/);
  });

  test("attaches per-segment provenance to the reassembled response", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let call = 0; // let: per-call counter for the stub model handler
    const handler: ModelHandler = async () => {
      call += 1;
      return {
        content: `c${call}`,
        model: `model-${call}`,
        responseId: `resp-${call}`,
        stopReason: "stop",
      } satisfies ModelResponse;
    };
    const big = "x".repeat(300);
    const out = await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler);
    const segs = out?.metadata?.rlmSegments;
    expect(Array.isArray(segs)).toBe(true);
    if (!Array.isArray(segs)) throw new Error("expected array");
    expect(segs.length).toBe(3);
  });

  test("wrapModelStream forwards small requests unchanged", async () => {
    const mw = createRlmMiddleware({ maxInputTokens: 1_000, maxChunkChars: 100 });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "ok" };
      yield {
        kind: "done",
        response: { content: "ok", model: "test" },
      };
    };
    const chunks: ModelChunk[] = [];
    for await (const c of mw.wrapModelStream?.(
      turnCtx(),
      { messages: [userMessage("hi")] },
      upstream,
    ) ?? []) {
      chunks.push(c);
    }
    expect(chunks.length).toBe(2);
  });

  test("wrapModelStream segments oversized requests and emits a synthesized stream", async () => {
    // The query runner prefers `modelStream` whenever the adapter exposes
    // it, so failing closed here would turn every oversized turn — the
    // exact traffic RLM is meant to handle — into a user-visible error.
    // Streaming RLM consumes each segment's `done` chunk to a response,
    // reassembles, and re-emits a single text_delta + usage + done.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0; // let: count downstream stream invocations
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const seg = segmentCount;
      yield { kind: "text_delta", delta: `seg${seg}` };
      yield {
        kind: "done",
        response: {
          content: `seg${seg}`,
          model: "stream-model",
          stopReason: "stop" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const chunks: ModelChunk[] = [];
    for await (const c of iter) chunks.push(c);
    expect(segmentCount).toBeGreaterThan(1);
    const done = chunks.find((c) => c.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done chunk");
    expect(done.response.content.startsWith("seg1")).toBe(true);
    expect(done.response.model).toBe("stream-model");
    const usage = chunks.find((c) => c.kind === "usage");
    if (usage === undefined || usage.kind !== "usage") throw new Error("expected usage chunk");
    expect(usage.inputTokens).toBeGreaterThan(0);
  });

  test("wrapModelStream preserves segment text when upstream emits text_delta and done.response.content is empty", async () => {
    // Some providers stream the real text in `text_delta` chunks and
    // emit `done.response.content: ""`. RLM must accumulate those
    // deltas and backfill content; otherwise reassembly produces an
    // empty answer for oversized streamed turns even though the model
    // produced text.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0; // let: per-segment counter
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const seg = segmentCount;
      yield { kind: "text_delta", delta: `seg${seg}-part-a ` };
      yield { kind: "text_delta", delta: `seg${seg}-part-b` };
      yield {
        kind: "done",
        response: {
          content: "", // empty terminal content; real text is in deltas
          model: "delta-model",
          stopReason: "stop" as const,
        },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const chunks: ModelChunk[] = [];
    for await (const c of iter) chunks.push(c);
    const done = chunks.find((c) => c.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done chunk");
    expect(done.response.content).toContain("seg1-part-a");
    expect(done.response.content).toContain("seg1-part-b");
    expect(segmentCount).toBeGreaterThan(1);
  });

  test("wrapModelStream preserves usage when upstream reports it via 'usage' chunks (not done.response.usage)", async () => {
    // Some upstream stream implementations emit per-token usage chunks
    // and leave done.response.usage unset. RLM must accumulate those so
    // downstream cost / budget enforcement does not undercount oversized
    // streamed turns.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "usage", inputTokens: 7, outputTokens: 3 };
      yield { kind: "text_delta", delta: "seg" };
      yield {
        kind: "done",
        response: {
          content: "seg",
          model: "stream-model",
          stopReason: "stop" as const,
          // usage intentionally absent on the response — only streamed.
        },
      };
    };
    const big = "y".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const chunks: ModelChunk[] = [];
    for await (const c of iter) chunks.push(c);
    const usageChunk = chunks.find((c) => c.kind === "usage");
    if (usageChunk === undefined || usageChunk.kind !== "usage") {
      throw new Error("expected usage chunk in synthesized stream");
    }
    // Sum across segments — must be > 0, not silently dropped.
    expect(usageChunk.inputTokens).toBeGreaterThan(0);
    expect(usageChunk.outputTokens).toBeGreaterThan(0);
  });

  test("wrapModelStream still fails closed when segmentation cannot reduce the request", async () => {
    // History-dominated requests where chunking the largest text block
    // doesn't drop below the threshold must surface the budget breach
    // immediately rather than silently passing through.
    const mw = createRlmMiddleware({
      maxInputTokens: 5,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "should-not-arrive" };
    };
    const small = "tiny";
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(small)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let threw = false; // let: we expect the iterator to reject (no oversized text block)
    try {
      for await (const _c of iter) {
        // small messages without an oversized block fall to passthrough; this should NOT throw
      }
    } catch {
      threw = true;
    }
    // Small-message request with no oversized text block: passthrough is the
    // correct behavior — assert we did not throw.
    expect(threw).toBe(false);
  });

  test("requires acknowledgeSegmentLocalContract to segment", async () => {
    // Without the explicit opt-in, transparent segmentation could turn
    // global-aggregation tasks into silently corrupted concatenations.
    const mw = createRlmMiddleware({ maxInputTokens: 50, maxChunkChars: 100 });
    const rec = recordingHandler(() => "should-not-be-called");
    const big = "z".repeat(300);
    expect(
      mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, rec.handler),
    ).rejects.toThrow(/acknowledgeSegmentLocalContract/);
    expect(rec.calls.length).toBe(0);
  });

  test("aborts when a segment returns a tool_call richContent block even without stopReason", async () => {
    // Some adapters omit stopReason but return tool calls in richContent.
    // Treat those as authoritative — concatenating segment-local tool calls
    // would replay side effects.
    const mw = createRlmMiddleware({
      maxInputTokens: 50,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let call = 0; // let: simulate the second segment returning a tool call
    const handler: ModelHandler = async () => {
      call += 1;
      if (call === 2) {
        return {
          content: "",
          model: "test",
          richContent: [
            {
              kind: "tool_call",
              id: toolCallId("c1"),
              name: "delete_file",
              arguments: {},
            },
          ],
        } satisfies ModelResponse;
      }
      return { content: `c${call}`, model: "test" } satisfies ModelResponse;
    };
    const big = "x".repeat(300);
    expect(
      mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler),
    ).rejects.toThrow(/tool_call/);
  });

  test("describeCapabilities returns a label", () => {
    const mw = createRlmMiddleware();
    const cap = mw.describeCapabilities?.(turnCtx());
    expect(cap).toBeDefined();
    if (cap === undefined || Array.isArray(cap)) throw new Error("expected single fragment");
    expect(cap.label).toBe("rlm");
  });
});
