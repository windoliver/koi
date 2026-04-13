import { describe, expect, mock, spyOn, test } from "bun:test";
import type {
  AgentManifest,
  ApprovalHandler,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelStreamHandler,
  StoreChangeEvent,
  Tool,
  ToolDescriptor,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import {
  brickId,
  DEFAULT_MAX_STOP_RETRIES,
  DEFAULT_UNSANDBOXED_POLICY,
  toolToken,
} from "@koi/core";
import { createKoi } from "./koi.js";
import type { ForgeRuntime } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

function mockAdapter(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "test-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (index >= events.length) {
                return { done: true, value: undefined };
              }
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// createKoi — assembly
// ---------------------------------------------------------------------------

describe("createKoi assembly", () => {
  test("creates a runtime with agent in created state", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent).toBeDefined();
    expect(runtime.agent.state).toBe("created");
  });

  test("agent has correct manifest", async () => {
    const manifest = testManifest({ name: "My Bot" });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.manifest.name).toBe("My Bot");
  });

  test("agent has correct pid name", async () => {
    const runtime = await createKoi({
      manifest: testManifest({ name: "Test Bot" }),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.name).toBe("Test Bot");
  });

  test("agent has depth 0", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.depth).toBe(0);
  });

  test("top-level agent defaults to copilot type", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.type).toBe("copilot");
  });

  test("manifest lifecycle overrides default type", async () => {
    const runtime = await createKoi({
      manifest: testManifest({ lifecycle: "worker" }),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.type).toBe("worker");
  });

  test("manifest lifecycle copilot on spawned child", async () => {
    const parentPid = {
      id: "parent-id" as import("@koi/core").AgentId,
      name: "parent",
      type: "copilot" as const,
      depth: 0,
    };
    const runtime = await createKoi({
      manifest: testManifest({ lifecycle: "copilot" }),
      adapter: mockAdapter([]),
      parentPid,
    });
    // Even though it has a parent, manifest lifecycle "copilot" takes precedence
    expect(runtime.agent.pid.type).toBe("copilot");
  });

  test("undefined lifecycle defaults to worker for child", async () => {
    const parentPid = {
      id: "parent-id" as import("@koi/core").AgentId,
      name: "parent",
      type: "copilot" as const,
      depth: 0,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
      parentPid,
    });
    // No lifecycle field + parent = worker (default inference)
    expect(runtime.agent.pid.type).toBe("worker");
  });

  test("assembles with component providers", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
      providers: [
        {
          name: "test-provider",
          attach: async () => new Map([["test:component", { value: 42 }]]),
        },
      ],
    });
    expect(runtime.agent.has("test:component" as never)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createKoi — run lifecycle
// ---------------------------------------------------------------------------

describe("createKoi run lifecycle", () => {
  test("transitions agent to running when run starts", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
    });

    expect(runtime.agent.state).toBe("created");

    // Start consuming events
    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();
    await iter.next(); // This triggers the start
    // Agent should now be running or terminated
    expect(["running", "terminated"]).toContain(runtime.agent.state);
  });

  test("transitions agent to terminated when done event received", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "text_delta", delta: "Hello" },
        { kind: "done", output: doneOutput() },
      ]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events.map((e) => e.kind)).toEqual(["turn_start", "text_delta", "done"]);
    expect(runtime.agent.state).toBe("terminated");
  });

  test("yields all events from adapter (plus turn_start)", async () => {
    const adapterEvents: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "Hello " },
      { kind: "text_delta", delta: "world" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "done", output: doneOutput() },
    ];

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter(adapterEvents),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // turn_start is injected by L1 before adapter events; second turn_start after turn_end
    expect(events.map((e) => e.kind)).toEqual([
      "turn_start",
      "text_delta",
      "text_delta",
      "turn_end",
      "turn_start",
      "done",
    ]);
  });

  test("handles empty event stream (still emits turn_start)", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // L1 emits turn_start, then adapter is exhausted → session ends
    expect(events.map((e) => e.kind)).toEqual(["turn_start"]);
    expect(runtime.agent.state).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// createKoi — dispose
// ---------------------------------------------------------------------------

describe("createKoi dispose", () => {
  test("calls adapter dispose", async () => {
    const dispose = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      ...mockAdapter([]),
      dispose,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("dispose is idempotent", async () => {
    const dispose = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      ...mockAdapter([]),
      dispose,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    await runtime.dispose();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("handles adapter without dispose", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });

    // Should not throw
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// createKoi — guard integration
// ---------------------------------------------------------------------------

describe("createKoi guard integration", () => {
  test("loop detection can be disabled", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });
    // Should create without error
    expect(runtime.agent).toBeDefined();
  });

  test("custom iteration limits are accepted", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      limits: { maxTurns: 5, maxDurationMs: 10_000, maxTokens: 1000 },
    });
    expect(runtime.agent).toBeDefined();
  });

  test("custom spawn policy is accepted", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      spawn: { maxDepth: 1, maxFanOut: 2, maxTotalProcesses: 5 },
    });
    expect(runtime.agent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createKoi — middleware hooks
// ---------------------------------------------------------------------------

describe("createKoi middleware hooks", () => {
  test("calls onSessionStart on user middleware", async () => {
    const onSessionStart = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onSessionStart }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  test("calls onSessionEnd on user middleware", async () => {
    // #1742: onSessionEnd fires at runtime.dispose, not at the end of run().
    const onSessionEnd = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onSessionEnd }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("#1742: cycleSession fires onSessionEnd then re-arms onSessionStart on next run", async () => {
    const sessionStart = mock(() => Promise.resolve());
    const sessionEnd = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [
        {
          name: "lifecycle-observer",
          describeCapabilities: () => undefined,
          onSessionStart: sessionStart,
          onSessionEnd: sessionEnd,
        },
      ],
    });

    // First run() fires onSessionStart once.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    expect(sessionStart).toHaveBeenCalledTimes(1);
    expect(sessionEnd).toHaveBeenCalledTimes(0);

    // cycleSession() fires onSessionEnd once.
    await runtime.cycleSession?.();
    expect(sessionEnd).toHaveBeenCalledTimes(1);
    expect(sessionStart).toHaveBeenCalledTimes(1); // not re-armed yet

    // Subsequent run() re-fires onSessionStart for the fresh session.
    await collectEvents(runtime.run({ kind: "text", text: "second" }));
    expect(sessionStart).toHaveBeenCalledTimes(2);
    expect(sessionEnd).toHaveBeenCalledTimes(1);

    // dispose() fires the final onSessionEnd for the second session.
    await runtime.dispose();
    expect(sessionEnd).toHaveBeenCalledTimes(2);
  });

  test("#1742: dispose waits for an in-flight run to settle before firing onSessionEnd", async () => {
    // dispose() must not race the streamEvents finally — otherwise it
    // can flush session-scoped middleware state or tear down the adapter
    // underneath an in-progress event. Same wait-for-settle pattern as
    // cycleSession.
    // let justified: mutable flag set by adapter generator's finally
    let adapterFinallyDone = false;
    // let justified: mutable flag confirming sessionEnd order
    let sessionEndFiredAfterAdapter = false;
    const adapter: EngineAdapter = {
      engineId: "abort-on-signal-dispose",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: (input) => ({
        async *[Symbol.asyncIterator]() {
          try {
            yield { kind: "text_delta" as const, delta: "x" };
            await new Promise<void>((resolve, reject) => {
              const signal = input.signal;
              if (signal === undefined) {
                resolve();
                return;
              }
              signal.addEventListener(
                "abort",
                () => {
                  const err = new Error("aborted");
                  err.name = "AbortError";
                  reject(err);
                },
                { once: true },
              );
            });
          } finally {
            adapterFinallyDone = true;
          }
        },
      }),
    };
    const sessionEndFn = mock(() => {
      sessionEndFiredAfterAdapter = adapterFinallyDone;
      return Promise.resolve();
    });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [
        { name: "lifecycle", describeCapabilities: () => undefined, onSessionEnd: sessionEndFn },
      ],
      loopDetection: false,
    });

    const controller = new AbortController();
    const drainPromise = (async () => {
      try {
        await collectEvents(runtime.run({ kind: "text", text: "hi", signal: controller.signal }));
      } catch {
        /* AbortError expected */
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // Issue dispose in parallel with abort. dispose must wait for the
    // run's finally to unwind before firing onSessionEnd.
    const disposePromise = runtime.dispose();
    controller.abort();
    await drainPromise;
    await disposePromise;

    expect(sessionEndFn).toHaveBeenCalledTimes(1);
    expect(sessionEndFiredAfterAdapter).toBe(true);
  });

  test("#1742: successful cycleSession does not leave a dangling poison timer", async () => {
    // Round 7 regression: `lifecycleSettleTimeout()` used to schedule a
    // setTimeout that flipped `poisoned = true` after 5s, with no way to
    // cancel it. Even on the happy path (run aborts, finally runs, race
    // resolves to "settled"), the timer kept ticking and would poison
    // the runtime ~5s after a successful /clear, breaking the next user
    // submit. Verify the timer is actually cancelled.
    const adapter: EngineAdapter = {
      engineId: "abort-on-signal-clean",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: (input) => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "x" };
          await new Promise<void>((resolve, reject) => {
            const signal = input.signal;
            if (signal === undefined) {
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
          });
        },
      }),
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    // Start a run and abort it cleanly so cycleSession resolves quickly.
    const controller = new AbortController();
    const drainPromise = (async () => {
      try {
        await collectEvents(runtime.run({ kind: "text", text: "hi", signal: controller.signal }));
      } catch {
        /* expected */
      }
    })();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const cyclePromise = runtime.cycleSession?.();
    controller.abort();
    await drainPromise;
    await cyclePromise;

    // Wait LONGER than the production lifecycle-settle timeout (5s) so a
    // dangling timer would have fired by now. Use 5500ms to be safe.
    await new Promise<void>((resolve) => setTimeout(resolve, 5500));

    // The runtime must NOT be poisoned — the timer was cancelled when
    // currentRunSettled won the race.
    expect(() => {
      // collectEvents is fine because the adapter would re-enter its
      // signal handling loop; we just want run() to NOT throw.
      const it = runtime.run({ kind: "text", text: "after-clear" })[Symbol.asyncIterator]();
      void it.return?.();
    }).not.toThrow();

    await runtime.dispose();
  }, 12_000);

  test("#1742: failing onSessionStart leaves session unstarted so retry can re-attempt the hook", async () => {
    // Round 9 regression: lifecycleSessionStarted was being set BEFORE
    // the hook awaited, so a throwing onSessionStart left the session
    // permanently latched as "started". The retry skipped onSessionStart
    // entirely, and dispose/cycleSession would later fire onSessionEnd
    // for a never-started session.
    // let justified: mutable counter for the throwing-then-succeeding hook
    let attempt = 0;
    const onSessionStart = mock(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("first attempt fails");
      }
      return Promise.resolve();
    });
    const onSessionEnd = mock(() => Promise.resolve());

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [
        {
          name: "flaky-start",
          describeCapabilities: () => undefined,
          onSessionStart,
          onSessionEnd,
        },
      ],
      loopDetection: false,
    });

    // First run: hook throws → run() rejects.
    await expect(collectEvents(runtime.run({ kind: "text", text: "first" }))).rejects.toThrow(
      /first attempt fails/,
    );
    expect(onSessionStart).toHaveBeenCalledTimes(1);

    // Retry: lifecycleSessionStarted MUST still be false so onSessionStart
    // gets a second attempt. Without the rollback, the retry would silently
    // skip onSessionStart and the session would never be initialized.
    await collectEvents(runtime.run({ kind: "text", text: "second" }));
    expect(onSessionStart).toHaveBeenCalledTimes(2);

    // dispose() fires onSessionEnd for the SUCCESSFUL session — and only
    // for that one. The failed first attempt must not have left a phantom
    // session for which onSessionEnd would also fire.
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("#1742: dispose/cycleSession do not falsely poison runtime when run() iterable is abandoned", async () => {
    // Round 9 regression: run() used to set `running = true` AND create
    // currentRunSettled synchronously, before the generator had a chance
    // to start. If a caller called run() but never iterated the result,
    // the generator's finally never fired — and a later dispose() /
    // cycleSession() spent the full settle timeout waiting for a run
    // that never started, then poisoned the runtime.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    // Create the iterable but never iterate it. This is a benign lazy
    // pattern — the consumer can choose not to start streaming.
    const _abandoned = runtime.run({ kind: "text", text: "abandoned" });
    void _abandoned; // explicitly unused

    // dispose() must complete promptly — not after waiting LIFECYCLE_SETTLE_TIMEOUT_MS.
    const start = Date.now();
    await runtime.dispose();
    const elapsed = Date.now() - start;
    // Generous bound: must NOT have waited the full 5s settle timeout.
    expect(elapsed).toBeLessThan(2000);
  }, 8_000);

  test("#1742: stale iterable iterated AFTER fresh run starts cannot release fresh run's latch", async () => {
    // Round 13 regression: the stale-iterable rejection path used to
    // unconditionally clear `running`. If a fresh run B had already
    // taken the latch, this would let a third concurrent run C through
    // the "Agent is already running" guard. Verify the latch is now
    // protected by `runningEpoch` ownership.
    const adapter: EngineAdapter = {
      engineId: "hangs-on-iter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "x" };
          // Hang here so run B stays in flight while we touch the
          // stale iterable.
          await new Promise<void>(() => {});
        },
      }),
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    // Create stale iterable A, then cycle (which clears A's latch
    // because A never iterated).
    const staleA = runtime.run({ kind: "text", text: "A" })[Symbol.asyncIterator]();
    await runtime.cycleSession?.();

    // Start fresh run B and pull its first event so it's actively
    // holding the latch.
    const iterB = runtime.run({ kind: "text", text: "B" })[Symbol.asyncIterator]();
    await iterB.next();

    // NOW iterate stale A. It must throw "discarded by cycleSession"
    // AND must NOT clear B's latch.
    await expect(staleA.next()).rejects.toThrow(/discarded by cycleSession/i);

    // A third concurrent run() must STILL be rejected because B is
    // running. The bug would have allowed it through.
    expect(() => {
      runtime.run({ kind: "text", text: "C" });
    }).toThrow(/already running/i);

    await iterB.return?.();
    await runtime.dispose();
  }, 8_000);

  test("#1742: run() rejects while cycleSession is in flight (lifecycle mutex)", async () => {
    // Round 13 regression: cycleSession is serialized via lifecycleInFlight
    // but run() didn't check it. A caller could slip a fresh run() into
    // the window after onSessionEnd fired but before the session was
    // re-armed, and attach to a half-torn-down session. run() must
    // reject loudly while a lifecycle transition is mid-flight.
    // Middleware's onSessionEnd hangs so cycleSession is suspended
    // long enough for us to race a run() against it.
    let releaseSessionEnd: (() => void) | undefined;
    const sessionEndPromise = new Promise<void>((resolve) => {
      releaseSessionEnd = resolve;
    });
    const onSessionEnd = mock(() => sessionEndPromise);
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "slow-end", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Kick off cycleSession; it will await sessionEndPromise inside
    // runSessionHooks, leaving lifecycleInFlight set.
    const cyclePromise = runtime.cycleSession?.();
    // Yield so cycleSession enters the IIFE and starts awaiting.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // run() during this window must throw — not silently attach to
    // the half-torn-down session.
    expect(() => {
      runtime.run({ kind: "text", text: "racing" });
    }).toThrow(/cycleSession\/dispose is in flight/i);

    // Release the slow hook so cycleSession can finish.
    releaseSessionEnd?.();
    await cyclePromise;

    // After cycleSession completes, run() works again.
    await collectEvents(runtime.run({ kind: "text", text: "after-cycle" }));
    await runtime.dispose();
  });

  test("#1742: cycleSession releases the running latch when the iterable was abandoned before iteration", async () => {
    // Round 11 regression: `run()` flips `running = true` synchronously
    // but cycleSession used to only clear it via the generator's finally,
    // which never runs for an abandoned iterable. Result: the supported
    // lazy pattern `const it = run(); await cycleSession();` left the
    // runtime rejecting every fresh `run()` with "Agent is already
    // running" until the abandoned iterable was touched. Verify the
    // runtime is reusable after cycleSession in this exact pattern.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    // Open a session by running once normally.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Create a second iterable but DO NOT iterate it.
    const _abandoned = runtime.run({ kind: "text", text: "abandoned" });
    void _abandoned;

    // cycleSession must release the running latch (and bump the session
    // epoch so the abandoned iterable is rejected if ever touched).
    await runtime.cycleSession?.();

    // A fresh run() must work — no "Agent is already running".
    const events = await collectEvents(runtime.run({ kind: "text", text: "fresh" }));
    expect(events.find((e) => e.kind === "done")).toBeDefined();

    await runtime.dispose();
  });

  test("#1742: dispose releases the running latch when the iterable was abandoned before iteration", async () => {
    // Round 11 regression mirror: same fix in dispose's skip-settle path.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });
    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    const _abandoned = runtime.run({ kind: "text", text: "abandoned" });
    void _abandoned;

    // dispose must complete promptly and not be blocked by the latched
    // running flag from the abandoned iterable.
    const start = Date.now();
    await runtime.dispose();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  }, 8_000);

  test("#1742: iterable created before cycleSession is rejected on first iteration (epoch guard)", async () => {
    // Round 10 regression: an async iterable created before /clear used
    // to silently re-fire onSessionStart on the new session and run
    // pre-clear input against freshly cleared state. Now the run binds
    // the current session epoch in run() and the generator validates
    // it on first iteration.
    const onSessionStart = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "lifecycle", describeCapabilities: () => undefined, onSessionStart }],
      loopDetection: false,
    });

    // Open a session by running a first turn.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    expect(onSessionStart).toHaveBeenCalledTimes(1);

    // Create an iterable for a second run BUT do not iterate it yet.
    const iter = runtime.run({ kind: "text", text: "stale" })[Symbol.asyncIterator]();

    // Cycle the session — this should rotate the epoch and reject the
    // iterable on its first iteration.
    await runtime.cycleSession?.();

    // First iteration of the stale iterable must throw with a clear
    // "discarded by cycleSession" error rather than attaching to the
    // new session.
    await expect(iter.next()).rejects.toThrow(/discarded by cycleSession/i);

    // The new (empty) session was NOT started by the stale iterable.
    expect(onSessionStart).toHaveBeenCalledTimes(1);

    // A fresh run() works normally on the new session.
    await collectEvents(runtime.run({ kind: "text", text: "fresh" }));
    expect(onSessionStart).toHaveBeenCalledTimes(2);

    await runtime.dispose();
  });

  test("#1742: iterable created before cycleSession is rejected even while teardown is mid-flight (epoch + in-flight guards)", async () => {
    // Loop-2 round 7 regression: even though the prior round bumped
    // sessionEpoch, the bump used to happen LATE in cycleSession's IIFE
    // (after onSessionEnd, governance reset, etc). A stale iterable
    // racing its first .next() against cycleSession's await window
    // could pass the (still-stale) epoch check and attach to a
    // half-torn-down session. Fixed by bumping sessionEpoch
    // synchronously at IIFE entry AND adding a lifecycleInFlight guard
    // in streamEvents.
    let releaseSessionEnd: (() => void) | undefined;
    const sessionEndPromise = new Promise<void>((resolve) => {
      releaseSessionEnd = resolve;
    });
    const onSessionEnd = mock(() => sessionEndPromise);
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "slow-end", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Create the stale iterable BEFORE cycleSession.
    const stale = runtime.run({ kind: "text", text: "stale" })[Symbol.asyncIterator]();

    // Kick off cycleSession; it suspends in onSessionEnd.
    const cyclePromise = runtime.cycleSession?.();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    // Now iterate the stale iterable WHILE cycleSession is still in
    // flight. It must throw — not silently attach to the half-torn-
    // down session.
    await expect(stale.next()).rejects.toThrow(
      /(in flight|discarded by cycleSession|Runtime has been disposed)/i,
    );

    releaseSessionEnd?.();
    await cyclePromise;

    // After cycleSession resolves, fresh run() works normally.
    await collectEvents(runtime.run({ kind: "text", text: "after" }));
    await runtime.dispose();
  }, 8_000);

  test("#1742: rebindSessionId rejects mid-session and accepts post-cycleSession (loop-3 round 6)", async () => {
    // Loop-3 round 6 regression: rebindSessionId must HARD REJECT
    // mid-session rebinds, otherwise session-scoped middleware would
    // attribute approvals/teardown to the wrong sessionId. Allowed
    // window is the quiescent post-cycleSession / pre-next-run state.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    // Pre-session (post-construction, no run yet): rebind must work.
    runtime.rebindSessionId?.("agent:test:before-first-run");
    expect(runtime.sessionId).toBe("agent:test:before-first-run");

    // First run starts the session.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Mid-session rebind must throw.
    expect(() => {
      runtime.rebindSessionId?.("agent:test:mid-session");
    }).toThrow(/mid-session/i);
    expect(runtime.sessionId).toBe("agent:test:before-first-run");

    // Cycle ends the session — now we're back in the quiescent window.
    await runtime.cycleSession?.();

    // Post-cycle, pre-next-run rebind must work.
    runtime.rebindSessionId?.("agent:test:after-cycle");
    expect(runtime.sessionId).toBe("agent:test:after-cycle");

    // Next run picks up the rebound id.
    await collectEvents(runtime.run({ kind: "text", text: "second" }));

    // Mid-session rebind must throw again on the new session.
    expect(() => {
      runtime.rebindSessionId?.("agent:test:mid-session-2");
    }).toThrow(/mid-session/i);

    await runtime.dispose();
  });

  test("#1742: dispose() is retryable after a settle-timeout failure (loop-3 round 2)", async () => {
    // Loop-3 round 2 regression: dispose() used to set `disposed = true`
    // at entry. On settle timeout it threw without running onSessionEnd
    // or adapter.dispose(), and every subsequent dispose() returned
    // immediately via the early-exit guard. The runtime was permanently
    // half-disposed even after the host killed the wedged tool. Now
    // disposed is only latched after the FULL cleanup sequence
    // succeeds, so a retry can complete the work.
    const onSessionEnd = mock(() => Promise.resolve());
    const adapterDispose = mock(() => Promise.resolve());
    // let: mutable resolver — host SIGKILLs the wedged tool by
    // calling this between the failing and retried dispose() calls.
    let unwedge: (() => void) | undefined;
    const wedgePromise = new Promise<IteratorResult<EngineEvent>>((resolve) => {
      unwedge = () => resolve({ value: undefined, done: true });
    });
    const adapter: EngineAdapter = {
      engineId: "wedge-then-recover",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => {
        return {
          [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            // let: mutable yielded flag
            let yielded = false;
            return {
              next(): Promise<IteratorResult<EngineEvent>> {
                if (!yielded) {
                  yielded = true;
                  return Promise.resolve({
                    value: { kind: "text_delta" as const, delta: "x" },
                    done: false,
                  });
                }
                // Subsequent .next() awaits the wedge promise. The host
                // resolves it (simulating SIGKILL) between the failing
                // and retried dispose calls.
                return wedgePromise;
              },
              return(): Promise<IteratorResult<EngineEvent>> {
                return wedgePromise;
              },
            };
          },
        };
      },
      dispose: adapterDispose,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "recover", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });

    // Start a run, pull one event, fire a wedged second .next().
    const iter = runtime.run({ kind: "text", text: "first" })[Symbol.asyncIterator]();
    await iter.next();
    void iter.next().catch(() => {});

    // First dispose() must throw TIMEOUT (wedged).
    await expect(runtime.dispose()).rejects.toThrow(/timed out|wedged/i);
    // Cleanup did NOT run yet — the host still has to kill the tool.
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    expect(adapterDispose).toHaveBeenCalledTimes(0);

    // Host "SIGKILLs" the wedged tool by unwedging the adapter.
    unwedge?.();

    // Retry dispose — must now complete cleanup.
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(adapterDispose).toHaveBeenCalledTimes(1);

    // Third dispose() is a no-op.
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(adapterDispose).toHaveBeenCalledTimes(1);
  }, 15_000);

  test("#1742: cycleSession fast-paths an iterable abandoned after first iteration (no false poison)", async () => {
    // Loop-3 round 1 regression: previously, calling .next() once and
    // then dropping the iterable left the generator suspended at
    // `yield` with `currentRunSettled` unresolved. The next
    // cycleSession() / dispose() would burn the full 5s settle
    // timeout and falsely poison the runtime — turning a normal host
    // bug (forgot to fully iterate) into permanent runtime rejection.
    // Fix tracks the active generator and calls .return() on it
    // during the wait, so an abandoned iterable's finally fires
    // immediately.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: {
        engineId: "abandon-after-first",
        capabilities: { text: true, images: false, files: false, audio: false },
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            // Yield several deltas; each yield suspends the generator
            // until the next .next() call.
            yield { kind: "text_delta" as const, delta: "hello " };
            yield { kind: "text_delta" as const, delta: "world" };
            // Done event the consumer will never reach because we
            // abandon after the first delta.
            yield {
              kind: "done" as const,
              output: doneOutput(),
            };
          },
        }),
      },
      loopDetection: false,
    });

    // Start a run, pull ONE event, then drop the iterator without
    // calling .return() or finishing the loop.
    const iter = runtime.run({ kind: "text", text: "abandon-after-first" })[Symbol.asyncIterator]();
    const firstEvent = await iter.next();
    expect(firstEvent.done).toBe(false);
    // (intentionally do NOT call iter.next() again or iter.return())

    // cycleSession must complete promptly — under the 5s settle
    // timeout — and must NOT poison the runtime.
    const start = Date.now();
    await runtime.cycleSession?.();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);

    // A fresh run() must succeed (no poisoned-runtime rejection).
    const events = await collectEvents(runtime.run({ kind: "text", text: "after-cycle" }));
    expect(events.find((e) => e.kind === "done")).toBeDefined();

    await runtime.dispose();
  }, 8_000);

  test("#1742: cycleSession fails closed and poisons the runtime when onSessionEnd throws", async () => {
    // Loop-2 round 9 regression: cycleSession used to swallow
    // onSessionEnd errors and continue into governance reset / sessionId
    // rotation / lifecycle re-arm. Middleware that performs cleanup
    // (token budget reset, hook registry drain, persistent flush) only
    // in awaited body code would have its cleanup skipped while
    // cycleSession reported success — stale state bleeds into the next
    // session. Now cycleSession poisons the runtime and re-throws so
    // the host can surface a fatal RESET_FAILED and force a recreate.
    const onSessionEnd = mock(() => Promise.reject(new Error("cleanup blew up")));
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "broken-end", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });

    // Open a session by running once normally.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // cycleSession must throw, not silently rotate.
    await expect(runtime.cycleSession?.()).rejects.toThrow(/cycleSession failed.*onSessionEnd/i);

    // Subsequent run() must be rejected because the runtime is poisoned.
    expect(() => {
      runtime.run({ kind: "text", text: "after-failed-cycle" });
    }).toThrow(/poisoned/i);

    // dispose still works (must always be safe to dispose).
    await runtime.dispose();
  });

  test("#1742: iterable created before dispose is rejected when iterated after dispose completes", async () => {
    // Loop-2 round 7 regression: dispose used to mark `disposed = true`
    // but never invalidated already-created iterables. A caller that
    // did `const it = runtime.run(...); await runtime.dispose();
    // await it.next();` would execute against a runtime whose adapter
    // and session hooks had already been torn down — undefined
    // behavior. Now streamEvents() refuses on first iteration if
    // `disposed === true`, and dispose() also bumps sessionEpoch for
    // belt-and-braces invalidation.
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });
    // Open a session so dispose's lifecycle path actually runs.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Create the iterable BEFORE dispose. Don't iterate it.
    const stale = runtime.run({ kind: "text", text: "stale" })[Symbol.asyncIterator]();

    // Dispose the runtime. (The abandoned-iterable skip-settle path
    // releases the running latch.)
    await runtime.dispose();

    // Iterating the stale iterable after dispose must throw, not run
    // against the torn-down adapter.
    await expect(stale.next()).rejects.toThrow(/disposed|discarded|in flight/i);
  }, 8_000);

  test("#1742: overlapping cycleSession() calls fire onSessionEnd exactly once (lifecycle mutex)", async () => {
    // Round 10 regression: two concurrent cycleSession() calls used to
    // both pass the !lifecycleSessionEnded guard and double-fire the
    // teardown hook. Verify the lifecycle mutex serializes them.
    const onSessionEnd = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "lifecycle", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Issue two cycleSession() calls in parallel. Both must resolve and
    // onSessionEnd must fire exactly once.
    await Promise.all([runtime.cycleSession?.(), runtime.cycleSession?.()]);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);

    await runtime.dispose();
  });

  test("#1742: cycleSession + dispose overlap fires onSessionEnd exactly once", async () => {
    const onSessionEnd = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "lifecycle", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });
    await collectEvents(runtime.run({ kind: "text", text: "first" }));

    // Issue cycleSession and dispose concurrently. Both must complete
    // and onSessionEnd must fire exactly once across both code paths.
    await Promise.all([runtime.cycleSession?.(), runtime.dispose()]);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("#1742: cycleSession rotates runtime.sessionId so per-session state is isolated", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    // Open a session by running once.
    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    const idBeforeCycle = runtime.sessionId;
    expect(typeof idBeforeCycle).toBe("string");
    expect(idBeforeCycle.length).toBeGreaterThan(0);

    // Cycle the session — host-driven /clear or session:new boundary.
    await runtime.cycleSession?.();

    // sessionId must rotate so checkpoint chains (chainId == sessionId)
    // and other session-keyed state can't bleed across the boundary.
    const idAfterCycle = runtime.sessionId;
    expect(idAfterCycle).not.toBe(idBeforeCycle);
    expect(typeof idAfterCycle).toBe("string");
    expect(idAfterCycle.length).toBeGreaterThan(0);
    await runtime.dispose();
  });

  test("#1742: cycleSession FAILS CLOSED on settle timeout — throws + poisons + skips cleanup", async () => {
    // Non-cooperative tool path: the adapter never honors the abort
    // signal, so the run's finally never fires and currentRunSettled
    // never resolves. cycleSession must:
    //   1. wait the bounded lifecycle-settle timeout (5s in production)
    //   2. throw TIMEOUT instead of running cleanup against the live run
    //   3. poison the runtime so future run() calls reject loudly
    //
    // Failing closed prevents middleware/adapter cleanup from racing a
    // late tool callback that could write into freshly-armed state.
    // Loop-3 round 1: cycleSession now calls .return() on the active
    // generator, which fast-paths most "abandoned/hung at await"
    // patterns. To still exercise the fail-closed timeout path we
    // need an adapter whose iterator's .return() ALSO hangs — that
    // means the engine's finally block (which awaits
    // adapterIterator.return()) blocks before currentRunResolveSettled
    // fires, so the lifecycle settle timer wins.
    const sessionEnd = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      engineId: "noncooperative",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => {
        const hang = new Promise<void>(() => {});
        return {
          [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
            // let: mutable — true after we yielded the one event
            let yielded = false;
            return {
              next(): Promise<IteratorResult<EngineEvent>> {
                if (!yielded) {
                  yielded = true;
                  return Promise.resolve({
                    value: { kind: "text_delta" as const, delta: "x" },
                    done: false,
                  });
                }
                // Subsequent .next() hangs forever.
                return hang as unknown as Promise<IteratorResult<EngineEvent>>;
              },
              // CRITICAL: .return() also hangs — simulates a non-
              // cooperative cleanup path where engine.finally cannot
              // unwind the adapter iterator.
              return(): Promise<IteratorResult<EngineEvent>> {
                return hang as unknown as Promise<IteratorResult<EngineEvent>>;
              },
            };
          },
        };
      },
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [
        { name: "lifecycle", describeCapabilities: () => undefined, onSessionEnd: sessionEnd },
      ],
      loopDetection: false,
    });

    // Spin up the run and START a second .next() that's now pending on
    // the adapter's hanging await. The generator is genuinely wedged
    // mid-iteration — NOT just suspended at a yield — so cycleSession's
    // round-1 .return() fast-path is queued (not immediately processed)
    // and the existing settle-timeout path still bounds the wait.
    const iter = runtime.run({ kind: "text", text: "hi" })[Symbol.asyncIterator]();
    await iter.next(); // pull the first event (delta)
    // Fire the second next() but don't await it — it'll hang forever
    // on the adapter's `await new Promise<void>(() => {})`.
    const pendingNext = iter.next();
    void pendingNext.catch(() => {
      // .return() during cycleSession will eventually surface as a
      // rejection here; ignore it.
    });

    // cycleSession should reject after ~5s (the production settle
    // timeout). Bound OUR wait at 7s so a regression visibly fails.
    const start = Date.now();
    // let justified: mutable error capture for later assertion
    let cycleErrorMessage: string | undefined;
    const cyclePromise = (async (): Promise<"rejected" | "fulfilled"> => {
      try {
        await runtime.cycleSession?.();
        return "fulfilled";
      } catch (e) {
        cycleErrorMessage = e instanceof Error ? e.message : String(e);
        return "rejected";
      }
    })();
    const watchdog = new Promise<"watchdog">((resolve) =>
      setTimeout(() => resolve("watchdog"), 7000),
    );
    const winner = await Promise.race([cyclePromise, watchdog]);
    expect(winner).toBe("rejected");
    expect(cycleErrorMessage).toMatch(/wedged|abort/i);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500);

    // onSessionEnd must NOT have fired — fail-closed means we did NOT
    // run cleanup against the still-live run.
    expect(sessionEnd).toHaveBeenCalledTimes(0);

    // Runtime is now POISONED — submitting another run must fail loudly.
    expect(() => {
      runtime.run({ kind: "text", text: "another" });
    }).toThrow(/poisoned/i);
  }, 10_000);

  test("#1742: cycleSession waits for an in-flight run to settle instead of throwing", async () => {
    // Hosts typically call cycleSession() right after aborting the active
    // run, while the run's finally block is still draining. cycleSession
    // must wait for the run to fully unwind (so onSessionEnd doesn't race
    // the in-progress per-run cleanup) instead of rejecting.
    const sessionEnd = mock(() => Promise.resolve());
    // Adapter whose stream throws AbortError when the signal aborts. We
    // arrange a delay so the abort happens AFTER cycleSession is queued
    // — that way cycleSession observes `running === true` and must wait.
    const adapter: EngineAdapter = {
      engineId: "abort-on-signal",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: (input) => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "x" };
          await new Promise<void>((resolve, reject) => {
            const signal = input.signal;
            if (signal === undefined) {
              resolve();
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                reject(err);
              },
              { once: true },
            );
          });
        },
      }),
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [
        { name: "lifecycle", describeCapabilities: () => undefined, onSessionEnd: sessionEnd },
      ],
      loopDetection: false,
    });

    // Drain the run on a background task so the generator stays "running"
    // until the abort propagates. We expect the drain to throw AbortError
    // when the signal fires.
    const controller = new AbortController();
    const drainPromise = (async () => {
      try {
        await collectEvents(runtime.run({ kind: "text", text: "hi", signal: controller.signal }));
      } catch {
        /* AbortError expected */
      }
    })();

    // Microtask-yield so the run's first event is emitted and `running`
    // is true; then queue cycleSession. It will block on currentRunSettled.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const cyclePromise = runtime.cycleSession?.();
    // Now abort — the adapter rejects, finally runs, currentRunSettled
    // resolves, cycleSession proceeds.
    controller.abort();
    await drainPromise;
    await cyclePromise;

    // onSessionEnd fired exactly once, after the run unwound.
    expect(sessionEnd).toHaveBeenCalledTimes(1);
    await runtime.dispose();
    // dispose fires onSessionEnd again for the new (post-cycle) session,
    // which was never opened (no second run), so the lifecycle flag is
    // false and dispose's onSessionEnd path skips. Total stays at 1.
    expect(sessionEnd).toHaveBeenCalledTimes(1);
  });

  test("calls onAfterTurn on turn_end events", async () => {
    const onAfterTurn = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "turn_end", turnIndex: 0 },
        { kind: "done", output: doneOutput() },
      ]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onAfterTurn }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onAfterTurn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — terminal injection (cooperating adapter)
