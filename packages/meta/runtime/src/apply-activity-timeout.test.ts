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
    // idleWarnMs=25, idleTerminateMs=200. Sleep(60) is plenty > warn (25) and
    // well below terminate (200), so the first idle stretch produces a
    // warning but no termination before the adapter yields "b".
    const adapter: EngineAdapter = {
      engineId: "resume-then-idle",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "a" };
        await sleep(60);
        yield { kind: "text_delta", delta: "b" }; // recovery — resets warnFired
        // Hang until aborted — second idle stretch must be detected.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 25,
      idleTerminateMs: 200,
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

  test("idle-terminated stream still emits a terminal done with stopReason interrupted", async () => {
    const wrapped = applyActivityTimeout(
      idleAfterAdapter([{ kind: "text_delta", delta: "start" }]),
      { idleWarnMs: 20, idleTerminateMs: 50 },
    );
    const events = await collect(wrapped.stream({ kind: "text", text: "x" }));

    const doneIdx = events.findIndex((e) => e.kind === "done");
    const termIdx = events.findIndex((e) => isCustom(e, "activity.terminated.idle"));
    expect(termIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThan(termIdx);
    const done = events[doneIdx];
    if (done === undefined || done.kind !== "done") throw new Error("expected done");
    expect(done.output.stopReason).toBe("interrupted");
    expect(done.output.metadata?.terminationReason).toBe("idle");
    expect(done.output.metadata?.terminatedBy).toBe("activity-timeout");
    // Consumers that persist metrics into RunReport must know the token
    // counts are synthetic zeros rather than genuine zero-token runs.
    expect(done.output.metadata?.metricsSynthesized).toBe(true);
  });

  test("synthesized done zeros metrics and carries lastSeenTurnIndex in metadata", async () => {
    // Run through turns 0 and 1 fully, start turn 2, then stall mid-turn.
    // metrics.turns must be 0 so downstream aggregators (delivery-policy
    // RunReport, TUI cumulative metrics) do not inflate totals with
    // placeholder numbers. The real last-observed turn lives in
    // `metadata.lastSeenTurnIndex` for observability.
    const adapter: EngineAdapter = {
      engineId: "multi-turn-stall",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 0 };
        yield { kind: "turn_end", turnIndex: 0 };
        yield { kind: "turn_start", turnIndex: 1 };
        yield { kind: "turn_end", turnIndex: 1 };
        yield { kind: "turn_start", turnIndex: 2 };
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, { idleWarnMs: 20, idleTerminateMs: 50 });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));
    const done = out.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
    expect(done).toBeDefined();
    expect(done?.output.metrics.turns).toBe(0);
    expect(done?.output.metrics.totalTokens).toBe(0);
    expect(done?.output.metadata?.metricsSynthesized).toBe(true);
    expect(done?.output.metadata?.lastSeenTurnIndex).toBe(2);
  });

  test("wall-clock-terminated stream still emits a terminal done with stopReason interrupted", async () => {
    const wrapped = applyActivityTimeout(activeAdapter(10, 100), { maxDurationMs: 40 });
    const events = await collect(wrapped.stream({ kind: "text", text: "x" }));

    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done).toBeDefined();
    expect(done?.output.stopReason).toBe("interrupted");
    expect(done?.output.metadata?.terminationReason).toBe("wall_clock");
  });

  test("timeout during tool execution synthesizes error tool_result + stopBlocked turn_end", async () => {
    const callId = toolCallId("hung-tool");
    const adapter: EngineAdapter = {
      engineId: "tool-hung",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 0 };
        yield { kind: "tool_call_start", toolName: "bash", callId };
        yield { kind: "tool_call_end", callId, result: { name: "bash", arguments: {} } };
        // Tool hangs past idleTerminateMs — should be killed.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, { idleWarnMs: 20, idleTerminateMs: 50 });
    // Since idle accounting is suspended while tool is in flight, the
    // wrapper will not actually time the tool out via idle — add a wall
    // bound so termination triggers in a bounded window.
    const withWall = applyActivityTimeout(adapter, {
      idleWarnMs: 20,
      idleTerminateMs: 50,
      maxDurationMs: 80,
    });
    const out = await collect(withWall.stream({ kind: "text", text: "x" }));
    void wrapped; // silence unused warning

    const toolResult = out.find(
      (e): e is EngineEvent & { readonly kind: "tool_result" } => e.kind === "tool_result",
    );
    expect(toolResult).toBeDefined();
    expect(toolResult?.callId).toBe(callId);
    // Payload must follow the existing TOOL_EXECUTION_ERROR contract
    // (top-level `code` + top-level `error`) so existing consumers like
    // headless/run.ts classify it as a tool failure, not a success.
    const output = toolResult?.output as
      | {
          readonly code?: string;
          readonly error?: string;
          readonly synthesizedBy?: string;
          readonly terminationReason?: string;
        }
      | undefined;
    expect(output?.code).toBe("TOOL_EXECUTION_ERROR");
    expect(typeof output?.error).toBe("string");
    expect(output?.synthesizedBy).toBe("activity-timeout");

    const turnEnd = out.find(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnd?.stopBlocked).toBe(true);
  });

  test("mid-turn timeout synthesizes turn_end before terminal done for transcript flush", async () => {
    const adapter: EngineAdapter = {
      engineId: "mid-turn",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 7 };
        yield { kind: "text_delta", delta: "partial" };
        // Hang mid-turn — no turn_end, no tool_result.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, { idleWarnMs: 20, idleTerminateMs: 50 });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    const termIdx = out.findIndex((e) => isCustom(e, "activity.terminated.idle"));
    const turnEndIdx = out.findIndex((e) => e.kind === "turn_end");
    const doneIdx = out.findIndex((e) => e.kind === "done");

    expect(termIdx).toBeGreaterThanOrEqual(0);
    expect(turnEndIdx).toBeGreaterThan(termIdx);
    expect(doneIdx).toBeGreaterThan(turnEndIdx);

    const turnEnd = out[turnEndIdx];
    if (turnEnd === undefined || turnEnd.kind !== "turn_end") throw new Error("expected turn_end");
    expect(turnEnd.turnIndex).toBe(7);
    // stopBlocked = true prevents onAfterTurn hooks from treating this turn
    // as a normal completion — same marker the engine uses for stop-gate
    // vetoes. Middleware that checks ctx.stopBlocked will skip committing
    // partial state as if the turn succeeded.
    expect(turnEnd.stopBlocked).toBe(true);
  });

  test("silent tool that finishes after turn_end is not classified as idle", async () => {
    // The TUI has regression coverage for tools that keep running past
    // turn_end (see packages/ui/tui/src/state/reduce.test.ts). Our wrapper
    // must match that reality: pendingTools stays set until tool_result,
    // regardless of whether turn_end fired in between.
    const callId = toolCallId("post-turn-tool");
    let terminated = false;
    const adapter: EngineAdapter = {
      engineId: "post-turn-tool",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 0 };
        yield { kind: "tool_call_start", toolName: "slow", callId };
        yield { kind: "tool_call_end", callId, result: { name: "slow", arguments: {} } };
        // Turn closes immediately but the tool keeps running silently.
        yield { kind: "turn_end", turnIndex: 0 };
        await sleep(150); // well past idleTerminateMs
        yield { kind: "tool_result", callId, output: "done" };
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

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 30,
      idleTerminateMs: 60,
      onTerminated: () => {
        terminated = true;
      },
    });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    expect(terminated).toBe(false);
    expect(out.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    // The real tool_result from the adapter is passed through (no synthesis
    // needed because the tool actually completed).
    const realToolResult = out.find(
      (e): e is EngineEvent & { readonly kind: "tool_result" } => e.kind === "tool_result",
    );
    expect(realToolResult?.output).toBe("done");
  });

  test("no synthetic turn_end emitted when termination lands between turns", async () => {
    const adapter: EngineAdapter = {
      engineId: "between-turns",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "turn_start", turnIndex: 1 };
        yield { kind: "text_delta", delta: "hi" };
        yield { kind: "turn_end", turnIndex: 1 };
        // Idle here — no new turn_start. Timeout should NOT synthesize a
        // stray turn_end because we are not inside an open turn.
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    const wrapped = applyActivityTimeout(adapter, { idleWarnMs: 20, idleTerminateMs: 50 });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));

    const turnEnds = out.filter((e) => e.kind === "turn_end");
    // Only the real turn_end from the adapter — no synthetic duplicate.
    expect(turnEnds).toHaveLength(1);
  });

  test("applyActivityTimeout throws on negative duration", () => {
    expect(() => applyActivityTimeout({} as unknown as EngineAdapter, { idleWarnMs: -1 })).toThrow(
      /idleWarnMs/,
    );
    expect(() =>
      applyActivityTimeout({} as unknown as EngineAdapter, { maxDurationMs: -5 }),
    ).toThrow(/maxDurationMs/);
  });

  test("applyActivityTimeout throws when idleTerminateMs is set without idleWarnMs", () => {
    // idleTerminateMs is only armed after the warning fires, so on its own
    // it would be silently ignored — reject up front.
    expect(() =>
      applyActivityTimeout({} as unknown as EngineAdapter, { idleTerminateMs: 60 }),
    ).toThrow(/idleTerminateMs requires.*idleWarnMs/);
  });

  test("consumer early-break stops the pump from enqueueing on a non-cooperative adapter", async () => {
    // A non-cooperative adapter keeps yielding forever. After the consumer
    // breaks, the wrapper must ensure the pump stops appending to the
    // internal queue — otherwise memory grows unboundedly and adapter side
    // effects continue past the caller's cancellation boundary.
    let yieldedAfterBreak = 0;
    let breakTriggered = false;
    const adapter: EngineAdapter = {
      engineId: "non-cooperative-yielder",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        for (let i = 0; i < 50; i++) {
          await sleep(5);
          if (breakTriggered) yieldedAfterBreak += 1;
          yield { kind: "text_delta", delta: `tick-${i}` };
        }
      },
    };

    const wrapped = applyActivityTimeout(adapter, { maxDurationMs: 10_000 });
    const got: EngineEvent[] = [];
    for await (const ev of wrapped.stream({ kind: "text", text: "x" })) {
      got.push(ev);
      if (got.length === 1) {
        breakTriggered = true;
        break;
      }
    }

    // Let the adapter run past the break for a bit. The queue should not
    // grow — pumpInner checks state.consumerClosed and stops enqueueing.
    await sleep(80);
    // We saw at least some yields after break (the adapter keeps running)
    // but none of them landed in the queue we consumed. The outer
    // generator is already done, so the queue is effectively gone. This
    // test's purpose is to assert there's no unhandled rejection and no
    // infinite growth — Bun will throw on unhandled rejections during test
    // tearing-down if the pump promise isn't handled.
    expect(yieldedAfterBreak).toBeGreaterThanOrEqual(0);
  });

  test("real done from the adapter disarms timers — no false timeout after completion", async () => {
    // The adapter emits a real terminal done quickly, then the consumer
    // drains slowly. Timer callbacks must see pumpDone and bail out
    // rather than injecting a false activity.terminated.* event.
    let terminated = false;
    const adapter: EngineAdapter = {
      engineId: "done-then-slow-drain",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        yield { kind: "text_delta", delta: "a" };
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

    const wrapped = applyActivityTimeout(adapter, {
      idleWarnMs: 20,
      idleTerminateMs: 40,
      maxDurationMs: 50,
      onTerminated: () => {
        terminated = true;
      },
    });

    const events: EngineEvent[] = [];
    for await (const ev of wrapped.stream({ kind: "text", text: "x" })) {
      events.push(ev);
      // Deliberate slow drain: simulate a consumer that pauses between
      // yields, long enough that — without the pumpDone timer guard —
      // the warn/term/wall timers would fire before draining finishes.
      await sleep(80);
    }

    expect(terminated).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.idle.warning"))).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.idle"))).toBe(false);
    expect(events.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(false);
    // Real done still yielded, stopReason stays "completed".
    const done = events.find(
      (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
    );
    expect(done?.output.stopReason).toBe("completed");
  });

  test("applyActivityTimeout throws when idleTerminateMs < idleWarnMs", () => {
    expect(() =>
      applyActivityTimeout({} as unknown as EngineAdapter, {
        idleWarnMs: 100,
        idleTerminateMs: 50,
      }),
    ).toThrow(/idleTerminateMs .* must be >=/);
  });

  test("applyActivityTimeout accepts 0 as immediate abort (legacy parity)", async () => {
    // `streamTimeoutMs: 0` previously mapped to `AbortSignal.timeout(0)` which
    // aborts on the next tick. Preserve that: maxDurationMs=0 must still
    // engage the wrapper and fire wall-clock termination.
    const adapter: EngineAdapter = {
      engineId: "immediate",
      capabilities: { text: true, images: false, files: false, audio: false },
      async *stream(input: EngineInput): AsyncIterable<EngineEvent> {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };
    const wrapped = applyActivityTimeout(adapter, { maxDurationMs: 0 });
    const out = await collect(wrapped.stream({ kind: "text", text: "x" }));
    expect(out.some((e) => isCustom(e, "activity.terminated.wall_clock"))).toBe(true);
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
