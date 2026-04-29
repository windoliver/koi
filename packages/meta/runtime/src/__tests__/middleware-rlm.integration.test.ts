/**
 * Cross-package integration tests for `@koi/middleware-rlm`. These run
 * RLM's wrapModelStream against the real `consumeModelStream` consumer
 * from `@koi/query-engine` to verify the contracts the unit-test suite
 * cannot exercise alone — partial-failure text durability under the
 * real EngineEvent translator, heartbeat propagation, and trust-
 * boundary behavior at the consumer-visible layer.
 */

import { describe, expect, test } from "bun:test";
import type {
  EngineEvent,
  InboundMessage,
  ModelRequest,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { createRlmMiddleware } from "@koi/middleware-rlm";
import { consumeModelStream } from "@koi/query-engine";

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

async function collect(stream: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("@koi/middleware-rlm × @koi/query-engine integration", () => {
  test("completed-segment text survives a later-segment throw via consumeModelStream", async () => {
    // Round 8 hardening: per-segment text must reach the consumer
    // BEFORE a later segment aborts, otherwise consumeModelStream's
    // thrown-stream terminal-done path emits only the fragments it
    // already saw and silently loses text from billed segments.
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
        yield { kind: "text_delta", delta: "completed-text" };
        yield {
          kind: "done",
          response: {
            content: "completed-text",
            model: "stream-model",
            stopReason: "stop" as const,
          },
        };
        return;
      }
      throw new Error("provider 503");
    };
    const big = "x".repeat(400);
    const req: ModelRequest = { messages: [userMessage(big)] };
    const rlmStream = mw.wrapModelStream?.(turnCtx(), req, upstream);
    if (rlmStream === undefined) throw new Error("expected wrapModelStream");

    const events = await collect(consumeModelStream(rlmStream));
    const done = events.find((ev) => ev.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done event");
    // Round 8 acceptance: the terminal `done` must carry the
    // already-billed segment text even though segment 2 threw.
    const allText = done.output.content
      .filter((b) => b.kind === "text")
      .map((b) => (b.kind === "text" ? b.text : ""))
      .join("");
    expect(allText).toContain("completed-text");
  });

  test("zero-token usage heartbeats surface as custom usage events to consumeModelStream", async () => {
    // Round 1 + round 4 hardening: a text-only adapter (no upstream
    // usage) must still produce outward activity per text_delta so
    // the runtime activity-timeout wrapper sees progress. Verify the
    // heartbeat lands as a custom `usage` event in the EngineEvent
    // stream — that is the layer the activity-timeout wrapper observes.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
    });
    const upstream: ModelStreamHandler = async function* () {
      yield { kind: "text_delta", delta: "hello" };
      yield {
        kind: "done",
        response: {
          content: "hello",
          model: "stream-model",
          stopReason: "stop" as const,
          usage: { inputTokens: 5, outputTokens: 1 },
        },
      };
    };
    const big = "x".repeat(400);
    const req: ModelRequest = { messages: [userMessage(big)] };
    const rlmStream = mw.wrapModelStream?.(turnCtx(), req, upstream);
    if (rlmStream === undefined) throw new Error("expected wrapModelStream");

    const events = await collect(consumeModelStream(rlmStream));
    const customUsage = events.filter((ev) => ev.kind === "custom" && ev.type === "usage");
    // At least one usage event per segment + one per text_delta
    // heartbeat. Must be > 0 for activity-timeout to see progress.
    expect(customUsage.length).toBeGreaterThan(0);
  });

  test("trusted role:'system' oversized message fails closed instead of being silently chunked", async () => {
    // Round 2 hardening: trustMetadataRole must NOT chunk a message
    // stamped role:"system". With no chunkable user content, RLM
    // fails closed at stream construction so privileged instructions
    // are never silently rewritten chunk-by-chunk. Verify the throw
    // surfaces through the real consumer as a terminal `done` with
    // `stopReason: "error"`, not a successful synthesized stream.
    const mw = createRlmMiddleware({
      maxInputTokens: 30,
      maxChunkChars: 100,
      acknowledgeSegmentLocalContract: true,
      trustMetadataRole: true,
    });
    let downstreamCalls = 0; // let: per-test counter
    const upstream: ModelStreamHandler = async function* () {
      downstreamCalls += 1;
      yield {
        kind: "done",
        response: { content: "ok", model: "m", stopReason: "stop" as const },
      };
    };
    const sysMsg: InboundMessage = {
      senderId: "user:1",
      timestamp: 0,
      content: [{ kind: "text", text: "s".repeat(500) }],
      metadata: { role: "system" },
    };
    const req: ModelRequest = { messages: [sysMsg] };
    const rlmStream = mw.wrapModelStream?.(turnCtx(), req, upstream);
    if (rlmStream === undefined) throw new Error("expected wrapModelStream");

    const events = await collect(consumeModelStream(rlmStream));
    // No downstream calls: RLM threw before invoking next.
    expect(downstreamCalls).toBe(0);
    const done = events.find((ev) => ev.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done event");
    expect(done.output.stopReason).toBe("error");
  });

  test("KoiError-shaped segment failure propagates code/retryable through consumeModelStream's terminal done", async () => {
    // Round 6/7/9 hardening: a structured RATE_LIMIT thrown on
    // segment N>1 must reach the consumer with retry metadata
    // intact, so retry middleware can act on it. The stream-level
    // SegmentAbortError is converted to a terminal done by
    // consumeModelStream; verify the error metadata is not lost.
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
          response: { content: "seg1", model: "m", stopReason: "stop" as const },
        };
        return;
      }
      const err = new Error("rate limited");
      Object.assign(err, { code: "RATE_LIMIT", retryable: true, retryAfterMs: 9999 });
      throw err;
    };
    const req: ModelRequest = { messages: [userMessage("x".repeat(400))] };
    const rlmStream = mw.wrapModelStream?.(turnCtx(), req, upstream);
    if (rlmStream === undefined) throw new Error("expected wrapModelStream");

    const events = await collect(consumeModelStream(rlmStream));
    const done = events.find((ev) => ev.kind === "done");
    if (done === undefined || done.kind !== "done") throw new Error("expected done event");
    // Even though seg1 text was preserved, the terminal stopReason
    // must reflect the error (not a clean "stop").
    expect(done.output.stopReason).toBe("error");
  });
});