// ---------------------------------------------------------------------------

/** Cooperating adapter: exposes terminals, captures input for assertions. */
function cooperatingAdapter(
  modelTerminal: ModelHandler,
  events: readonly EngineEvent[],
): EngineAdapter & { capturedInput?: EngineInput } {
  const result: EngineAdapter & { capturedInput?: EngineInput } = {
    engineId: "cooperating-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelTerminal,
    },
    stream: (input: EngineInput) => {
      result.capturedInput = input;
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
  return result;
}

describe("createKoi terminal injection", () => {
  test("adapter with terminals gets callHandlers in input", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapter(modelTerminal, [{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers).toBeDefined();
    expect(typeof adapter.capturedInput?.callHandlers?.modelCall).toBe("function");
    expect(typeof adapter.capturedInput?.callHandlers?.toolCall).toBe("function");
  });

  test("adapter without terminals works normally (no callHandlers)", async () => {
    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("turn_start");
    expect(events[1]?.kind).toBe("done");
  });

  test("default tool terminal finds and executes agent tools", async () => {
    const executeMock = mock(() => Promise.resolve("tool-result"));
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Create a cooperating adapter that uses callHandlers.toolCall
    const adapter: EngineAdapter = {
      engineId: "tool-test-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              // Use the composed tool handler to call our registered tool
              if (input.callHandlers) {
                await input.callHandlers.toolCall({
                  toolId: "calculator",
                  input: { a: 1 },
                });
              }
              yield {
                kind: "done" as const,
                output: doneOutput(),
              };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("calculator") as string,
                {
                  descriptor: {
                    name: "calculator",
                    description: "Calculate",
                    inputSchema: {},
                  },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  test("default tool terminal threads signal to tool.execute", async () => {
    // let justified: captured signal from inside the tool
    let capturedSignal: AbortSignal | undefined;
    const executeMock = mock((_args: unknown, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return Promise.resolve("tool-result");
    });
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "signal-thread-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                // Pass a request with signal — the engine should thread ctx.signal onto it
                await input.callHandlers.toolCall({
                  toolId: "sig-tool",
                  input: {},
                });
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      providers: [
        {
          name: "sig-tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("sig-tool") as string,
                {
                  descriptor: { name: "sig-tool", description: "Signal test", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    // The engine threads ctx.signal (the run's abort signal) to tool.execute
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// createKoi — duration fix
// ---------------------------------------------------------------------------

describe("createKoi duration fix", () => {
  test("duration is non-zero in error events", async () => {
    // Create adapter that throws a KoiRuntimeError
    const { KoiRuntimeError } = await import("@koi/errors");
    const adapter: EngineAdapter = {
      engineId: "slow-crash",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              // Small delay to ensure non-zero duration
              await new Promise((r) => setTimeout(r, 5));
              throw KoiRuntimeError.from("TIMEOUT", "max turns exceeded");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.durationMs).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — streaming terminal wiring
// ---------------------------------------------------------------------------

/** Helper: cooperating adapter with modelStream terminal. */
function streamingAdapter(
  modelTerminal: ModelHandler,
  modelStreamTerminal: ModelStreamHandler,
  events: readonly EngineEvent[],
): EngineAdapter & { capturedInput?: EngineInput } {
  const result: EngineAdapter & { capturedInput?: EngineInput } = {
    engineId: "streaming-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: modelTerminal,
      modelStream: modelStreamTerminal,
    },
    stream: (input: EngineInput) => {
      result.capturedInput = input;
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
  return result;
}

describe("createKoi streaming terminal wiring", () => {
  test("adapter with modelStream terminal gets callHandlers.modelStream", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const modelStreamTerminal: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "done" as const, response: { content: "ok", model: "test" } };
      },
    });
    const adapter = streamingAdapter(modelTerminal, modelStreamTerminal, [
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers?.modelStream).toBeDefined();
    expect(typeof adapter.capturedInput?.callHandlers?.modelStream).toBe("function");
  });

  test("adapter without modelStream terminal gets no callHandlers.modelStream", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapter(modelTerminal, [{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers?.modelStream).toBeUndefined();
  });

  test("adapter can consume callHandlers.modelStream to stream", async () => {
    const streamChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "done", response: { content: "Hello", model: "test" } },
    ];

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const modelStreamTerminal: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      },
    });

    // Adapter that uses callHandlers.modelStream
    const adapter: EngineAdapter = {
      engineId: "stream-consuming-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: modelTerminal,
        modelStream: modelStreamTerminal,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers?.modelStream) {
            const chunks: ModelChunk[] = [];
            for await (const chunk of input.callHandlers.modelStream({ messages: [] })) {
              chunks.push(chunk);
            }
            // Verify we got the expected chunks
            yield {
              kind: "text_delta" as const,
              delta: chunks.map((c) => (c.kind === "text_delta" ? c.delta : "")).join(""),
            };
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas).toHaveLength(1);
    if (textDeltas[0]?.kind === "text_delta") {
      expect(textDeltas[0].delta).toBe("Hello");
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — HITL approval handler wiring
// ---------------------------------------------------------------------------

describe("createKoi HITL approval handler", () => {
  /** Cooperating adapter that actually invokes callHandlers.modelCall, triggering middleware. */
  function cooperatingAdapterWithModelCall(rawModelCall: ModelHandler): EngineAdapter {
    return {
      engineId: "hitl-cooperating",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };
  }

  test("approvalHandler option injects requestApproval into TurnContext", async () => {
    const approvalHandler: ApprovalHandler = async () => ({ kind: "allow" });
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      describeCapabilities: () => undefined,
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapterWithModelCall(modelTerminal);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      approvalHandler,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.requestApproval).toBe(approvalHandler);
  });

  test("no approvalHandler means requestApproval is undefined in TurnContext", async () => {
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      describeCapabilities: () => undefined,
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapterWithModelCall(modelTerminal);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.requestApproval).toBeUndefined();
  });

  test("cooperating adapter middleware can use requestApproval to gate tool calls", async () => {
    const approvalHandler: ApprovalHandler = async (req) => {
      if (req.toolId === "dangerous-tool") {
        return { kind: "deny", reason: "tool is dangerous" };
      }
      return { kind: "allow" };
    };

    const toolResults: unknown[] = [];

    const mw: KoiMiddleware = {
      name: "hitl-gate",
      describeCapabilities: () => undefined,
      wrapToolCall: async (ctx, req, next) => {
        if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolId: req.toolId,
            input: req.input,
            reason: "tool requires approval",
          });
          if (decision.kind === "deny") {
            return { output: `Denied: ${decision.reason}` };
          }
        }
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Adapter that calls two tools — one safe, one dangerous
    const adapter: EngineAdapter = {
      engineId: "hitl-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const safeResult = await input.callHandlers.toolCall({
              toolId: "safe-tool",
              input: {},
            });
            toolResults.push(safeResult.output);

            const dangerousResult = await input.callHandlers.toolCall({
              toolId: "dangerous-tool",
              input: {},
            });
            toolResults.push(dangerousResult.output);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      approvalHandler,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () => {
            const { toolToken: tt } = await import("@koi/core");
            return new Map([
              [
                tt("safe-tool") as string,
                {
                  descriptor: { name: "safe-tool", description: "Safe", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "safe-result",
                },
              ],
              [
                tt("dangerous-tool") as string,
                {
                  descriptor: { name: "dangerous-tool", description: "Dangerous", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "dangerous-result",
                },
              ],
            ]);
          },
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toBe("safe-result");
    expect(toolResults[1]).toBe("Denied: tool is dangerous");
  });
});

// ---------------------------------------------------------------------------
// createKoi — tool-not-found error path
// ---------------------------------------------------------------------------

describe("createKoi tool not found", () => {
  test("default tool terminal throws NOT_FOUND for missing tool", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    let caughtError: unknown;
    const adapter: EngineAdapter = {
      engineId: "tool-not-found-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            try {
              await input.callHandlers.toolCall({
                toolId: "nonexistent",
                input: {},
              });
            } catch (e: unknown) {
              caughtError = e;
            }
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(caughtError).toBeInstanceOf(KoiRuntimeError);
    if (caughtError instanceof KoiRuntimeError) {
      expect(caughtError.code).toBe("NOT_FOUND");
      expect(caughtError.message).toContain("nonexistent");
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — early return (interrupt)
// ---------------------------------------------------------------------------

describe("createKoi early return", () => {
  test("breaking out of run() transitions agent to terminated:interrupted", async () => {
    // Adapter that yields infinite events
    const adapter: EngineAdapter = {
      engineId: "infinite-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          let i = 0;
          while (true) {
            yield { kind: "text_delta" as const, delta: `chunk${i++}` };
          }
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    let count = 0;
    for await (const _event of runtime.run({ kind: "text", text: "test" })) {
      count++;
      if (count >= 3) break;
    }

    expect(count).toBe(3);
    expect(runtime.agent.state).toBe("terminated");
  });

  test("onSessionEnd fires on dispose after early return", async () => {
    // #1742: onSessionEnd is a runtime-lifetime hook — fires at dispose,
    // not at the end of a single run(). Early-return from a run() still
    // leaves the runtime alive and reusable until dispose.
    const onSessionEnd = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      engineId: "infinite-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            yield { kind: "text_delta" as const, delta: "x" };
          }
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });

    let count = 0;
    for await (const _event of runtime.run({ kind: "text", text: "test" })) {
      count++;
      if (count >= 1) break;
    }

    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("adapter crash transitions agent to terminated; onSessionEnd fires on dispose", async () => {
    // #1742: adapter crashes still propagate as run()-level errors, but
    // onSessionEnd is no longer tied to per-run cleanup. The runtime stays
    // alive until the host calls dispose, which is where the hook fires.
    const onSessionEnd = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      engineId: "crash-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              throw new Error("unexpected crash");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "unexpected crash",
    );
    expect(runtime.agent.state).toBe("terminated");
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — live forge resolution
// ---------------------------------------------------------------------------

/** Helper: creates a mock ForgeRuntime with configurable behavior. */
function mockForgeRuntime(overrides?: Partial<ForgeRuntime>): ForgeRuntime {
  return {
    resolveTool: mock(() => Promise.resolve(undefined)),
    toolDescriptors: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

/** Helper: creates a minimal Tool with the given name and execute mock. */
function mockTool(
  name: string,
  executeFn: (input: unknown) => Promise<unknown> = async () => `${name}-result`,
): Tool {
  return {
    descriptor: { name, description: `Tool: ${name}`, inputSchema: {} },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: mock(executeFn),
  };
}

/** Helper: cooperating adapter that calls tools via callHandlers. */
function forgeTestAdapter(
  onStream: (input: EngineInput) => AsyncGenerator<EngineEvent>,
): EngineAdapter {
  const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
  return {
    engineId: "forge-test-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: { modelCall: modelTerminal },
    stream: (input: EngineInput) => ({
      [Symbol.asyncIterator]() {
        return onStream(input);
      },
    }),
  };
}

describe("createKoi live forge resolution", () => {
  test("forged tool resolves when entity lookup misses", async () => {
    const forgedTool = mockTool("forged-calc", async () => 42);
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "forged-calc" ? forgedTool : undefined,
      ),
      toolDescriptors: mock(async () => [forgedTool.descriptor]),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "forged-calc",
          input: { x: 1 },
        });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe(42);
  });

  test("forged tool takes precedence over entity tool with same name", async () => {
    const entityExecute = mock(() => Promise.resolve("entity-result"));
    const forgedTool = mockTool("calculator", async () => "forged-result");
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "calculator" ? forgedTool : undefined,
      ),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "calculator",
          input: {},
        });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("calculator") as string,
                {
                  descriptor: { name: "calculator", description: "Calc", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: entityExecute,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Forged tool should win (forge-first resolution)
    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe("forged-result");
    expect(entityExecute).not.toHaveBeenCalled();
  });

  test("NOT_FOUND when neither entity nor forge has the tool", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    const forge = mockForgeRuntime();

    let caughtError: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        try {
          await input.callHandlers.toolCall({ toolId: "nonexistent", input: {} });
        } catch (e: unknown) {
          caughtError = e;
        }
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(caughtError).toBeInstanceOf(KoiRuntimeError);
    if (caughtError instanceof KoiRuntimeError) {
      expect(caughtError.code).toBe("NOT_FOUND");
      expect(caughtError.message).toContain("nonexistent");
    }
  });

  test("callHandlers.tools includes forged descriptors", async () => {
    const forgedDescriptor: ToolDescriptor = {
      name: "forged-search",
      description: "Forged search tool",
      inputSchema: { type: "object" },
    };
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    const names = capturedTools?.map((t) => t.name);
    expect(names).toContain("forged-search");
  });

  test("callHandlers.tools merges entity and forged descriptors (forged first)", async () => {
    const forgedDescriptor: ToolDescriptor = {
      name: "forged-tool",
      description: "Forged",
      inputSchema: {},
    };
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-tool") as string,
                {
                  descriptor: { name: "entity-tool", description: "Entity", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    const names = capturedTools?.map((t) => t.name);
    expect(names).toContain("entity-tool");
    expect(names).toContain("forged-tool");
    // Forged descriptors come first
    expect(names?.[0]).toBe("forged-tool");
  });

  test("callHandlers.tools deduplicates by name (forged wins)", async () => {
    const forgedDescriptor: ToolDescriptor = {
      name: "shared-tool",
      description: "Forged version",
      inputSchema: {},
    };
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("shared-tool") as string,
                {
                  descriptor: {
                    name: "shared-tool",
                    description: "Entity version",
                    inputSchema: {},
                  },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    // Only one entry with name "shared-tool" (deduped)
    const matching = capturedTools?.filter((t) => t.name === "shared-tool");
    expect(matching).toHaveLength(1);
    // The forged description wins
    expect(matching?.[0]?.description).toBe("Forged version");
  });

  test("forged descriptors returns entity-only when forge has no descriptors", async () => {
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => []),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-tool") as string,
                {
                  descriptor: { name: "entity-tool", description: "Entity", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]?.name).toBe("entity-tool");
  });

  test("forged tool descriptors refresh at turn boundary", async () => {
    // Mutable counter — simulates new tools appearing after first refresh
    let descriptorCallCount = 0;
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => {
        descriptorCallCount++;
        if (descriptorCallCount <= 1) {
          return [{ name: "tool-v1", description: "V1", inputSchema: {} }];
        }
        return [
          { name: "tool-v1", description: "V1", inputSchema: {} },
          { name: "tool-v2", description: "V2", inputSchema: {} },
        ];
      }),
    });

    const toolSnapshots: Array<readonly ToolDescriptor[]> = [];
    const adapter: EngineAdapter = {
      engineId: "turn-boundary-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Snapshot tools before turn_end
          if (input.callHandlers) {
            toolSnapshots.push([...input.callHandlers.tools]);
          }
          yield { kind: "turn_end" as const, turnIndex: 0 };
          // Snapshot tools after turn_end (forge descriptors should be refreshed)
          if (input.callHandlers) {
            toolSnapshots.push([...input.callHandlers.tools]);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolSnapshots).toHaveLength(2);
    // Before turn_end: only tool-v1
    expect(toolSnapshots[0]?.map((t) => t.name)).toEqual(["tool-v1"]);
    // After turn_end: both tool-v1 and tool-v2
    expect(toolSnapshots[1]?.map((t) => t.name)).toEqual(["tool-v1", "tool-v2"]);
  });

  test("forged middleware re-composes at turn boundary", async () => {
    const callLog: string[] = [];

    // Forged middleware that logs calls
    const forgedMw: KoiMiddleware = {
      name: "forged-logger",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req, next) => {
        callLog.push(`forged-mw:${req.toolId}`);
        return next(req);
      },
    };

    // Mutable flag — enables forged middleware after turn boundary
    let middlewareEnabled = false;
    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors: mock(async () => []),
      middleware: mock(async () => (middlewareEnabled ? [forgedMw] : [])),
    };

    const forgedTool = mockTool("dynamic-tool");

    const adapter: EngineAdapter = {
      engineId: "forge-mw-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
        toolCall: async (req: ToolRequest) => {
          if (req.toolId === "dynamic-tool") {
            const output = await forgedTool.execute(req.input);
            return { output };
          }
          throw new Error(`Unexpected tool: ${req.toolId}`);
        },
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Call tool before turn boundary — no forged middleware yet
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "dynamic-tool",
              input: {},
            });
          }
          // Enable forged middleware before turn boundary
          middlewareEnabled = true;
          yield { kind: "turn_end" as const, turnIndex: 0 };

          // Call tool after turn boundary — forged middleware should now wrap it
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "dynamic-tool",
              input: {},
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // First call: no forged middleware, so callLog should be empty at that point
    // Second call: forged middleware active, so it should log
    expect(callLog).toEqual(["forged-mw:dynamic-tool"]);
  });

  test("no-forge path unchanged — callHandlers.tools contains only entity tools", async () => {
    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      // No forge option
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("my-tool") as string,
                {
                  descriptor: { name: "my-tool", description: "Mine", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]?.name).toBe("my-tool");
  });

  test("forged tool preserves metadata in response", async () => {
    const forgedTool = mockTool("meta-tool", async () => "meta-result");
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "meta-tool" ? forgedTool : undefined,
      ),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "meta-tool",
          input: {},
          metadata: { requestId: "abc-123" },
        });
        toolResult = res;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolResult).toEqual({
      output: "meta-result",
      metadata: { requestId: "abc-123" },
    });
  });

  test("forge.resolveTool IS called first, falls back to entity when forge returns undefined", async () => {
    const resolveTool = mock(async () => undefined);
    const forge = mockForgeRuntime({ resolveTool });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({ toolId: "entity-calc", input: {} });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-calc") as string,
                {
                  descriptor: { name: "entity-calc", description: "Calc", inputSchema: {} },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Forge-first: resolveTool is called first (returns undefined), entity fallback used
    expect(resolveTool).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe("ok");
  });

  test("forge.resolveTool error propagates to caller", async () => {
    const forgeError = new Error("Forge connection failed");
    const forge = mockForgeRuntime({
      resolveTool: mock(async () => {
        throw forgeError;
      }),
    });

    let caughtError: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        try {
          await input.callHandlers.toolCall({ toolId: "failing-tool", input: {} });
        } catch (e: unknown) {
          caughtError = e;
        }
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(caughtError).toBe(forgeError);
  });

  test("forge.toolDescriptors error propagates at session start", async () => {
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => {
        throw new Error("Descriptor fetch failed");
      }),
    });

    const adapter = forgeTestAdapter(async function* (_input) {
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "Descriptor fetch failed",
    );
  });

  test("forge has no effect when adapter lacks terminals", async () => {
    const resolveTool = mock(async () => mockTool("forged"));
    const toolDescriptors = mock(async () => [
      { name: "forged", description: "F", inputSchema: {} } as ToolDescriptor,
    ]);
    const forge = mockForgeRuntime({ resolveTool, toolDescriptors });

    let receivedCallHandlers = false;
    const adapter: EngineAdapter = {
      engineId: "non-cooperating",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          receivedCallHandlers = input.callHandlers !== undefined;
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(receivedCallHandlers).toBe(false);
    expect(resolveTool).not.toHaveBeenCalled();
    expect(toolDescriptors).not.toHaveBeenCalled();
  });

  test("multiple forged tool calls in same turn resolve independently", async () => {
    const tool1 = mockTool("tool-1", async () => "result-1");
    const tool2 = mockTool("tool-2", async () => "result-2");
    const resolveTool = mock(async (toolId: string) => {
      if (toolId === "tool-1") return tool1;
      if (toolId === "tool-2") return tool2;
      return undefined;
    });
    const forge = mockForgeRuntime({
      resolveTool,
      toolDescriptors: mock(async () => [tool1.descriptor, tool2.descriptor]),
    });

    const results: unknown[] = [];
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        results.push((await input.callHandlers.toolCall({ toolId: "tool-1", input: {} })).output);
        results.push((await input.callHandlers.toolCall({ toolId: "tool-2", input: {} })).output);
        results.push((await input.callHandlers.toolCall({ toolId: "tool-1", input: {} })).output);
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(results).toEqual(["result-1", "result-2", "result-1"]);
    expect(resolveTool).toHaveBeenCalledTimes(3);
    expect(tool1.execute).toHaveBeenCalledTimes(2);
    expect(tool2.execute).toHaveBeenCalledTimes(1);
  });

  test("middleware injected between turns takes effect on next turn (deferred refresh)", async () => {
    // Tracks which tool calls the middleware intercepted
    const intercepted: string[] = [];
    // Mutable middleware list — starts empty, populated between turns
    // let justified: mutable list updated mid-session to simulate forge injection
    let forgedMiddleware: readonly KoiMiddleware[] = [];

    const forge = mockForgeRuntime({
      middleware: mock(async () => forgedMiddleware),
    });

    const adapter = forgeTestAdapter(async function* (input) {
      if (!input.callHandlers) {
        yield { kind: "done" as const, output: doneOutput() };
        return;
      }

      // Turn 0: call tool (no forge middleware yet)
      await input.callHandlers.toolCall({ toolId: "echo", input: { msg: "turn0" } });
      yield { kind: "turn_end" as const, turnIndex: 0 };

      // Turn 1: call tool (forge middleware should be active now)
      await input.callHandlers.toolCall({ toolId: "echo", input: { msg: "turn1" } });
      yield { kind: "turn_end" as const, turnIndex: 1 };

      yield {
        kind: "done" as const,
        output: doneOutput({
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 2, durationMs: 0 },
        }),
      };
    });

    const echoTool: Tool = {
      descriptor: { name: "echo", description: "Echo tool", inputSchema: {} },
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: mock(async (input: unknown) => input),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tools",
          attach: async () => new Map([[toolToken("echo") as string, echoTool]]),
        },
      ],
    });

    // Consume events, injecting middleware after turn 0
    for await (const event of runtime.run({ kind: "text", text: "test" })) {
      if (event.kind === "turn_end" && event.turnIndex === 0) {
        // Inject middleware between turns — deferred refresh picks it up
        forgedMiddleware = [
          {
            name: "test-audit",
            describeCapabilities: () => undefined,
            wrapToolCall: async (_ctx, req, next) => {
              intercepted.push(req.toolId);
              return next(req);
            },
          },
        ];
      }
    }

    // Turn 0 tool call should NOT be intercepted (middleware not yet injected)
    // Turn 1 tool call SHOULD be intercepted (middleware injected after turn 0)
    expect(intercepted).toEqual(["echo"]);
    expect(echoTool.execute).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  test("tool injected between turns is discoverable in next turn descriptors", async () => {
    // Mutable descriptors list — starts empty
    // let justified: mutable list updated mid-session to simulate forge tool injection
    let forgedDescriptors: readonly ToolDescriptor[] = [];
    const forgedTool = mockTool("dynamic-tool");

    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => forgedDescriptors),
      resolveTool: mock(async (id: string) => (id === "dynamic-tool" ? forgedTool : undefined)),
    });

    const descriptorSnapshots: Array<readonly ToolDescriptor[]> = [];

    const adapter = forgeTestAdapter(async function* (input) {
      if (!input.callHandlers) {
        yield { kind: "done" as const, output: doneOutput() };
        return;
      }

      // Turn 0: capture descriptors (should NOT include dynamic-tool)
      descriptorSnapshots.push([...input.callHandlers.tools]);
      yield { kind: "turn_end" as const, turnIndex: 0 };

      // Turn 1: capture descriptors (should include dynamic-tool)
      descriptorSnapshots.push([...input.callHandlers.tools]);
      // Also resolve and call the dynamically added tool
      await input.callHandlers.toolCall({ toolId: "dynamic-tool", input: {} });
      yield { kind: "turn_end" as const, turnIndex: 1 };

      yield {
        kind: "done" as const,
        output: doneOutput({
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 2, durationMs: 0 },
        }),
      };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    for await (const event of runtime.run({ kind: "text", text: "test" })) {
      if (event.kind === "turn_end" && event.turnIndex === 0) {
        // Inject tool between turns
        forgedDescriptors = [forgedTool.descriptor];
      }
    }

    // Turn 0: no forged descriptors
    expect(descriptorSnapshots[0]?.find((d) => d.name === "dynamic-tool")).toBeUndefined();
    // Turn 1: forged descriptor present
    expect(descriptorSnapshots[1]?.find((d) => d.name === "dynamic-tool")).toBeDefined();
    // Tool was callable
    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });

  test("forge shadows entity tool end-to-end (shadow pattern)", async () => {
    // Entity provides "calculator" with entity-result
    const entityExecute = mock(() => Promise.resolve("entity-result"));
    // Forge provides "calculator" with forged-result
    const forgedTool = mockTool("calculator", async () => "forged-result");
    const forgedDescriptor: ToolDescriptor = {
      name: "calculator",
      description: "Forged calculator",
      inputSchema: {},
    };
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "calculator" ? forgedTool : undefined,
      ),
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let toolResult: unknown;
    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "calculator",
          input: {},
        });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("calculator") as string,
                {
                  descriptor: {
                    name: "calculator",
                    description: "Entity calculator",
                    inputSchema: {},
                  },
                  origin: "primordial",
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: entityExecute,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Forge wins tool call resolution
    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe("forged-result");
    expect(entityExecute).not.toHaveBeenCalled();

    // Descriptors deduplicated — only one "calculator", forged version
    const calcDescriptors = capturedTools?.filter((t) => t.name === "calculator");
    expect(calcDescriptors).toHaveLength(1);
    expect(calcDescriptors?.[0]?.description).toBe("Forged calculator");
  });
});

// ---------------------------------------------------------------------------
// createKoi — turn_start event emission
// ---------------------------------------------------------------------------

describe("createKoi turn_start emission", () => {
  test("turn_start is always first event", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "text_delta", delta: "Hello" },
        { kind: "done", output: doneOutput() },
      ]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events[0]?.kind).toBe("turn_start");
  });

  test("turn_start has correct turnIndex", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const turnStart = events[0];
    expect(turnStart?.kind).toBe("turn_start");
    if (turnStart?.kind === "turn_start") {
      expect(turnStart.turnIndex).toBe(0);
    }
  });

  test("empty adapter stream still gets turn_start", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("turn_start");
  });

  test("error stream: turn_start emitted before error", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    const adapter: EngineAdapter = {
      engineId: "crash-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              throw KoiRuntimeError.from("TIMEOUT", "max turns");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // #1742: guard errors (KoiRuntimeError) now emit a synthetic text_delta
    // explanation between turn_start and done so the user sees WHY the agent
    // stopped instead of an empty reply. Order: turn_start, text_delta, done.
    expect(events[0]?.kind).toBe("turn_start");
    expect(events[1]?.kind).toBe("text_delta");
    expect(events[2]?.kind).toBe("done");
  });

  test("multi-turn: turn_start for each turn", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "text_delta", delta: "t0" },
        { kind: "turn_end", turnIndex: 0 },
        { kind: "text_delta", delta: "t1" },
        { kind: "turn_end", turnIndex: 1 },
        { kind: "done", output: doneOutput() },
      ]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      "turn_start",
      "text_delta",
      "turn_end",
      "turn_start",
      "text_delta",
      "turn_end",
      "turn_start",
      "done",
    ]);

    // Verify turnIndex values
    const turnStarts = events.filter((e) => e.kind === "turn_start");
    if (turnStarts[0]?.kind === "turn_start") expect(turnStarts[0].turnIndex).toBe(0);
    if (turnStarts[1]?.kind === "turn_start") expect(turnStarts[1].turnIndex).toBe(1);
    if (turnStarts[2]?.kind === "turn_start") expect(turnStarts[2].turnIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// createKoi — onBeforeTurn hook wiring
// ---------------------------------------------------------------------------

describe("createKoi onBeforeTurn hooks", () => {
  test("calls onBeforeTurn before first turn", async () => {
    const onBeforeTurn = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onBeforeTurn }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onBeforeTurn).toHaveBeenCalledTimes(1);
  });

  test("calls onBeforeTurn for each turn", async () => {
    const onBeforeTurn = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "turn_end", turnIndex: 0 },
        { kind: "turn_end", turnIndex: 1 },
        { kind: "done", output: doneOutput() },
      ]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onBeforeTurn }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // 3 turns: initial + after each turn_end
    expect(onBeforeTurn).toHaveBeenCalledTimes(3);
  });

  test("onBeforeTurn receives sendStatus from options", async () => {
    const sendStatus = mock(() => Promise.resolve());
    let capturedCtx: TurnContext | undefined;

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [
        {
          name: "ctx-capture",
          describeCapabilities: () => undefined,
          onBeforeTurn: async (ctx) => {
            capturedCtx = ctx;
          },
        },
      ],
      sendStatus,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.sendStatus).toBe(sendStatus);
  });

  test("onBeforeTurn fires before turn_start event is yielded", async () => {
    const order: string[] = [];
    const onBeforeTurn = mock(async () => {
      order.push("hook");
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onBeforeTurn }],
    });

    for await (const event of runtime.run({ kind: "text", text: "test" })) {
      if (event.kind === "turn_start") {
        order.push("event");
      }
    }

    expect(order).toEqual(["hook", "event"]);
  });
});

