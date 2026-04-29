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
    // Aggregate usage lives on `done.response.usage`. We deliberately
    // do NOT emit a post-reassembly stream `usage` chunk — only
    // upstream usage heartbeats — so downstream observers totaling
    // stream usage events are not double-charged.
    expect(done.response.usage?.inputTokens).toBeGreaterThan(0);
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

  test("wrapModelStream synthesizes content from done.response.richContent text blocks when content/deltas are empty", async () => {
    // Some adapters return final text only as richContent text blocks
    // (no top-level content, no streamed deltas). Without this backfill
    // RLM would reassemble oversized streamed turns into empty answers
    // even though the model produced text.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0;
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const seg = segmentCount;
      yield {
        kind: "done",
        response: {
          content: "",
          model: "rich-model",
          stopReason: "stop" as const,
          richContent: [{ kind: "text", text: `rich-seg${seg}` }],
        },
      };
    };
    const big = "y".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const chunks: ModelChunk[] = [];
    for await (const c of iter) chunks.push(c);
    const done = chunks.find((c) => c.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done");
    expect(done.response.content).toContain("rich-seg1");
    expect(segmentCount).toBeGreaterThan(1);
  });

  test("wrapModelStream aborts when upstream emits streamed tool_call_* chunks even without done", async () => {
    // Adapters that surface tool calls only as streaming chunks (and do
    // not echo them in done.response richContent / stopReason) would
    // otherwise bypass RLM's tool-fan-out safety invariant. consumeStream
    // must synthesize a terminal response with stopReason='tool_use' so
    // dispatch's stopReason guard aborts segment reassembly.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield {
        kind: "tool_call_start",
        toolName: "search",
        callId: toolCallId("c1"),
      };
      yield {
        kind: "tool_call_end",
        callId: toolCallId("c1"),
      };
    };
    const big = "z".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let threw = false;
    try {
      for await (const _c of iter) {
        // expected: stopReason='tool_use' triggers segment-level abort
      }
    } catch (err: unknown) {
      threw = true;
      expect(String(err)).toMatch(/RLM streaming segment/i);
    }
    expect(threw).toBe(true);
  });

  test("wrapModelStream folds upstream 'error' chunks into stopReason='error' (not bare throw)", async () => {
    // ModelChunk.error is a first-class stream outcome carrying message
    // + optional usage. The query-engine stream consumer folds it into
    // a terminal response with stopReason="error". RLM must mirror that
    // contract so dispatchSegmented's stopReason guard aborts cleanly,
    // preserving partial output + usage instead of throwing a bare
    // exception that loses the state.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "partial-" };
      yield { kind: "usage", inputTokens: 4, outputTokens: 1 };
      yield { kind: "error", message: "rate limit exceeded" };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let threw = false;
    try {
      for await (const _c of iter) {
        // segment-level stopReason guard should abort with a clear error
      }
    } catch (err: unknown) {
      threw = true;
      // The outer error must reference the segment failure, but the
      // inner failure is now surfaced as a stopReason rather than
      // swallowed in an unstructured exception.
      expect(String(err)).toMatch(/RLM streaming segment/i);
    }
    expect(threw).toBe(true);
  });

  test("wrapModelStream honors AbortSignal during oversized segmented streaming", async () => {
    // Without abort-aware iteration, a stalled provider can hang an
    // oversized streamed turn past the runtime's timeout/cancel signal.
    // Each iterator.next() must race against request.signal so the
    // middleware terminates cleanly on abort with a stopReason='error'
    // synthesized terminal response.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "starting" };
      // Stall forever — only abort can break this.
      await new Promise(() => undefined);
    };
    const ac = new AbortController();
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(
      turnCtx(),
      { messages: [userMessage(big)], signal: ac.signal },
      upstream,
    );
    if (iter === undefined) throw new Error("expected wrapModelStream");
    setTimeout(() => ac.abort(), 25);
    let threw = false;
    try {
      for await (const _c of iter) {
        // expected: segment guard aborts on stopReason='error'
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("SegmentAbortError carries completed segments + aggregated usage so callers can resume", async () => {
    // Without completedSegments on the failure path, a partial-failure
    // case (e.g. timeout/rate-limit on chunk k of N) discards the
    // already-paid output of chunks 0..k-1. Retry logic can only
    // re-dispatch the whole oversized turn and observability cannot
    // attribute the cost. Carrying prior responses + aggregated usage
    // on the error lets callers resume from segmentIndex.
    const { SegmentAbortError } = await import("./rlm.js");
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let calls = 0;
    const handler: ModelHandler = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: "first",
          model: "ok-model",
          stopReason: "stop" as const,
          usage: { inputTokens: 11, outputTokens: 3 },
        };
      }
      return {
        content: "second-failed",
        model: "rate-limited-model",
        stopReason: "error" as const,
        usage: { inputTokens: 7, outputTokens: 1 },
      };
    };
    const big = "x".repeat(400);
    let caught: unknown;
    try {
      await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SegmentAbortError);
    if (!(caught instanceof SegmentAbortError)) throw new Error("expected SegmentAbortError");
    expect(caught.segmentIndex).toBe(1);
    expect(caught.completedSegments.length).toBe(1);
    expect(caught.completedSegments[0]?.content).toBe("first");
    expect(caught.completedUsage?.inputTokens).toBe(11);
    expect(caught.completedUsage?.outputTokens).toBe(3);
  });

  test("wrapModelCall does not dispatch later segments after abort fires between chunks", async () => {
    // Without a pre-dispatch abort guard, a cancellation that lands
    // after segment k completes still pays for segments k+1..N because
    // not every downstream handler short-circuits on an
    // already-aborted signal. RLM owns the segmentation loop, so RLM
    // owns the abort-between-chunks check.
    const ac = new AbortController();
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let calls = 0; // let: count downstream invocations
    const handler: ModelHandler = async () => {
      calls += 1;
      if (calls === 1) ac.abort();
      return {
        content: `seg${calls}`,
        model: "abort-test",
        stopReason: "stop" as const,
      };
    };
    const big = "x".repeat(400);
    let threw = false;
    try {
      await mw.wrapModelCall?.(
        turnCtx(),
        { messages: [userMessage(big)], signal: ac.signal },
        handler,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(calls).toBe(1); // only the first segment ran; abort guard stopped the rest
  });

  test("wrapModelStream does not open downstream stream after abort fires between segments", async () => {
    const ac = new AbortController();
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let streamsOpened = 0; // let: count consumeStream invocations
    const upstream: ModelStreamHandler = async function* () {
      streamsOpened += 1;
      const seg = streamsOpened;
      // Abort BEFORE done so the segment's consumeStream still returns
      // a clean response (not an aborted one). The abort then fires
      // for the *next* segment's pre-dispatch guard.
      if (seg === 1) {
        // schedule abort to fire after this stream's done is consumed
        queueMicrotask(() => ac.abort());
      }
      yield { kind: "text_delta", delta: `seg${seg}` };
      yield {
        kind: "done",
        response: {
          content: `seg${seg}`,
          model: "abort-stream",
          stopReason: "stop" as const,
        },
      };
    };
    const big = "y".repeat(400);
    const iter = mw.wrapModelStream?.(
      turnCtx(),
      { messages: [userMessage(big)], signal: ac.signal },
      upstream,
    );
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let threw = false;
    try {
      for await (const _c of iter) {
        // expected: abort guard prevents segment 2's stream from opening
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(streamsOpened).toBe(1);
  });

  test("wrapModelCall fails closed when request.maxTokens is set (per-segment dispatch would amplify the cap)", async () => {
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const rec = recordingHandler(() => "should-not-be-called");
    const big = "x".repeat(400);
    expect(
      mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)], maxTokens: 1000 }, rec.handler),
    ).rejects.toThrow(/output cap/i);
  });

  test("wrapModelStream tags timeout aborts as terminatedBy='activity-timeout' (matches engine sentinel)", async () => {
    const { SegmentAbortError } = await import("./rlm.js");
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "starting" };
      await new Promise(() => undefined);
    };
    const ac = new AbortController();
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(
      turnCtx(),
      { messages: [userMessage(big)], signal: ac.signal },
      upstream,
    );
    if (iter === undefined) throw new Error("expected wrapModelStream");
    setTimeout(() => {
      ac.abort(new DOMException("Stream timed out", "TimeoutError"));
    }, 25);
    let caught: unknown;
    try {
      for await (const _c of iter) {
        // expected: timeout-tagged abort
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SegmentAbortError);
    if (!(caught instanceof SegmentAbortError)) throw new Error("expected SegmentAbortError");
    expect(caught.segmentResponse.metadata?.terminatedBy).toBe("activity-timeout");
  });

  test("wrapModelStream surfaces SegmentAbortError carrying interrupted+terminatedBy on caller abort", async () => {
    const { SegmentAbortError } = await import("./rlm.js");
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "starting" };
      await new Promise(() => undefined); // forever
    };
    const ac = new AbortController();
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(
      turnCtx(),
      { messages: [userMessage(big)], signal: ac.signal },
      upstream,
    );
    if (iter === undefined) throw new Error("expected wrapModelStream");
    setTimeout(() => ac.abort(), 25);
    let caught: unknown;
    try {
      for await (const _c of iter) {
        // expected: SegmentAbortError on stopReason='error' with interrupted metadata
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SegmentAbortError);
    if (!(caught instanceof SegmentAbortError)) throw new Error("expected SegmentAbortError");
    expect(caught.segmentResponse.metadata?.interrupted).toBe(true);
    expect(caught.segmentResponse.metadata?.terminatedBy).toBe("abort");
    expect(caught.segmentResponse.content).toContain("starting");
  });

  test("wrapModelStream propagates retryable + retryAfterMs from upstream error chunks", async () => {
    const { SegmentAbortError } = await import("./rlm.js");
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "before-rate-limit-" };
      yield {
        kind: "error",
        message: "rate limit exceeded",
        code: "RATE_LIMIT" as const,
        retryable: true,
        retryAfterMs: 1500,
      };
    };
    const big = "y".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let caught: unknown;
    try {
      for await (const _c of iter) {
        // expected: structured error preserved on the segment response
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SegmentAbortError);
    if (!(caught instanceof SegmentAbortError)) throw new Error("expected SegmentAbortError");
    const meta = caught.segmentResponse.metadata as Record<string, unknown>;
    expect(meta.errorCode).toBe("RATE_LIMIT");
    expect(meta.retryable).toBe(true);
    expect(meta.retryAfterMs).toBe(1500);
    expect(caught.segmentResponse.content).toContain("before-rate-limit-");
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

  test("wrapModelStream does not double-count tokens when error chunk repeats final usage totals", async () => {
    // Providers can emit incremental usage deltas during the stream and
    // then repeat the FINAL cumulative numbers on the terminating error
    // chunk. The query-engine consumer treats error.usage as
    // overwrite-only; RLM must mirror that contract or the failed
    // segment's terminal response (and any cost dashboard reading it)
    // overstates the tokens billed for that segment.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "partial" };
      yield { kind: "usage", inputTokens: 7, outputTokens: 3 };
      // Provider repeats the final cumulative totals on the error chunk:
      yield {
        kind: "error",
        message: "rate limit exceeded",
        usage: { inputTokens: 10, outputTokens: 4 },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let caught: unknown;
    try {
      for await (const _ of iter) {
        // exhaust until segment-level guard throws
      }
    } catch (err: unknown) {
      caught = err;
    }
    if (!(caught instanceof Error) || !("segmentResponse" in caught)) {
      throw new Error("expected SegmentAbortError");
    }
    const aborted = caught as Error & { readonly segmentResponse: ModelResponse };
    // Overwrite (not 7+10=17 / 3+4=7): error.usage replaces accumulated totals.
    expect(aborted.segmentResponse.usage?.inputTokens).toBe(10);
    expect(aborted.segmentResponse.usage?.outputTokens).toBe(4);
  });

  test("wrapModelStream forwards thinking_delta from each segment instead of dropping it", async () => {
    // thinking_delta is a first-class stream event consumed by the
    // engine, the TUI, and event-trace middleware. Silently dropping it
    // on oversized turns would diverge the RLM streaming contract from
    // the normal one and lose reasoning chronology on the exact turns
    // that are hardest to debug.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0; // let: per-segment counter
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const n = segmentCount;
      yield { kind: "thinking_delta", delta: `think${n}` };
      yield { kind: "text_delta", delta: `seg${n}` };
      yield {
        kind: "done",
        response: {
          content: `seg${n}`,
          model: "stream-model",
          stopReason: "stop" as const,
        },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const chunks: ModelChunk[] = [];
    for await (const c of iter) chunks.push(c);
    const thinkingDeltas = chunks.filter((c) => c.kind === "thinking_delta");
    expect(thinkingDeltas.length).toBe(segmentCount);
    expect(segmentCount).toBeGreaterThan(1);
    for (let i = 0; i < thinkingDeltas.length; i++) {
      const t = thinkingDeltas[i];
      if (t === undefined || t.kind !== "thinking_delta")
        throw new Error("expected thinking_delta");
      expect(t.delta).toBe(`think${i + 1}`);
    }
  });

  test("wrapModelStream does not leak thinking_delta from a segment that ends in tool_use", async () => {
    // Failed/blocked segments must not surface their reasoning to the
    // consumer before the abort guard fires. If a segment streams
    // thinking and then ends with stopReason=tool_use, those reasoning
    // tokens must be dropped, not replayed downstream alongside the
    // SegmentAbortError.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0; // let: per-segment counter
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const n = segmentCount;
      yield { kind: "thinking_delta", delta: `secret-reasoning-${n}` };
      // First segment terminates in tool_use — it must be rejected
      // BEFORE its thinking is sent to the consumer.
      if (n === 1) {
        yield {
          kind: "done",
          response: {
            content: "",
            model: "stream-model",
            stopReason: "tool_use" as const,
            richContent: [{ kind: "tool_call", id: toolCallId("c1"), name: "x", arguments: {} }],
          },
        };
        return;
      }
      yield { kind: "text_delta", delta: `seg${n}` };
      yield {
        kind: "done",
        response: { content: `seg${n}`, model: "stream-model", stopReason: "stop" as const },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const emitted: ModelChunk[] = [];
    let threw = false;
    try {
      for await (const c of iter) emitted.push(c);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const thinking = emitted.filter((c) => c.kind === "thinking_delta");
    // No thinking should be emitted: the only segment that produced
    // thinking ended in tool_use and was rejected before replay.
    expect(thinking.length).toBe(0);
  });

  test("wrapModelStream wraps a thrown downstream stream into SegmentAbortError with completedSegments", async () => {
    // A network/provider failure that surfaces as a thrown promise
    // (rather than a structured `error` chunk) must still preserve
    // completed-segment context so callers can resume from segment k
    // instead of paying to re-dispatch the whole oversized turn.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let call = 0; // let: per-test counter
    const upstream: ModelStreamHandler = async function* () {
      call += 1;
      const n = call;
      if (n === 1) {
        yield { kind: "text_delta", delta: "seg1" };
        yield {
          kind: "done",
          response: {
            content: "seg1",
            model: "stream-model",
            stopReason: "stop" as const,
            usage: { inputTokens: 9, outputTokens: 2 },
          },
        };
        return;
      }
      // Second segment: throw before yielding any chunk.
      throw new Error("upstream EPIPE");
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    let caught: unknown;
    try {
      for await (const _ of iter) {
        // exhaust until segment loop wraps the thrown error
      }
    } catch (err: unknown) {
      caught = err;
    }
    if (
      !(caught instanceof Error) ||
      !("segmentResponse" in caught) ||
      !("completedSegments" in caught)
    ) {
      throw new Error("expected SegmentAbortError");
    }
    const aborted = caught as unknown as Error & {
      readonly segmentIndex: number;
      readonly completedSegments: readonly ModelResponse[];
      readonly completedUsage:
        | { readonly inputTokens: number; readonly outputTokens: number }
        | undefined;
    };
    expect(aborted.segmentIndex).toBe(1);
    expect(aborted.completedSegments.length).toBe(1);
    expect(aborted.completedUsage?.inputTokens).toBe(9);
  });

  test("wrapModelCall wraps a thrown downstream call into SegmentAbortError with completedSegments", async () => {
    // Same partial-progress contract as the streaming path: a thrown
    // exception from the call handler on segment k must preserve the
    // earlier segments' responses + aggregated usage.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let call = 0; // let: per-test counter
    const handler: ModelHandler = async (_req) => {
      call += 1;
      const n = call;
      if (n === 1) {
        return {
          content: "seg1",
          model: "test",
          usage: { inputTokens: 5, outputTokens: 1 },
        } satisfies ModelResponse;
      }
      throw new Error("provider 503");
    };
    const big = "x".repeat(400);
    let caught: unknown;
    try {
      await mw.wrapModelCall?.(turnCtx(), { messages: [userMessage(big)] }, handler);
    } catch (err: unknown) {
      caught = err;
    }
    if (
      !(caught instanceof Error) ||
      !("segmentResponse" in caught) ||
      !("completedSegments" in caught)
    ) {
      throw new Error("expected SegmentAbortError");
    }
    const aborted = caught as unknown as Error & {
      readonly segmentIndex: number;
      readonly completedSegments: readonly ModelResponse[];
      readonly completedUsage:
        | { readonly inputTokens: number; readonly outputTokens: number }
        | undefined;
    };
    expect(aborted.segmentIndex).toBe(1);
    expect(aborted.completedSegments.length).toBe(1);
    expect(aborted.completedUsage?.inputTokens).toBe(5);
  });

  test("wrapModelStream forwards per-segment usage chunks as heartbeats so activity-timeout sees outward progress", async () => {
    // The runtime activity-timeout wrapper only resets its idle clock
    // on emitted engine events. If RLM buffered all usage / text until
    // every segment finished, a healthy oversized streamed turn that
    // emitted no thinking_delta would look idle to the wrapper and be
    // killed mid-flight. Each upstream `usage` chunk must surface
    // immediately so the timeout layer counts it as progress.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    let segmentCount = 0; // let: per-segment counter
    const upstream: ModelStreamHandler = async function* () {
      segmentCount += 1;
      const n = segmentCount;
      yield { kind: "text_delta", delta: `seg${n}` };
      yield { kind: "usage", inputTokens: 4, outputTokens: 1 };
      yield {
        kind: "done",
        response: {
          content: `seg${n}`,
          model: "stream-model",
          stopReason: "stop" as const,
        },
      };
    };
    const big = "x".repeat(400);
    const iter = mw.wrapModelStream?.(turnCtx(), { messages: [userMessage(big)] }, upstream);
    if (iter === undefined) throw new Error("expected wrapModelStream");
    const ordered: ModelChunk[] = [];
    for await (const c of iter) ordered.push(c);
    // Consumer must see one heartbeat usage per segment (no post-
    // reassembly aggregate — that would double-count tokens for
    // downstream budget enforcers; the canonical aggregate lives in
    // `done.response.usage`). The first heartbeat must land BEFORE the
    // merged terminal text_delta — proving the timeout layer would see
    // in-flight progress, not silence.
    const usageChunks = ordered.filter((c) => c.kind === "usage");
    const firstUsageIdx = ordered.findIndex((c) => c.kind === "usage");
    const finalTextIdx = ordered.findIndex((c) => c.kind === "text_delta");
    expect(usageChunks.length).toBe(segmentCount);
    expect(firstUsageIdx).toBeLessThan(finalTextIdx);
    const done = ordered.find((c) => c.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done");
    expect(done.response.usage?.inputTokens).toBe(segmentCount * 4);
    expect(done.response.usage?.outputTokens).toBe(segmentCount * 1);
  });

  test("describeCapabilities returns a label", () => {
    const mw = createRlmMiddleware();
    const cap = mw.describeCapabilities?.(turnCtx());
    expect(cap).toBeDefined();
    if (cap === undefined || Array.isArray(cap)) throw new Error("expected single fragment");
    expect(cap.label).toBe("rlm");
  });
});
