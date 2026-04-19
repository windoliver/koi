import { describe, expect, test } from "bun:test";
import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";
import { toolCallId } from "@koi/core";
import { applyActivityTimeout } from "./apply-activity-timeout.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adapter that emits text_delta every `intervalMs` for `count` times, then done. */
function activeAdapter(intervalMs: number, count: number): EngineAdapter {
  return {
    engineId: "active",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      for (let i = 0; i < count; i++) {
        if (input.signal?.aborted) return;
        await sleep(intervalMs);
        yield { kind: "text_delta", delta: `tick-${i}` };
      }
      yield {
        kind: "done",
        output: {
          content: [{ kind: "text", text: "active" }],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
        },
      };
    },
  };
}

/**
 * Adapter that emits `initialEvents`, then hangs forever (respects abort).
 * Used to simulate an idle stream.
 */
function idleAfterAdapter(initialEvents: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "idle",
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
      for (const ev of initialEvents) {
        yield ev;
      }
      // Hang until aborted
      await new Promise<void>((resolve) => {
        if (input.signal === undefined) return; // test should always supply a signal
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>, cap = 200): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const ev of iter) {
    out.push(ev);
    if (out.length >= cap) break;
  }
  return out;
}

function isCustom(
  ev: EngineEvent,
  type: string,
): ev is EngineEvent & { readonly kind: "custom"; readonly type: string } {
  return ev.kind === "custom" && ev.type === type;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyActivityTimeout", () => {
  test("passes through all events when no timeouts configured", async () => {
    const wrapped = applyActivityTimeout(activeAdapter(5, 3), {});
    const events = await collect(wrapped.stream({ kind: "text", text: "hi" }));

    expect(events.filter((e) => e.kind === "text_delta")).toHaveLength(3);
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("active stream survives past idle threshold — heartbeats reset timer", async () => {
    // Stream emits every 20ms for 8 ticks = 160ms total; idle threshold 80ms
    // If reset works, stream completes. If not, it would abort around 80ms.
    const wrapped = applyActivityTimeout(activeAdapter(20, 8), {
      idleWarnMs: 80,
      idleTerminateMs: 160,
    });
    const events = await collect(wrapped.stream({ kind: "text", text: "go" }));

    expect(events.filter((e) => e.kind === "text_delta")).toHaveLength(8);
    expect(events.some((e) => e.kind === "done")).toBe(true);
    expect(events.some((e) => isCustom(e, "activity.idle.warning"))).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
  });

  test("idle stream emits warning at threshold", async () => {
    let warned = false;
    const wrapped = applyActivityTimeout(
      idleAfterAdapter([{ kind: "text_delta", delta: "start" }]),
      {
        idleWarnMs: 30,
        idleTerminateMs: 120,
        onIdleWarn: () => {
          warned = true;
        },
      },
    );
    const events = await collect(wrapped.stream({ kind: "text", text: "idle" }), 10);

    const warning = events.find((e) => isCustom(e, "activity.idle.warning"));
    expect(warning).toBeDefined();
    expect(warned).toBe(true);
  });

  test("idle stream aborts at terminate threshold with activity.terminated.idle", async () => {
    let terminated: { reason: string; elapsedMs: number } | undefined;
    const wrapped = applyActivityTimeout(
      idleAfterAdapter([{ kind: "text_delta", delta: "start" }]),
      {
        idleWarnMs: 20,
        idleTerminateMs: 60,
        onTerminated: (reason, elapsedMs) => {
          terminated = { reason, elapsedMs };
        },
      },
    );
    const events = await collect(wrapped.stream({ kind: "text", text: "idle" }));

    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
    expect(terminated?.reason).toBe("idle");
    expect(terminated?.elapsedMs).toBeGreaterThanOrEqual(60);
  });

  test("terminate defaults to 2 × warn when not specified", async () => {
    const wrapped = applyActivityTimeout(idleAfterAdapter([{ kind: "text_delta", delta: "s" }]), {
      idleWarnMs: 25,
    });
    const start = Date.now();
    const events = await collect(wrapped.stream({ kind: "text", text: "idle" }));
    const elapsed = Date.now() - start;

    expect(events.some((e) => isCustom(e, "activity.idle.warning"))).toBe(true);
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
    // 2 × 25 = 50ms target; allow for scheduler jitter
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(400);
  });

  test("wall-clock bound terminates active stream", async () => {
    let terminated: { reason: string } | undefined;
    const wrapped = applyActivityTimeout(activeAdapter(10, 100), {
      maxDurationMs: 50,
      onTerminated: (reason) => {
        terminated = { reason };
      },
    });
    const start = Date.now();
    const events = await collect(wrapped.stream({ kind: "text", text: "long" }));
    const elapsed = Date.now() - start;

    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(true);
    expect(terminated?.reason).toBe("wall_clock");
    expect(elapsed).toBeLessThan(400);
  });

  test("user signal composes with internal timeout signal", async () => {
    let receivedSignal: AbortSignal | undefined;
    const inner: EngineAdapter = {
      engineId: "spy",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        receivedSignal = input.signal;
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

    const wrapped = applyActivityTimeout(inner, { idleWarnMs: 1000 });
    const caller = new AbortController();
    for await (const _ of wrapped.stream({ kind: "text", text: "x", signal: caller.signal })) {
      break;
    }

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(caller.signal);
  });

  test("user abort stops stream cleanly without timeout events", async () => {
    const wrapped = applyActivityTimeout(activeAdapter(10, 100), {
      idleWarnMs: 1000,
      maxDurationMs: 10_000,
    });
    const caller = new AbortController();
    const events: EngineEvent[] = [];

    const pending = (async () => {
      for await (const ev of wrapped.stream({
        kind: "text",
        text: "x",
        signal: caller.signal,
      })) {
        events.push(ev);
        if (events.length >= 2) caller.abort();
      }
    })();

    await pending;

    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(false);
  });

  test("progress events between warn and terminate cancel the termination", async () => {
    const firstEvent: EngineEvent = { kind: "text_delta", delta: "a" };
    const adapter: EngineAdapter = {
      engineId: "delayed",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield firstEvent;
        await sleep(60); // warn at 40ms but no terminate yet (2×40=80)
        yield { kind: "text_delta", delta: "b" }; // resets idle
        await sleep(20);
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

    const wrapped = applyActivityTimeout(adapter, { idleWarnMs: 40 });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    expect(out.some((e) => isCustom(e, "activity.idle.warning"))).toBe(true);
    expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    expect(out.some((e) => e.kind === "done")).toBe(true);
  });

  test("second idle stretch after recovery still fires warning + termination (re-arm regression)", async () => {
    let warnCount = 0;
    const adapter: EngineAdapter = {
      engineId: "resume-then-idle",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "a" };
        await sleep(60); // first warn fires (> idleWarnMs=25), before terminate (50ms)
        yield { kind: "text_delta", delta: "b" }; // recovery — resets warnFired
        // Hang until aborted — second idle stretch must be detected.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 25,
      idleTerminateMs: 60,
      onIdleWarn: () => {
        warnCount += 1;
      },
    });

    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    expect(warnCount).toBeGreaterThanOrEqual(2);
    expect(out.filter((e) => isCustom(e, "activity.idle.warning")).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
  });

  test("observer exceptions are caught and do not crash the stream", async () => {
    const originalError = console.error;
    const swallowed: unknown[] = [];
    console.error = (...args: unknown[]) => {
      swallowed.push(args);
    };
    try {
      const wrapped = applyActivityTimeout(
        idleAfterAdapter([{ kind: "text_delta", delta: "start" }]),
        {
          idleWarnMs: 20,
          idleTerminateMs: 50,
          onIdleWarn: () => {
            throw new Error("warn observer boom");
          },
          onTerminated: () => {
            throw new Error("terminated observer boom");
          },
        },
      );

      const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

      // Both telemetry events still emitted despite observer throws.
      expect(out.some((e) => isCustom(e, "activity.idle.warning"))).toBe(true);
      expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
      // Both observer throws were logged rather than propagated.
      expect(swallowed.length).toBeGreaterThanOrEqual(2);
    } finally {
      console.error = originalError;
    }
  });

  test("stall during tool-call argument streaming (before tool_call_end) still triggers idle", async () => {
    // tool_call_start fires as soon as the model names the tool, well before
    // execution. A stall between tool_call_start and tool_call_end is a real
    // stuck-model stall — it MUST NOT be masked by tool-activity suppression.
    const callId = toolCallId("streaming-stall");
    let terminated = false;
    const adapter: EngineAdapter = {
      engineId: "stalled-streaming",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "picking tool" };
        yield { kind: "tool_call_start", toolName: "foo", callId };
        // Model stalls forever (no tool_call_delta, no tool_call_end).
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 25,
      idleTerminateMs: 60,
      onTerminated: () => {
        terminated = true;
      },
    });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    expect(terminated).toBe(true);
    expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(true);
  });

  test("maxDurationMs: POSITIVE_INFINITY disables wall-clock backstop", async () => {
    let terminated = false;
    const wrapped = applyActivityTimeout(activeAdapter(10, 5), {
      maxDurationMs: Number.POSITIVE_INFINITY,
      onTerminated: () => {
        terminated = true;
      },
    });
    const events = await collect(wrapped.stream({ kind: "text", text: "x" }));

    expect(terminated).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(false);
    expect(events.at(-1)?.kind).toBe("done");
  });

  test("finalization does not hang on a non-cooperative adapter that ignores abort", async () => {
    // Adapter that ignores its signal and keeps yielding forever.
    const adapter: EngineAdapter = {
      engineId: "non-cooperative",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        while (true) {
          await sleep(5);
          yield { kind: "text_delta", delta: "." };
        }
      },
    };

    const wrapped = applyActivityTimeout(adapter, { maxDurationMs: 30 });
    const start = Date.now();
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));
    const elapsed = Date.now() - start;

    // Wall-clock aborts at ~30ms; generator finalization must return promptly
    // rather than blocking on the still-running pump.
    expect(out.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  test("long-running tool execution (silent gap between tool_call_end and tool_result) is not idle", async () => {
    const callId = toolCallId("long-running-tool");
    let terminated = false;
    const adapter: EngineAdapter = {
      engineId: "tool-gap",
      capabilities: { text: true, images: false, files: false, audio: false },
      // Event order matches the real engine flow: model streams the call first,
      // turn-runner closes with tool_call_end, THEN executes the tool (silent
      // gap), then emits tool_result once execution completes.
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "thinking" };
        yield { kind: "tool_call_start", toolName: "slow_tool", callId };
        yield { kind: "tool_call_delta", callId, delta: '{"arg":"x"}' };
        yield { kind: "tool_call_end", callId, result: { name: "slow_tool", arguments: {} } };
        // Tool executes here — no events for longer than idleWarnMs + idleTerminateMs.
        await sleep(150);
        yield { kind: "tool_result", callId, output: "ok" };
        yield {
          kind: "done",
          output: {
            content: [{ kind: "text", text: "fin" }],
            stopReason: "completed",
            metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 },
          },
        };
      },
    };

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 30,
      idleTerminateMs: 60,
      onTerminated: () => {
        terminated = true;
      },
    });
    const out = await collect(wrapped.stream({ kind: "text", text: "tool please" }));

    expect(terminated).toBe(false);
    expect(out.some((e) => isCustom(e, "activity.idle.warning"))).toBe(false);
    expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    expect(out.some((e) => e.kind === "done")).toBe(true);
  });
});