// ---------------------------------------------------------------------------
// createKoi — sendStatus threading
// ---------------------------------------------------------------------------

describe("createKoi sendStatus threading", () => {
  test("sendStatus is threaded into cooperating adapter TurnContext", async () => {
    const sendStatus = mock(() => Promise.resolve());
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      describeCapabilities: () => undefined,
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter: EngineAdapter = {
      engineId: "status-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      sendStatus,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.sendStatus).toBe(sendStatus);
  });

  test("no sendStatus means TurnContext.sendStatus is undefined", async () => {
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      describeCapabilities: () => undefined,
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter: EngineAdapter = {
      engineId: "no-status-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.sendStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createKoi — concurrent run() guard (#12A)
// ---------------------------------------------------------------------------

describe("createKoi concurrent run guard", () => {
  test("second run() call throws while first is active", async () => {
    const adapter: EngineAdapter = {
      engineId: "slow-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => setTimeout(r, 50));
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    // Start first run (don't await)
    const iter = runtime.run({ kind: "text", text: "first" })[Symbol.asyncIterator]();
    const firstNext = iter.next(); // starts the generator

    // Second run should throw immediately
    try {
      runtime.run({ kind: "text", text: "second" });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const { KoiRuntimeError: KoiErr } = await import("@koi/errors");
      expect(e).toBeInstanceOf(KoiErr);
      if (e instanceof KoiErr) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("already running");
      }
    }

    // Complete first run
    await firstNext;
    await iter.next(); // drain
  });

  test("run() works again after first run completes", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    // Second run should work
    const events = await collectEvents(runtime.run({ kind: "text", text: "second" }));
    expect(events).toHaveLength(2); // turn_start + done
  });
});

// ---------------------------------------------------------------------------
// createKoi — onSessionEnd error preservation (#11A)
// ---------------------------------------------------------------------------

describe("createKoi onSessionEnd error preservation", () => {
  test("original run() error still propagates even if onSessionEnd would later throw", async () => {
    // #1742: onSessionEnd is runtime-lifetime, not per-run. The original
    // run() error must still propagate (no interference from the disposal
    // hook), and the runtime.dispose() call that later fires the crashing
    // hook must not re-raise it — the legacy contract is that onSessionEnd
    // crashes are swallowed/logged, not propagated.
    const onSessionEnd = mock(() => {
      throw new Error("onSessionEnd crash");
    });
    const adapter: EngineAdapter = {
      engineId: "crash-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              throw new Error("original error");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "test-mw", describeCapabilities: () => undefined, onSessionEnd }],
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "original error",
    );
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    // dispose must not throw even though the hook throws
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — priority-based middleware sorting (#4A)
// ---------------------------------------------------------------------------

describe("createKoi middleware priority sorting", () => {
  test("guards (priority 0-2) run before L2 middleware (100+)", async () => {
    const order: string[] = [];

    const trackingMw: KoiMiddleware = {
      name: "tracker",
      describeCapabilities: () => undefined,
      priority: 100,
      async wrapModelCall(_ctx, req, next) {
        order.push("tracker-enter");
        const resp = await next(req);
        order.push("tracker-exit");
        return resp;
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Adapter that triggers model call through callHandlers
    const adapter: EngineAdapter = {
      engineId: "priority-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [trackingMw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // Guard (iteration-guard, priority 0) wraps outside tracker (priority 100)
    expect(order).toContain("tracker-enter");
  });
});

// ---------------------------------------------------------------------------
// AbortSignal propagation (#79)
// ---------------------------------------------------------------------------

describe("AbortSignal propagation", () => {
  test("signal from EngineInput reaches TurnContext via onBeforeTurn", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const signalCapture: KoiMiddleware = {
      name: "signal-capture",
      describeCapabilities: () => undefined,
      async onBeforeTurn(ctx) {
        receivedSignal = ctx.signal;
      },
    };

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [signalCapture],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test", signal: controller.signal }));

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("aborting signal marks run as done", async () => {
    const controller = new AbortController();

    // Adapter that hangs until aborted
    const hangingAdapter: EngineAdapter = {
      engineId: "hanging",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              // Wait until aborted
              return new Promise((resolve) => {
                controller.signal.addEventListener(
                  "abort",
                  () => {
                    resolve({
                      done: false,
                      value: { kind: "done", output: doneOutput({ stopReason: "interrupted" }) },
                    });
                  },
                  { once: true },
                );
              });
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: hangingAdapter,
      loopDetection: false,
    });

    const iter = runtime.run({ kind: "text", text: "test", signal: controller.signal });
    const asyncIter = iter[Symbol.asyncIterator]();

    // First call gets turn_start
    const first = await asyncIter.next();
    expect(first.done).toBe(false);
    if (!first.done) {
      expect(first.value.kind).toBe("turn_start");
    }

    // Abort before the next call completes
    setTimeout(() => controller.abort(), 10);

    const second = await asyncIter.next();
    // After abort, the adapter returns a done event
    expect(second.done).toBe(false);
  });

  test("pre-aborted signal is handled gracefully", async () => {
    const controller = new AbortController();
    controller.abort();

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    // Pre-aborted signal should still allow the iterator to produce events
    const events = await collectEvents(
      runtime.run({ kind: "text", text: "test", signal: controller.signal }),
    );

    // Should get at least turn_start
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Canonical ID hierarchy (#80)
// ---------------------------------------------------------------------------

describe("Canonical ID hierarchy", () => {
  test("SessionContext contains branded sessionId and runId", async () => {
    let capturedSessionId: string | undefined;
    let capturedRunId: string | undefined;

    const idCapture: KoiMiddleware = {
      name: "id-capture",
      describeCapabilities: () => undefined,
      async onSessionStart(ctx) {
        capturedSessionId = ctx.sessionId;
        capturedRunId = ctx.runId;
      },
    };

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedSessionId).toBeDefined();
    expect(typeof capturedSessionId).toBe("string");
    expect(capturedRunId).toBeDefined();
    expect(typeof capturedRunId).toBe("string");
    // SessionId and RunId should be UUID-like
    expect(capturedSessionId?.length).toBeGreaterThan(0);
    expect(capturedRunId?.length).toBeGreaterThan(0);
  });

  test("TurnContext contains hierarchical turnId", async () => {
    let capturedTurnId: string | undefined;
    let capturedRunId: string | undefined;
    let capturedTurnIndex: number | undefined;

    const idCapture: KoiMiddleware = {
      name: "id-capture",
      describeCapabilities: () => undefined,
      async onSessionStart(ctx) {
        capturedRunId = ctx.runId;
      },
      async onBeforeTurn(ctx) {
        capturedTurnId = ctx.turnId;
        capturedTurnIndex = ctx.turnIndex;
      },
    };

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTurnId).toBeDefined();
    expect(capturedTurnIndex).toBe(0);
    // TurnId should follow hierarchical format: "${runId}:t${turnIndex}"
    expect(capturedTurnId).toBe(`${capturedRunId}:t0`);
  });

  test("multi-turn produces incrementing turnIds", async () => {
    const turnIds: string[] = [];
    let capturedRunId: string | undefined;

    const idCapture: KoiMiddleware = {
      name: "id-capture",
      describeCapabilities: () => undefined,
      async onSessionStart(ctx) {
        capturedRunId = ctx.runId;
      },
      async onBeforeTurn(ctx) {
        turnIds.push(ctx.turnId);
      },
    };

    const adapter = mockAdapter([
      { kind: "turn_end", turnIndex: 0 },
      { kind: "turn_end", turnIndex: 1 },
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(turnIds).toHaveLength(3);
    expect(turnIds[0]).toBe(`${capturedRunId}:t0`);
    expect(turnIds[1]).toBe(`${capturedRunId}:t1`);
    expect(turnIds[2]).toBe(`${capturedRunId}:t2`);
  });

  test("separate runs get distinct RunIds", async () => {
    const runIds: string[] = [];

    const idCapture: KoiMiddleware = {
      name: "id-capture",
      describeCapabilities: () => undefined,
      async onSessionStart(ctx) {
        runIds.push(ctx.runId);
      },
    };

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime1 = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });
    await collectEvents(runtime1.run({ kind: "text", text: "test1" }));

    const runtime2 = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });
    await collectEvents(runtime2.run({ kind: "text", text: "test2" }));

    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
  });

  test("SessionId encodes trust boundary with agent ownership", async () => {
    let capturedSessionId: string | undefined;
    let capturedAgentId: string | undefined;

    const idCapture: KoiMiddleware = {
      name: "id-capture",
      describeCapabilities: () => undefined,
      async onSessionStart(ctx) {
        capturedSessionId = ctx.sessionId;
        capturedAgentId = ctx.agentId;
      },
    };

    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [idCapture],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedSessionId).toBeDefined();
    expect(capturedAgentId).toBeDefined();
    // SessionId should follow trust-boundary format: "agent:{agentId}:{uuid}"
    expect(capturedSessionId).toContain(`agent:${capturedAgentId}:`);
    // Should still contain a UUID portion after the prefix
    const parts = capturedSessionId?.split(":") ?? [];
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe("agent");
    expect(parts[1]).toBe(capturedAgentId);
    expect(parts[2]?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// createKoi — forge watch subscription (hot-attach)
// ---------------------------------------------------------------------------

describe("createKoi forge watch", () => {
  test("forged tool descriptors update mid-session when forge.watch fires", async () => {
    const initialDescriptor: ToolDescriptor = {
      name: "initial-tool",
      description: "Initial",
      inputSchema: {},
    };
    const newDescriptor: ToolDescriptor = {
      name: "hot-attached-tool",
      description: "Hot attached",
      inputSchema: {},
    };

    // let justified: mutable state simulating forge store changes
    let currentDescriptors: readonly ToolDescriptor[] = [initialDescriptor];
    // let justified: watch listener ref for triggering mid-session
    let watchListener: ((event: StoreChangeEvent) => void) | undefined;

    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors: mock(async () => currentDescriptors),
      watch: (listener: (event: StoreChangeEvent) => void): (() => void) => {
        watchListener = listener;
        return () => {
          watchListener = undefined;
        };
      },
    };

    const descriptorSnapshots: Array<readonly ToolDescriptor[]> = [];

    const adapter: EngineAdapter = {
      engineId: "onchange-descriptor-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (!input.callHandlers) {
            yield { kind: "done" as const, output: doneOutput() };
            return;
          }

          // Snapshot 1: initial descriptors
          descriptorSnapshots.push([...input.callHandlers.tools]);

          // Simulate forge store change: add new tool + fire watch
          currentDescriptors = [initialDescriptor, newDescriptor];
          watchListener?.({ kind: "saved", brickId: brickId("hot-attached-tool") });

          // Wait for fire-and-forget descriptor refresh
          await new Promise((r) => setTimeout(r, 20));

          // Snapshot 2: after watch fired (should include new tool eagerly)
          descriptorSnapshots.push([...input.callHandlers.tools]);

          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Snapshot 1: only initial tool
    expect(descriptorSnapshots[0]?.map((t) => t.name)).toEqual(["initial-tool"]);
    // Snapshot 2: both tools (eager refresh via watch)
    const names = descriptorSnapshots[1]?.map((t) => t.name) ?? [];
    expect(names).toContain("initial-tool");
    expect(names).toContain("hot-attached-tool");
  });

  test("forged tool callable via callHandlers.toolCall after forge.watch", async () => {
    const hotTool = mockTool("hot-tool", async () => "hot-result");

    // let justified: mutable state simulating forge store changes
    let resolveHotTool = false;
    // let justified: watch listener ref
    let watchListener: ((event: StoreChangeEvent) => void) | undefined;

    const forge: ForgeRuntime = {
      resolveTool: mock(async (toolId: string) => {
        if (resolveHotTool && toolId === "hot-tool") return hotTool;
        return undefined;
      }),
      toolDescriptors: mock(async () => (resolveHotTool ? [hotTool.descriptor] : [])),
      watch: (listener: (event: StoreChangeEvent) => void): (() => void) => {
        watchListener = listener;
        return () => {
          watchListener = undefined;
        };
      },
    };

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (!input.callHandlers) {
        yield { kind: "done" as const, output: doneOutput() };
        return;
      }

      // Make the tool available and fire watch
      resolveHotTool = true;
      watchListener?.({ kind: "saved", brickId: brickId("hot-tool") });
      await new Promise((r) => setTimeout(r, 20));

      // Call the hot-attached tool
      const res = await input.callHandlers.toolCall({
        toolId: "hot-tool",
        input: {},
      });
      toolResult = res.output;

      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolResult).toBe("hot-result");
    expect(hotTool.execute).toHaveBeenCalledTimes(1);
  });

  test("subscription cleaned up on normal session completion", async () => {
    let unsubCalled = false;
    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors: mock(async () => []),
      watch: (_listener: (event: StoreChangeEvent) => void): (() => void) => {
        return () => {
          unsubCalled = true;
        };
      },
    };

    const adapter = forgeTestAdapter(async function* (_input) {
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(unsubCalled).toBe(true);
  });

  test("subscription cleaned up on abort", async () => {
    let unsubCalled = false;
    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors: mock(async () => []),
      watch: (_listener: (event: StoreChangeEvent) => void): (() => void) => {
        return () => {
          unsubCalled = true;
        };
      },
    };

    const controller = new AbortController();

    const adapter: EngineAdapter = {
      engineId: "abort-forge-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
      },
      stream: (_input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Yield something then get aborted
          yield { kind: "text_delta" as const, delta: "hello" };
          await new Promise((r) => setTimeout(r, 50));
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    let count = 0;
    for await (const _event of runtime.run({
      kind: "text",
      text: "test",
      signal: controller.signal,
    })) {
      count++;
      if (count >= 2) {
        controller.abort();
        break;
      }
    }

    expect(unsubCalled).toBe(true);
  });

  test("no error when forge.watch is undefined (backward compat)", async () => {
    // ForgeRuntime without watch — should work exactly as before
    const forge = mockForgeRuntime();
    expect(forge.watch).toBeUndefined();

    const adapter = forgeTestAdapter(async function* (_input) {
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    // Should not throw
    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(runtime.agent.state).toBe("terminated");
  });

  test("dirty flag skips unnecessary turn-boundary refresh when no changes", async () => {
    const toolDescriptors = mock(async () => []);
    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors,
      watch: (_listener: (event: StoreChangeEvent) => void): (() => void) => {
        return () => {};
      },
    };

    const adapter: EngineAdapter = {
      engineId: "dirty-flag-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
      },
      stream: (_input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          yield { kind: "turn_end" as const, turnIndex: 0 };
          yield { kind: "turn_end" as const, turnIndex: 1 };
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // toolDescriptors called once at session start (initial refreshForgeState),
    // but NOT again at turn boundaries because watch is active and dirty flag is false
    expect(toolDescriptors).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities runtime warning
// ---------------------------------------------------------------------------

describe("describeCapabilities runtime warning", () => {
  test("warns when middleware lacks describeCapabilities", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Use `as unknown as KoiMiddleware` to bypass TypeScript — simulates a JS consumer
      const badMiddleware = { name: "no-caps" } as unknown as KoiMiddleware;

      await createKoi({
        manifest: testManifest(),
        adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
        middleware: [badMiddleware],
        loopDetection: false,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("no-caps");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("describeCapabilities");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not warn when all middleware has describeCapabilities", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const goodMiddleware: KoiMiddleware = {
        name: "has-caps",
        describeCapabilities: () => undefined,
      };

      await createKoi({
        manifest: testManifest(),
        adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
        middleware: [goodMiddleware],
        loopDetection: false,
      });

      // No warnings about describeCapabilities should be emitted
      const capsWarnings = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === "string" && args[0].includes("describeCapabilities"),
      );
      expect(capsWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — error path coverage
// ---------------------------------------------------------------------------

describe("createKoi error paths", () => {
  test("onSessionStart hook throws → agent transitions to error, error propagates", async () => {
    const onSessionStart = mock(() => {
      throw new Error("session start failure");
    });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "fail-start", describeCapabilities: () => undefined, onSessionStart }],
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "session start failure",
    );
    expect(runtime.agent.state).toBe("terminated");
  });

  test("onBeforeTurn hook throws → error recovery produces done event", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    const onBeforeTurn = mock(() => {
      throw KoiRuntimeError.from("TIMEOUT", "max turns exceeded");
    });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "fail-turn", describeCapabilities: () => undefined, onBeforeTurn }],
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const doneEvt = events.find((e) => e.kind === "done");
    expect(doneEvt).toBeDefined();
    if (doneEvt?.kind === "done") {
      expect(doneEvt.output.stopReason).toBe("max_turns");
    }
    expect(runtime.agent.state).toBe("terminated");
  });

  test("guard error while run signal aborted → stopReason is interrupted, not error", async () => {
    const { KoiRuntimeError } = await import("@koi/errors");
    const abortController = new AbortController();
    const onBeforeTurn = mock(() => {
      // Simulate: signal aborts then guard throws (e.g., tool-execution middleware)
      abortController.abort("user_cancel");
      throw KoiRuntimeError.from("INTERNAL", "Tool interrupted: user_cancel");
    });
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "abort-guard", describeCapabilities: () => undefined, onBeforeTurn }],
      loopDetection: false,
    });

    const events = await collectEvents(
      runtime.run({ kind: "text", text: "test", signal: abortController.signal }),
    );
    const doneEvt = events.find((e) => e.kind === "done");
    expect(doneEvt).toBeDefined();
    if (doneEvt?.kind === "done") {
      expect(doneEvt.output.stopReason).toBe("interrupted");
    }
  });

  test("refreshForgeState throws at turn boundary → error propagates", async () => {
    // let justified: counter to allow first call to succeed
    let callCount = 0;
    const forge: import("./types.js").ForgeRuntime = {
      resolveTool: async () => undefined,
      toolDescriptors: async () => {
        callCount++;
        if (callCount > 1) {
          throw new Error("forge descriptor failure");
        }
        return [];
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter: EngineAdapter = {
      engineId: "forge-fail-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (_input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Turn 0: emit turn_end to trigger turn boundary refresh
          yield { kind: "turn_end" as const, turnIndex: 0 };
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "forge descriptor failure",
    );
    expect(runtime.agent.state).toBe("terminated");
  });

  test("abort during session initialization → clean shutdown", async () => {
    const abortController = new AbortController();
    const onSessionStart = mock(async () => {
      // Abort during the session start hook
      abortController.abort();
    });
    const onSessionEnd = mock(() => Promise.resolve());

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [
        {
          name: "abort-during-start",
          describeCapabilities: () => undefined,
          onSessionStart,
          onSessionEnd,
        },
      ],
      loopDetection: false,
    });

    const _events = await collectEvents(
      runtime.run({ kind: "text", text: "test", signal: abortController.signal }),
    );
    // Should produce no adapter events (aborted before adapter started)
    // May produce turn_start or nothing depending on timing
    expect(runtime.agent.state).toBe("terminated");
    // #1742: onSessionEnd is a runtime-lifetime hook, not per-run.
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("concurrent abort + return() → single cleanup", async () => {
    const abortController = new AbortController();
    const onSessionEnd = mock(() => Promise.resolve());

    // Adapter that yields infinite events
    const adapter: EngineAdapter = {
      engineId: "infinite-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          let i = 0;
          while (true) {
            yield { kind: "text_delta" as const, delta: `chunk${i++}` };
          }
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [
        {
          name: "cleanup-tracker",
          describeCapabilities: () => undefined,
          onSessionEnd,
        },
      ],
      loopDetection: false,
    });

    const iter = runtime
      .run({
        kind: "text",
        text: "test",
        signal: abortController.signal,
      })
      [Symbol.asyncIterator]();

    // Consume first event (turn_start)
    await iter.next();
    // Consume one adapter event
    await iter.next();

    // Abort and return simultaneously
    abortController.abort();
    await iter.return?.();

    expect(runtime.agent.state).toBe("terminated");
    // #1742: onSessionEnd fires once on dispose, not on run-level cleanup.
    expect(onSessionEnd).toHaveBeenCalledTimes(0);
    await runtime.dispose();
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// discovery:miss emission
// ---------------------------------------------------------------------------

describe("discovery:miss emission", () => {
  test("yields discovery:miss when tool not found", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "miss-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              // Try calling a tool that doesn't exist — catch the error
              if (input.callHandlers) {
                try {
                  await input.callHandlers.toolCall({
                    toolId: "nonexistent-tool",
                    input: {},
                  });
                } catch {
                  // Expected: NOT_FOUND
                }
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const missEvents = events.filter((e) => e.kind === "discovery:miss");
    expect(missEvents).toHaveLength(1);
  });

  test("discovery:miss event has correct resolverSource (entity)", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "miss-source-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                try {
                  await input.callHandlers.toolCall({ toolId: "missing", input: {} });
                } catch {
                  // expected
                }
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const miss = events.find((e) => e.kind === "discovery:miss");
    expect(miss).toBeDefined();
    if (miss?.kind === "discovery:miss") {
      expect(miss.resolverSource).toBe("entity");
      expect(typeof miss.timestamp).toBe("number");
    }
  });

  test("discovery:miss includes forge+entity source when forge provided", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const forgeRuntime: ForgeRuntime = {
      resolveTool: async () => undefined,
      toolDescriptors: async () => [],
    };

    const adapter: EngineAdapter = {
      engineId: "forge-miss-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                try {
                  await input.callHandlers.toolCall({ toolId: "missing-forge", input: {} });
                } catch {
                  // expected
                }
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge: forgeRuntime,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const miss = events.find((e) => e.kind === "discovery:miss");
    expect(miss).toBeDefined();
    if (miss?.kind === "discovery:miss") {
      expect(miss.resolverSource).toBe("forge+entity");
    }
  });

  test("tool-not-found error still propagates after discovery:miss", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    // let justified: mutable flag to verify error was thrown
    let errorCaught = false;

    const adapter: EngineAdapter = {
      engineId: "propagate-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                try {
                  await input.callHandlers.toolCall({ toolId: "nope", input: {} });
                } catch {
                  errorCaught = true;
                }
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(errorCaught).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase ordering integration
// ---------------------------------------------------------------------------

describe("createKoi middleware phase ordering", () => {
  test("intercept middleware runs before observe regardless of priority", async () => {
    const order: string[] = [];

    // Middleware A: observe phase, low priority (would run first in priority-only sort)
    const observeMw: KoiMiddleware = {
      name: "observe-mw",
      phase: "observe",
      priority: 100,
      describeCapabilities: () => ({ label: "obs", description: "obs" }),
      wrapModelCall: async (_ctx, req, next) => {
        order.push("observe");
        return next(req);
      },
    };

    // Middleware B: intercept phase, high priority number
    const interceptMw: KoiMiddleware = {
      name: "intercept-mw",
      phase: "intercept",
      priority: 900,
      describeCapabilities: () => ({ label: "int", description: "int" }),
      wrapModelCall: async (_ctx, req, next) => {
        order.push("intercept");
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Adapter that calls modelCall via callHandlers
    const adapter: EngineAdapter = {
      engineId: "phase-test",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Call model via callHandlers to trigger middleware chain
          if (input.callHandlers?.modelCall !== undefined) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      // Pass observe first, intercept second — sort should fix ordering
      middleware: [observeMw, interceptMw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Intercept should execute before observe (outer onion = runs first)
    expect(order).toEqual(["intercept", "observe"]);
  });
});

// ---------------------------------------------------------------------------
// Forged middleware scope integration
// ---------------------------------------------------------------------------

describe("createKoi forged middleware scope", () => {
  test("forged middleware wrapModelCall participates but lifecycle hooks do not", async () => {
    const forgedWrapped: string[] = [];
    const forgedLifecycle: string[] = [];

    const forgedMw: KoiMiddleware = {
      name: "forged-test",
      describeCapabilities: () => ({ label: "forged-cap", description: "should not appear" }),
      wrapModelCall: async (_ctx, req, next) => {
        forgedWrapped.push("wrapModelCall");
        return next(req);
      },
      onBeforeTurn: async () => {
        forgedLifecycle.push("onBeforeTurn");
      },
      onAfterTurn: async () => {
        forgedLifecycle.push("onAfterTurn");
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // let: mutable captured messages for assertion
    const _capturedMessages: readonly unknown[] = [];

    const adapter: EngineAdapter = {
      engineId: "forge-scope-test",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers?.modelCall !== undefined) {
            const req = { messages: [] };
            // The request gets prepared with capabilities inside callHandlers
            await input.callHandlers.modelCall(req);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const forge: ForgeRuntime = {
      resolveTool: async () => undefined,
      toolDescriptors: async () => [],
      middleware: async () => [forgedMw],
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // forged middleware's wrapModelCall WAS called
    expect(forgedWrapped).toEqual(["wrapModelCall"]);

    // forged middleware's lifecycle hooks were NOT called
    // (lifecycle hooks only run on static allMiddleware, not forged)
    expect(forgedLifecycle).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stop gate
// ---------------------------------------------------------------------------

function multiCallAdapter(
  calls: readonly (readonly EngineEvent[])[],
  options?: { readonly inject?: boolean },
): {
  readonly adapter: EngineAdapter;
  readonly streamCalls: EngineInput[];
  readonly injectedMessages: InboundMessage[];
} {
  const streamCalls: EngineInput[] = [];
  const injectedMessages: InboundMessage[] = [];
  // let justified: mutable call counter for multi-stream sequencing
  let callIndex = 0;

  const adapter: EngineAdapter = {
    engineId: "multi-call-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      streamCalls.push(input);
      const events = calls[callIndex] ?? [];
      callIndex++;
      // let justified: mutable index for async iteration
      let eventIndex = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (eventIndex >= events.length) return { done: true, value: undefined };
              const event = events[eventIndex];
              if (event === undefined) return { done: true, value: undefined };
              eventIndex++;
              return { done: false, value: event };
            },
            async return(): Promise<IteratorResult<EngineEvent>> {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
    ...(options?.inject !== false
      ? {
          inject(message: InboundMessage): void {
            injectedMessages.push(message);
          },
        }
      : {}),
  };

  return { adapter, streamCalls, injectedMessages };
}

function blockingStopMiddleware(blockUntilCall: number): {
  readonly middleware: KoiMiddleware;
  readonly onAfterTurnCalls: Array<{ readonly turnIndex: number; readonly stopBlocked: boolean }>;
} {
  // let justified: mutable call counter for blocking logic
  let callCount = 0;
  const onAfterTurnCalls: Array<{ readonly turnIndex: number; readonly stopBlocked: boolean }> = [];

  const middleware: KoiMiddleware = {
    name: "stop-blocker",
    describeCapabilities: () => undefined,
    onBeforeStop: async () => {
      callCount++;
      if (callCount <= blockUntilCall) {
        return { kind: "block", reason: `blocked attempt ${callCount}`, blockedBy: "stop-blocker" };
      }
      return { kind: "continue" };
    },
    onAfterTurn: async (ctx: TurnContext) => {
      onAfterTurnCalls.push({
        turnIndex: ctx.turnIndex,
        stopBlocked: ctx.stopBlocked === true,
      });
    },
  };

  return { middleware, onAfterTurnCalls };
}

describe("createKoi stop gate", () => {
  test("block emits turn_end for blocked turn then turn_start for retry", async () => {
    const { middleware } = blockingStopMiddleware(1);
    const { adapter, streamCalls, injectedMessages } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: true },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [middleware],
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    const kinds = events.map((e) => e.kind);

    // Expected: turn_start(0) → turn_end(0, stopBlocked) → turn_start(1) → done
    expect(kinds).toEqual(["turn_start", "turn_end", "turn_start", "done"]);

    const [turnStart0, turnEnd0, turnStart1, doneEvent] = events;
    if (!turnStart0 || !turnEnd0 || !turnStart1 || !doneEvent) {
      throw new Error("unexpected event count");
    }
    expect(turnStart0.kind === "turn_start" && turnStart0.turnIndex).toBe(0);
    expect(turnEnd0.kind === "turn_end" && turnEnd0.turnIndex).toBe(0);
    expect(turnStart1.kind === "turn_start" && turnStart1.turnIndex).toBe(1);

    // Blocked turn_end is marked with stopBlocked flag
    if (turnEnd0.kind === "turn_end") {
      expect(turnEnd0.stopBlocked).toBe(true);
    }

    expect(injectedMessages.length).toBe(1);
    expect(streamCalls.length).toBe(2);

    // Done metrics include the retry turn
    if (doneEvent.kind === "done") {
      expect(doneEvent.output.metrics.turns).toBe(2);
    }
  });

  test("block without inject adapter uses stopInput for retry stream", async () => {
    const { middleware } = blockingStopMiddleware(1);
    const { adapter, streamCalls } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: false },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [middleware],
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["turn_start", "turn_end", "turn_start", "done"]);

    expect(streamCalls.length).toBe(2);
    const [, retryInput] = streamCalls;
    if (!retryInput) throw new Error("unexpected streamCalls count");
    expect(retryInput.kind).toBe("messages");
    if (retryInput.kind === "messages") {
      // messages[0] = original user question, messages[1] = block feedback (#1493)
      expect(retryInput.messages.length).toBe(2);
      const blockContent = retryInput.messages[1]?.content[0];
      expect(blockContent).toMatchObject({
        kind: "text",
        text: expect.stringContaining("[Stop hook feedback]"),
      });
    }
  });

  test("respects maxStopRetries and yields done after exhaustion", async () => {
    const { middleware } = blockingStopMiddleware(999);
    const calls = Array.from({ length: DEFAULT_MAX_STOP_RETRIES + 1 }, () => [
      { kind: "done" as const, output: doneOutput() },
    ]);
    const { adapter } = multiCallAdapter(calls, { inject: true });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [middleware],
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();

    const turnEnds = events.filter((e) => e.kind === "turn_end");
    expect(turnEnds.length).toBe(DEFAULT_MAX_STOP_RETRIES);
  });

  test("onAfterTurn fires for stop-blocked turns", async () => {
    const { middleware, onAfterTurnCalls } = blockingStopMiddleware(1);
    const { adapter } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: true },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [middleware],
    });

    await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    // onAfterTurn for turn 0 was called with stopBlocked flag
    expect(onAfterTurnCalls).toContainEqual({ turnIndex: 0, stopBlocked: true });
  });

  test("retry adapter stream is created after turn boundary (not before)", async () => {
    const streamCreationOrder: string[] = [];
    const { middleware } = blockingStopMiddleware(1);

    // Wrap middleware to observe ordering: onBeforeTurn should fire AFTER
    // adapter.stream() for the retry turn (both happen in turnLoop)
    const orderMiddleware: KoiMiddleware = {
      name: "order-tracker",
      describeCapabilities: () => undefined,
      onBeforeTurn: async () => {
        streamCreationOrder.push("onBeforeTurn");
      },
    };

    // let justified: mutable call counter for stream ordering
    let streamCallCount = 0;
    const calls: readonly EngineEvent[][] = [
      [{ kind: "done", output: doneOutput() }],
      [{ kind: "done", output: doneOutput() }],
    ];

    const adapter: EngineAdapter = {
      engineId: "order-test-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      stream(_input: EngineInput): AsyncIterable<EngineEvent> {
        streamCreationOrder.push(`stream(${streamCallCount})`);
        const events = calls[streamCallCount] ?? [];
        streamCallCount++;
        // let justified: mutable index for async iteration
        let eventIndex = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<EngineEvent>> {
                if (eventIndex >= events.length) return { done: true, value: undefined };
                const event = events[eventIndex];
                if (event === undefined) return { done: true, value: undefined };
                eventIndex++;
                return { done: false, value: event };
              },
              async return(): Promise<IteratorResult<EngineEvent>> {
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
      inject(): void {
        /* no-op */
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [orderMiddleware, middleware],
    });

    await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    // Retry stream(1) must be created BEFORE onBeforeTurn for the retry turn,
    // but AFTER the blocked turn's turn_end (which is after stream(0))
    // Expected order: stream(0), onBeforeTurn, stream(1), onBeforeTurn
    expect(streamCreationOrder).toEqual(["stream(0)", "onBeforeTurn", "stream(1)", "onBeforeTurn"]);
  });

  test("non-inject adapter retry turn receives block reason in ctx.messages", async () => {
    const capturedMessages: unknown[][] = [];
    const { middleware } = blockingStopMiddleware(1);

    const messageCapture: KoiMiddleware = {
      name: "message-capture",
      describeCapabilities: () => undefined,
      onBeforeTurn: async (ctx: TurnContext) => {
        capturedMessages.push([...ctx.messages]);
      },
    };

    const { adapter } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: false },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [messageCapture, middleware],
    });

    await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    // First turn: empty messages (text input — bridge builds its own conversation)
    expect(capturedMessages[0]).toEqual([]);

    // Retry turn: original user message + block feedback (#1493: retry
    // includes original question so the model can re-anchor on the task)
    const retryMessages = capturedMessages[1] as ReadonlyArray<{
      readonly content: ReadonlyArray<{ readonly text?: string }>;
    }>;
    expect(retryMessages?.length).toBe(2);
    expect(retryMessages?.[1]?.content[0]?.text).toContain("[Stop hook feedback]");
  });

  test("inject adapter retry delivers block via both inject and stream input", async () => {
    const capturedMessages: unknown[][] = [];
    const { middleware } = blockingStopMiddleware(1);

    const messageCapture: KoiMiddleware = {
      name: "message-capture",
      describeCapabilities: () => undefined,
      onBeforeTurn: async (ctx: TurnContext) => {
        capturedMessages.push([...ctx.messages]);
      },
    };

    const { adapter, injectedMessages } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: true },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [messageCapture, middleware],
    });

    await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    // inject() called as best-effort hint
    expect(injectedMessages.length).toBe(1);

    // Block reason also in stream input (guaranteed delivery path).
    // Original user message + block feedback (#1493).
    expect(capturedMessages[1]?.length).toBe(2);
    expect(JSON.stringify(capturedMessages[1])).toContain("[Stop hook feedback]");
  });

  test("stop-gate retry feedback forbids capability parroting (#1493 regression guard)", async () => {
    // Regression guard for #1493: stop-gate retry feedback must explicitly
    // instruct the model to not describe tools/capabilities. This instruction
    // is the primary defense against chatty models echoing the [Active
    // Capabilities] banner after a blocked completion.
    const { middleware } = blockingStopMiddleware(1);
    const { adapter, injectedMessages } = multiCallAdapter(
      [[{ kind: "done", output: doneOutput() }], [{ kind: "done", output: doneOutput() }]],
      { inject: true },
    );

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [middleware],
    });

    await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    expect(injectedMessages.length).toBe(1);
    const feedbackText = JSON.stringify(injectedMessages[0]);
    // The feedback must contain the anti-parroting instruction
    expect(feedbackText).toContain("do not describe your tools");
    expect(feedbackText).toContain("your active capabilities");
  });
});

// ---------------------------------------------------------------------------
// C1: defaultToolTerminal provenance enrichment (#1464)
// ---------------------------------------------------------------------------

describe("defaultToolTerminal provenance metadata", () => {
  test("adds provenance metadata when tool descriptor has server field", async () => {
    // let justified: captured response from middleware
    let capturedResponse: import("@koi/core").ToolResponse | undefined;
    const executeMock = mock(() => Promise.resolve("mcp-result"));
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "provenance-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                await input.callHandlers.toolCall({
                  toolId: "crm__get_customer",
                  input: { id: "123" },
                });
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const captureMiddleware: KoiMiddleware = {
      name: "capture-provenance",
      phase: "observe" as const,
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req, next) => {
        const response = await next(req);
        capturedResponse = response;
        return response;
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      middleware: [captureMiddleware],
      providers: [
        {
          name: "mcp-provider",
          attach: async () =>
            new Map([
              [
                toolToken("crm__get_customer") as string,
                {
                  descriptor: {
                    name: "crm__get_customer",
                    description: "Get CRM customer",
                    inputSchema: {},
                    server: "crm",
                  },
                  origin: "operator" as const,
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(capturedResponse).toBeDefined();
    expect(capturedResponse?.metadata).toBeDefined();
    const provenance = (capturedResponse?.metadata as Record<string, unknown>)?.provenance as
      | Record<string, unknown>
      | undefined;
    expect(provenance).toBeDefined();
    expect(provenance?.system).toBe("mcp");
    expect(provenance?.server).toBe("crm");
  });

  test("does not add provenance when tool descriptor has no server field", async () => {
    let capturedResponse: import("@koi/core").ToolResponse | undefined;
    const executeMock = mock(() => Promise.resolve("local-result"));
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "no-provenance-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                await input.callHandlers.toolCall({
                  toolId: "local_tool",
                  input: {},
                });
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const captureMiddleware: KoiMiddleware = {
      name: "capture-no-provenance",
      phase: "observe" as const,
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req, next) => {
        const response = await next(req);
        capturedResponse = response;
        return response;
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      middleware: [captureMiddleware],
      providers: [
        {
          name: "local-provider",
          attach: async () =>
            new Map([
              [
                toolToken("local_tool") as string,
                {
                  descriptor: {
                    name: "local_tool",
                    description: "Local tool",
                    inputSchema: {},
                  },
                  origin: "primordial" as const,
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(capturedResponse).toBeDefined();
    // No provenance metadata should be present
    const provenance = (capturedResponse?.metadata as Record<string, unknown> | undefined)
      ?.provenance;
    expect(provenance).toBeUndefined();
  });

  test("preserves existing request metadata alongside provenance", async () => {
    let capturedResponse: import("@koi/core").ToolResponse | undefined;
    const executeMock = mock(() => Promise.resolve("result"));
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    const adapter: EngineAdapter = {
      engineId: "merge-metadata-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              if (input.callHandlers) {
                await input.callHandlers.toolCall({
                  toolId: "billing__get_invoice",
                  input: {},
                  metadata: { traceId: "abc-123" },
                });
              }
              yield { kind: "done" as const, output: doneOutput() };
            }
          },
        };
      },
    };

    const captureMiddleware: KoiMiddleware = {
      name: "capture-merge",
      phase: "observe" as const,
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, req, next) => {
        const response = await next(req);
        capturedResponse = response;
        return response;
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      middleware: [captureMiddleware],
      providers: [
        {
          name: "billing-provider",
          attach: async () =>
            new Map([
              [
                toolToken("billing__get_invoice") as string,
                {
                  descriptor: {
                    name: "billing__get_invoice",
                    description: "Get invoice",
                    inputSchema: {},
                    server: "billing",
                  },
                  origin: "operator" as const,
                  policy: DEFAULT_UNSANDBOXED_POLICY,
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(capturedResponse?.metadata).toBeDefined();
    const meta = capturedResponse?.metadata as Record<string, unknown>;
    // Existing request metadata preserved
    expect(meta.traceId).toBe("abc-123");
    // Provenance added
    const provenance = meta.provenance as Record<string, unknown>;
    expect(provenance?.system).toBe("mcp");
    expect(provenance?.server).toBe("billing");
  });
});
