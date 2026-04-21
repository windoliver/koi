/**
 * Integration tests for #1638 activity-timeout end-to-end through
 * `createRuntime` — covers the full event envelope (custom telemetry,
 * synthesized tool_result / turn_end / done) on the runtime's outer
 * adapter, plus interaction with consumers that inspect terminal
 * metadata.
 *
 * Unit tests in `apply-activity-timeout.test.ts` cover the wrapper in
 * isolation; this suite verifies the wrapper stays wired correctly
 * after composition with middleware, stubs, filesystem backends, etc.
 */

import { describe, expect, test } from "bun:test";
import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";
import { toolCallId } from "@koi/core";
import { createRuntime } from "../create-runtime.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idleAfterAdapter(initial: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "integration-idle",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      for (const ev of initial) yield ev;
      await new Promise<void>((resolve) => {
        if (input.signal === undefined) return;
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

function isCustom(
  ev: EngineEvent,
  type: string,
): ev is EngineEvent & { readonly kind: "custom"; readonly type: string } {
  return ev.kind === "custom" && ev.type === type;
}

async function collect(
  iter: AsyncIterable<EngineEvent>,
  cap = 200,
): Promise<readonly EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (out.length >= cap) break;
  }
  return out;
}

describe("activity-timeout integration (runtime-level)", () => {
  test("idle timeout: emits full envelope — custom, turn_end(stopBlocked), done(interrupted)", async () => {
    const runtime = createRuntime({
      adapter: idleAfterAdapter([
        { kind: "turn_start", turnIndex: 0 },
        { kind: "text_delta", delta: "pondering" },
      ]),
      activityTimeout: { idleWarnMs: 20, idleTerminateMs: 60 },
    });

    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));

    expect(events.some((e) => isCustom(e, "activity.idle.warning"))).toBe(true);
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);

    const turnEnd = events.find(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnd?.stopBlocked).toBe(true);
    expect(turnEnd?.turnIndex).toBe(0);

    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.stopReason).toBe("interrupted");
    expect(done?.output.metadata?.terminatedBy).toBe("activity-timeout");
    expect(done?.output.metadata?.terminationReason).toBe("idle");
    expect(done?.output.metadata?.metricsSynthesized).toBe(true);
  });

  test("wall-clock timeout on a chatty but long stream", async () => {
    const chatty: EngineAdapter = {
      engineId: "chatty",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        for (let i = 0; i < 1000; i++) {
          if (input.signal?.aborted) return;
          await sleep(5);
          yield { kind: "text_delta", delta: "." };
        }
      },
    };

    const runtime = createRuntime({
      adapter: chatty,
      activityTimeout: { maxDurationMs: 80 },
    });

    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));
    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(true);

    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.metadata?.terminationReason).toBe("wall_clock");
  });

  test("silent post-tool_call_end gap is not classified as idle", async () => {
    const callId = toolCallId("slow-tool");
    const adapter: EngineAdapter = {
      engineId: "slow-tool",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 0 };
        yield { kind: "tool_call_start", toolName: "bash", callId };
        yield { kind: "tool_call_end", callId, result: { name: "bash", arguments: {} } };
        // Tool "executes" for well past idleTerminateMs:
        await sleep(200);
        yield { kind: "tool_result", callId, output: "done" };
        yield { kind: "turn_end", turnIndex: 0 };
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
          },
        };
      },
    };

    const runtime = createRuntime({
      adapter,
      activityTimeout: { idleWarnMs: 40, idleTerminateMs: 80 },
    });
    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));

    expect(events.some((e) => isCustom(e, "activity.idle.warning"))).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.stopReason).toBe("completed");
  });

  test("stall during tool-args streaming (pre-tool_call_end) triggers idle", async () => {
    const callId = toolCallId("stalled-args");
    const adapter: EngineAdapter = {
      engineId: "stalled-args",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "tool_call_start", toolName: "foo", callId };
        yield { kind: "tool_call_delta", callId, delta: '{"p' };
        // Stall with partial args — still the model's turn, not tool execution:
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const runtime = createRuntime({
      adapter,
      activityTimeout: { idleWarnMs: 20, idleTerminateMs: 50 },
    });
    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
  });

  test("non-cooperative adapter: finalization returns within bounded time", async () => {
    const bad: EngineAdapter = {
      engineId: "non-cooperative",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        while (true) {
          await sleep(5);
          yield { kind: "text_delta", delta: "." };
        }
      },
    };

    const runtime = createRuntime({
      adapter: bad,
      activityTimeout: { maxDurationMs: 40 },
    });
    const start = Date.now();
    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));
    const elapsed = Date.now() - start;

    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(true);
    // Wall-clock at ~40ms + bounded 2s pump-settle at most.
    expect(elapsed).toBeLessThan(3000);
  });

  test("legacy streamTimeoutMs still works via back-compat mapping", async () => {
    let receivedSignal: AbortSignal | undefined;
    let abortedAtInvocation: boolean | undefined;
    const spy: EngineAdapter = {
      engineId: "legacy-spy",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        receivedSignal = input.signal;
        abortedAtInvocation = input.signal?.aborted;
        yield {
          kind: "done",
          output: {
            content: [],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
          },
        };
      },
    };
    const runtime = createRuntime({ adapter: spy, streamTimeoutMs: 5000 });
    for await (const _ of runtime.adapter.stream({ kind: "text", text: "x" })) {
      break;
    }
    expect(receivedSignal).toBeDefined();
    expect(abortedAtInvocation).toBe(false);
  });

  test("maxDurationMs: Infinity disables wall-clock cap without firing early", async () => {
    const adapter: EngineAdapter = {
      engineId: "infinity",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "ok" };
        await sleep(50);
        yield {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "ok" }],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
          },
        };
      },
    };
    const runtime = createRuntime({
      adapter,
      activityTimeout: { maxDurationMs: Number.POSITIVE_INFINITY },
    });
    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));
    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(false);
    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.stopReason).toBe("completed");
  });

  test("config rejects idleTerminateMs without idleWarnMs", () => {
    expect(() =>
      createRuntime({
        adapter: idleAfterAdapter([]),
        activityTimeout: { idleTerminateMs: 60 },
      }),
    ).toThrow(/idleTerminateMs/);
  });

  test("lastSeenTurnIndex survives in terminal done.metadata", async () => {
    const adapter: EngineAdapter = {
      engineId: "turns",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 0 };
        yield { kind: "turn_end", turnIndex: 0 };
        yield { kind: "turn_start", turnIndex: 1 };
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const runtime = createRuntime({
      adapter,
      activityTimeout: { idleWarnMs: 20, idleTerminateMs: 50 },
    });
    const events = await collect(runtime.adapter.stream({ kind: "text", text: "x" }));
    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.metadata?.lastSeenTurnIndex).toBe(1);
    expect(done?.output.metrics.turns).toBe(0);
  });
});
