/**
 * Integration tests for the programmatic interrupt API (#1682).
 *
 * Tests the full createKoi + SessionRegistry flow end-to-end: registry-driven
 * interrupt, runtime.interrupt() delegation, fallback to internal controller,
 * auto-cleanup on completion, and isInterrupted reflecting composite signals.
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
} from "@koi/core";
import { sessionId } from "@koi/core";
import { createKoi } from "../koi.js";
import type { SessionRegistry } from "../session-registry.js";
import { createSessionRegistry } from "../session-registry.js";

// ---------------------------------------------------------------------------
// Test helpers (mirror patterns from integration.test.ts)
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Interrupt Integration Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

/**
 * Adapter that yields `text_delta` events indefinitely until the provided
 * signal aborts, then yields a done event. This keeps the generator alive
 * long enough for interrupt tests to fire mid-stream.
 */
function pausingAdapter(signal?: AbortSignal): EngineAdapter {
  return {
    engineId: "pausing-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        // Yield one event immediately so callers can drive one next() before interrupting
        yield { kind: "text_delta" as const, delta: "first" };

        // Wait until aborted or a short timeout (to avoid infinite hang in tests)
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          const onAbort = (): void => resolve();
          signal?.addEventListener("abort", onAbort, { once: true });
          // Safety timeout so tests don't hang forever if abort never fires
          setTimeout(resolve, 5000);
        });

        yield { kind: "done" as const, output: doneOutput({ stopReason: "interrupted" }) };
      },
    }),
  };
}

/**
 * Simple adapter that yields a text_delta then completes naturally.
 * Used for tests that only need to verify post-run state.
 */
function completingAdapter(): EngineAdapter {
  return {
    engineId: "completing-adapter",
    capabilities: { text: true, images: false, files: false, audio: false },
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "hello" };
        yield { kind: "turn_end" as const, turnIndex: 0 };
        yield { kind: "done" as const, output: doneOutput() };
      },
    }),
  };
}

async function drainEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test 1: Registry-driven interrupt triggers done with stopReason "interrupted"
// ---------------------------------------------------------------------------

describe("registry-driven interrupt", () => {
  test("interrupt via registry produces done event with stopReason: interrupted and auto-cleans session", async () => {
    const registry = createSessionRegistry();
    const abortCtrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(abortCtrl.signal),
      sessionRegistry: registry,
    });

    const iter = runtime.run({ kind: "text", text: "hello" });
    const generator = iter[Symbol.asyncIterator]();

    // Drive one event so the generator's try-block fires and registers the session
    await generator.next();

    // Session must be registered at this point
    const sid = sessionId(runtime.sessionId);
    expect(registry.listActive().includes(sid)).toBe(true);

    // Interrupt via registry
    const interrupted = registry.interrupt(sid, "external");
    expect(interrupted).toBe(true);

    // Also abort the adapter's signal so the adapter loop exits
    abortCtrl.abort("interrupted");

    // Drain remaining events
    const remaining: EngineEvent[] = [];
    for (;;) {
      const result = await generator.next();
      if (result.done === true) break;
      if (result.value !== undefined) remaining.push(result.value);
    }

    // At least one done event with interrupted stop reason
    const doneEvents = remaining.filter((e) => e.kind === "done");
    expect(doneEvents.length).toBeGreaterThan(0);
    const doneEvt = doneEvents[0];
    expect(doneEvt).toBeDefined();
    // After toBeDefined, narrow via type assertion done by a runtime check:
    if (doneEvt === undefined) throw new Error("unreachable: doneEvt is defined");
    expect(doneEvt.output.stopReason).toBe("interrupted");

    // Auto-cleanup: session must be removed from registry after run completes
    expect(registry.listActive().includes(sid)).toBe(false);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 2: runtime.interrupt() with registry delegates correctly
// ---------------------------------------------------------------------------

describe("runtime.interrupt() with registry", () => {
  test("runtime.interrupt() delegates to registry and isInterrupted reflects abort state", async () => {
    const registry = createSessionRegistry();
    const abortCtrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(abortCtrl.signal),
      sessionRegistry: registry,
    });

    const iter = runtime.run({ kind: "text", text: "hello" });
    const generator = iter[Symbol.asyncIterator]();

    // Drive one event so the run is registered
    await generator.next();

    expect(runtime.isInterrupted()).toBe(false);

    // Interrupt via runtime (should delegate to registry)
    const result = runtime.interrupt("via-runtime");
    expect(result).toBe(true);

    expect(runtime.isInterrupted()).toBe(true);

    // Abort adapter signal so the stream can exit
    abortCtrl.abort("via-runtime");

    // Drain remaining events
    for (;;) {
      const next = await generator.next();
      if (next.done === true) break;
    }

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 3: runtime.interrupt() without registry falls back to internal controller
// ---------------------------------------------------------------------------

describe("runtime.interrupt() without registry (internal controller fallback)", () => {
  test("interrupt without registry: returns false before run, true during, false after", async () => {
    const abortCtrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(abortCtrl.signal),
      // no sessionRegistry
    });

    // Before any run: no active controller → returns false
    expect(runtime.interrupt()).toBe(false);
    expect(runtime.isInterrupted()).toBe(false);

    const iter = runtime.run({ kind: "text", text: "hello" });
    const generator = iter[Symbol.asyncIterator]();

    // Drive one event so the run is in progress
    await generator.next();

    // First interrupt during active run → true
    const first = runtime.interrupt("direct");
    expect(first).toBe(true);

    // Second interrupt → already aborted → false
    const second = runtime.interrupt("direct");
    expect(second).toBe(false);

    // Abort the adapter signal so the stream exits
    abortCtrl.abort("direct");

    // Drain remaining events to let the run fully settle
    for (;;) {
      const next = await generator.next();
      if (next.done === true) break;
    }

    // After run completion: no active controller → returns false again
    expect(runtime.interrupt()).toBe(false);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 4: Auto-cleanup on normal (non-interrupted) completion
// ---------------------------------------------------------------------------

describe("auto-cleanup on normal completion", () => {
  test("session is removed from registry after run completes normally", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    await drainEvents(runtime.run({ kind: "text", text: "hello" }));

    // Session must be auto-cleaned after normal completion
    const sid = sessionId(runtime.sessionId);
    expect(registry.listActive().includes(sid)).toBe(false);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 5a: registry.interrupt reports already-aborted when input.signal first
// ---------------------------------------------------------------------------

describe("registry composite-signal: interrupt reports already-aborted when caller aborted input.signal first", () => {
  test("registry.interrupt reports already-aborted when caller aborted input.signal first", async () => {
    const registry = createSessionRegistry();
    const external = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      // Pass external.signal to the adapter so it can exit when the signal fires.
      adapter: pausingAdapter(external.signal),
      sessionRegistry: registry,
    });
    const sid = sessionId(runtime.sessionId);
    const iter = runtime
      .run({
        kind: "text",
        text: "hi",
        signal: external.signal,
      } as Parameters<typeof runtime.run>[0])
      [Symbol.asyncIterator]();

    // Drain one step so generator has registered + cleared preIterationCleanup.
    await iter.next();

    // External abort via input.signal — runtime.isInterrupted() should be true.
    external.abort("from-input-signal");
    await Promise.resolve();
    expect(runtime.isInterrupted()).toBe(true);

    // registry.interrupt must now report "already interrupted" via the
    // composite signal check, not a spurious "I newly cancelled" true.
    expect(registry.interrupt(sid, "double-cancel")).toBe(false);

    // Drain remaining events and dispose.
    while (!(await iter.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 5: isInterrupted reflects an external input.signal abort
// ---------------------------------------------------------------------------

describe("isInterrupted reflects external input.signal abort", () => {
  test("isInterrupted() returns true after external signal is aborted (composite signal fix)", async () => {
    const externalCtrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(externalCtrl.signal),
      // sessionRegistry optional for this test — verifying composite signal
    });

    const iter = runtime.run({
      kind: "text",
      text: "hello",
      signal: externalCtrl.signal,
    });
    const generator = iter[Symbol.asyncIterator]();

    // Drive one event so the run is active and the composite signal is wired
    await generator.next();

    expect(runtime.isInterrupted()).toBe(false);

    // Abort the external signal
    externalCtrl.abort("from-caller");

    // Give the microtask queue a tick to propagate the abort event
    await Promise.resolve();

    expect(runtime.isInterrupted()).toBe(true);

    // Drain remaining events
    for (;;) {
      const next = await generator.next();
      if (next.done === true) break;
    }

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 6: Pre-start interrupt short-circuit (#1682)
// ---------------------------------------------------------------------------

describe("pre-start interrupt short-circuit", () => {
  test("interrupt before first .next() emits terminal done and skips session-start side effects", async () => {
    // Track whether onSessionStart fired; if the short-circuit works,
    // it must NOT fire because session init is skipped entirely.
    let onSessionStartFired = false;
    const middleware: KoiMiddleware[] = [
      {
        name: "session-start-spy",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          onSessionStartFired = true;
        },
      },
    ];
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      middleware,
      sessionRegistry: registry,
    });
    const sid = sessionId(runtime.sessionId);

    // Start the run but DO NOT iterate yet.
    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();

    // Interrupt BEFORE first .next().
    expect(registry.interrupt(sid, "pre-start")).toBe(true);

    // Now drain. First event should be the synthetic terminal.
    const first = await iter.next();
    expect(first.done).toBe(false);
    // The first yielded value must be a done event with stopReason: interrupted
    if (first.value.kind !== "done") throw new Error("expected done event");
    expect(first.value.output.stopReason).toBe("interrupted");
    // Generator signals done on the next pull.
    expect((await iter.next()).done).toBe(true);

    // Session-start hook MUST NOT have fired.
    expect(onSessionStartFired).toBe(false);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 7 & 8: Abandoned iterable cleanup (#1682)
// ---------------------------------------------------------------------------

describe("abandoned iterable cleanup", () => {
  test("run() called but never iterated — cycleSession clears registry and accepts new run", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    const sid = sessionId(runtime.sessionId);

    // Call run() but DO NOT iterate. The returned iterable is abandoned.
    const _abandoned = runtime.run({ kind: "text", text: "hello" });

    // After run(), the registry should show the session (synchronous register).
    expect(registry.listActive().includes(sid)).toBe(true);

    // cycleSession sweeps the abandoned state.
    await runtime.cycleSession?.();

    // Registry entry gone; a fresh run is accepted without an "already running" throw.
    expect(registry.listActive().includes(sid)).toBe(false);

    const iter = runtime.run({ kind: "text", text: "hello" });
    await drainEvents(iter); // should not throw

    await runtime.dispose();
  });

  test("run() called but never iterated — dispose clears registry", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    const sid = sessionId(runtime.sessionId);
    const _abandoned = runtime.run({ kind: "text", text: "hello" });
    expect(registry.listActive().includes(sid)).toBe(true);

    await runtime.dispose();
    expect(registry.listActive().includes(sid)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Pre-iteration abort self-cleanup (#1682)
// ---------------------------------------------------------------------------

describe("pre-iteration abort self-cleanup", () => {
  test("interrupt before iteration releases all state — subsequent run() succeeds", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });
    const sid = sessionId(runtime.sessionId);

    const _abandoned = runtime.run({ kind: "text", text: "hello" });
    expect(registry.listActive().includes(sid)).toBe(true);

    // Interrupt before ANY iteration.
    expect(registry.interrupt(sid)).toBe(true);

    // Registry entry gone. A fresh run is accepted.
    expect(registry.listActive().includes(sid)).toBe(false);

    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();
    // should NOT throw "Agent is already running"
    while (!(await iter.next()).done) {}

    await runtime.dispose();
  });

  test("already-aborted input.signal triggers self-cleanup synchronously", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });
    const sid = sessionId(runtime.sessionId);

    const ctrl = new AbortController();
    ctrl.abort("pre-aborted");

    const _abandoned = runtime.run({ kind: "text", text: "hello", signal: ctrl.signal });
    // After run() returns, the self-clean path should have fired.
    expect(registry.listActive().includes(sid)).toBe(false);

    // Subsequent run() accepted.
    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();
    while (!(await iter.next()).done) {}

    await runtime.dispose();
  });

  test("runtime.interrupt() before iteration releases state", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      // NOTE: no sessionRegistry — tests fallback path too.
    });

    const _abandoned = runtime.run({ kind: "text", text: "hello" });
    expect(runtime.interrupt("pre-iter")).toBe(true);

    // Subsequent run() accepted, no "Agent is already running".
    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();
    while (!(await iter.next()).done) {}

    await runtime.dispose();
  });

  test("run({signal: alreadyAborted}) yields a fresh run B safe from A's stale iterable", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    // Run A with an already-aborted input signal. onAbort self-cleans
    // synchronously and bumps sessionEpoch.
    const preAborted = new AbortController();
    preAborted.abort("pre-aborted");
    const iterA = runtime
      .run({ kind: "text", text: "A", signal: preAborted.signal })
      [Symbol.asyncIterator]();

    // Start run B while iterA is still uniterated.
    const iterB = runtime.run({ kind: "text", text: "B" })[Symbol.asyncIterator]();
    const bFirst = await iterB.next();
    expect(bFirst.done).toBe(false);

    // NOW consume iterA. It must either yield a stale-epoch error OR
    // a clean terminal done without disturbing B's state.
    // Either way, B must remain the active run afterwards.
    try {
      for (;;) {
        const next = await iterA.next();
        if (next.done === true) break;
      }
    } catch {
      // stale-epoch throw is acceptable
    }

    // B is still active — a third run must still be rejected.
    expect(() => runtime.run({ kind: "text", text: "C" })).toThrow(/Agent is already running/);

    // Drain B and dispose.
    while (!(await iterB.next()).done) {}
    await runtime.dispose();
  });

  test("aborted iterable A cannot clobber newer run B if consumed late", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    // Run A — start then abort pre-iteration.
    const iterA = runtime.run({ kind: "text", text: "A" })[Symbol.asyncIterator]();
    const sidA = sessionId(runtime.sessionId);
    expect(registry.interrupt(sidA)).toBe(true);
    // Post-abort, all state is released.
    expect(registry.listActive().includes(sidA)).toBe(false);

    // Run B — starts on the fresh (post-abort) latch.
    const iterB = runtime.run({ kind: "text", text: "B" })[Symbol.asyncIterator]();
    // B should be running and tracked.
    const bFirst = await iterB.next();
    expect(bFirst.done).toBe(false);

    // NOW iterate A (the stale iterable). It must fail the epoch check
    // and throw rather than re-entering streamEvents.
    await expect(iterA.next()).rejects.toThrow(
      /Run was discarded|Runtime has been disposed|Runtime is being disposed|Runtime teardown/,
    );

    // B is still active — `run()` still rejects concurrent starts.
    expect(() => runtime.run({ kind: "text", text: "C" })).toThrow(/Agent is already running/);

    // Drain B to completion and dispose cleanly.
    while (!(await iterB.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 9: Cross-generation safety via currentRunId + expectedRunId interrupt
// ---------------------------------------------------------------------------

describe("cross-generation safety via currentRunId", () => {
  test("late cancel with stale runId does not abort a subsequent run on the same runtime", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    // Run A — capture its runId then let it finish.
    const iterA = runtime.run({ kind: "text", text: "A" })[Symbol.asyncIterator]();
    const runIdA = runtime.currentRunId;
    expect(runIdA).toBeDefined();
    while (!(await iterA.next()).done) {}
    // Between runs: no active runId.
    expect(runtime.currentRunId).toBeUndefined();

    // Run B — capture its runId.
    const iterB = runtime.run({ kind: "text", text: "B" })[Symbol.asyncIterator]();
    await iterB.next(); // drive one step so B is registered
    const runIdB = runtime.currentRunId;
    expect(runIdB).toBeDefined();
    expect(runIdB).not.toBe(runIdA);

    const sid = sessionId(runtime.sessionId);

    // Late cancel intended for A arrives NOW, targeting runIdA.
    // Must be a no-op because B is active, not A.
    expect(registry.interrupt(sid, "late-for-A", runIdA)).toBe(false);

    // B is still running; drain it cleanly.
    while (!(await iterB.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 10: RunHandle.interrupt is run-scoped (cross-generation safety)
// ---------------------------------------------------------------------------

describe("RunHandle.interrupt cross-generation safety", () => {
  test("RunHandle.interrupt is run-scoped — late cancel from run A does NOT abort run B", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    // Start run A, capture its handle, let it finish.
    const handleA = runtime.run({ kind: "text", text: "A" });
    const iterA = handleA[Symbol.asyncIterator]();
    while (!(await iterA.next()).done) {}

    // Start run B on the same runtime.
    const handleB = runtime.run({ kind: "text", text: "B" });
    const iterB = handleB[Symbol.asyncIterator]();
    await iterB.next(); // drive one step

    expect(handleA.runId).not.toBe(handleB.runId);

    // Late cancel via handleA.interrupt — run-scoped, must NOT hit B.
    expect(handleA.interrupt("late-from-A")).toBe(false);
    expect(runtime.isInterrupted()).toBe(false);

    // Drain B cleanly.
    while (!(await iterB.next()).done) {}
    await runtime.dispose();
  });

  test("RunHandle.interrupt aborts only its own run while the run is active", async () => {
    const registry = createSessionRegistry();
    const abortCtrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(abortCtrl.signal),
      sessionRegistry: registry,
    });

    const handle = runtime.run({ kind: "text", text: "hi" });
    const iter = handle[Symbol.asyncIterator]();
    await iter.next();

    expect(handle.interrupt("live-cancel")).toBe(true);
    expect(runtime.isInterrupted()).toBe(true);
    expect(handle.interrupt("double-cancel")).toBe(false);

    abortCtrl.abort("live-cancel");
    while (!(await iter.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 11: Fallback interrupt reads composite signal (no registry)
// ---------------------------------------------------------------------------

describe("fallback interrupt reads composite signal", () => {
  test("fallback (no registry) — interrupt returns false after external input.signal abort", async () => {
    // No sessionRegistry wired — exercises the composite-signal fallback.
    // Pass the caller's signal to pausingAdapter so the adapter exits
    // promptly on ctrl.abort() instead of waiting the safety timeout.
    const ctrl = new AbortController();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(ctrl.signal),
      // deliberately NO sessionRegistry
    });
    const iter = runtime
      .run({
        kind: "text",
        text: "hi",
        signal: ctrl.signal,
      } as Parameters<typeof runtime.run>[0])
      [Symbol.asyncIterator]();
    await iter.next();
    expect(runtime.isInterrupted()).toBe(false);

    ctrl.abort("external");
    await Promise.resolve();
    // Runtime observes the composite signal aborted.
    expect(runtime.isInterrupted()).toBe(true);
    // Fallback interrupt must now report "already interrupted", not
    // spuriously return true by checking only the internal controller.
    expect(runtime.interrupt("late-internal")).toBe(false);

    while (!(await iter.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 12: register failure rolls back currentRunId
// ---------------------------------------------------------------------------

describe("register failure rolls back currentRunId", () => {
  test("registry.register failure rolls back currentRunId so runtime stays clean", async () => {
    // A malicious/legitimate CONFLICT — register throws CONFLICT.
    const sharedRegistry = createSessionRegistry();
    // Wrap the registry to force a throw on register.
    const throwingRegistry: SessionRegistry = {
      register: () => {
        throw new Error("simulated collision");
      },
      interrupt: sharedRegistry.interrupt,
      isInterrupted: sharedRegistry.isInterrupted,
      listActive: sharedRegistry.listActive,
      forceUnregister: sharedRegistry.forceUnregister, // now takes (sid, runId) — same passthrough is fine
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: throwingRegistry,
    });

    // run() must propagate the throw.
    expect(() => runtime.run({ kind: "text", text: "x" })).toThrow();

    // After the throw, runtime.currentRunId must be undefined.
    expect(runtime.currentRunId).toBeUndefined();

    // And the runtime must accept a subsequent run (no "already running" latch).
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 12b: register-fail with partial mutation is cleaned up via forceUnregister
// ---------------------------------------------------------------------------

describe("register-fail ghost entry cleanup", () => {
  test("register-fail with partial mutation is cleaned up via forceUnregister", async () => {
    // Custom registry that inserts the entry, then throws before returning unregister.
    // After run() fails, the entry must NOT be stuck.
    const inner = createSessionRegistry();
    let sawRegisterCall = false;
    const leakyRegistry: SessionRegistry = {
      register: (sid, rid, ctrl, signal) => {
        sawRegisterCall = true;
        inner.register(sid, rid, ctrl, signal);
        throw new Error("partial mutation then throw");
      },
      interrupt: inner.interrupt,
      isInterrupted: inner.isInterrupted,
      listActive: inner.listActive,
      forceUnregister: inner.forceUnregister,
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: leakyRegistry,
    });

    // run() must propagate the register error...
    expect(() => runtime.run({ kind: "text", text: "x" })).toThrow(/partial mutation/);

    // ...AND the leaked entry must be evicted by the rollback path.
    expect(sawRegisterCall).toBe(true);
    expect(inner.listActive()).toHaveLength(0);

    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 13: Stale iterable finally does NOT clobber newer run's global state
// ---------------------------------------------------------------------------

describe("stale iterable terminal delivery", () => {
  test("stale iterable A's finally does NOT clobber run B's global state", async () => {
    const registry = createSessionRegistry();
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: registry,
    });

    // Run A — start, grab its handle + runId, abort pre-iteration.
    const handleA = runtime.run({ kind: "text", text: "A" });
    const iterA = handleA[Symbol.asyncIterator]();
    expect(handleA.interrupt()).toBe(true);
    // onAbort released state; registry empty.
    expect(registry.listActive()).toHaveLength(0);

    // Run B starts cleanly with its own runId.
    const handleB = runtime.run({ kind: "text", text: "B" });
    const iterB = handleB[Symbol.asyncIterator]();
    await iterB.next(); // drive one step — B's globals are now live
    const bRunId = runtime.currentRunId;
    expect(bRunId).toBe(handleB.runId);
    expect(runtime.isInterrupted()).toBe(false);

    // NOW consume A (late). A's finally must NOT clobber B's globals.
    try {
      for (;;) {
        const next = await iterA.next();
        if (next.done === true) break;
      }
    } catch {
      // stale-epoch throw is acceptable
    }

    // B's currentRunId must still be bRunId.
    expect(runtime.currentRunId).toBe(bRunId);
    // B must still be considered running — a third run() rejects.
    expect(() => runtime.run({ kind: "text", text: "C" })).toThrow(/Agent is already running/);

    // Drain B cleanly and dispose.
    while (!(await iterB.next()).done) {}
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// Test 14: RunHandle is single-consumer
// ---------------------------------------------------------------------------

describe("RunHandle single-consumer guard", () => {
  test("RunHandle is single-consumer — second [Symbol.asyncIterator]() throws", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
    });
    const handle = runtime.run({ kind: "text", text: "x" });
    const _iterA = handle[Symbol.asyncIterator]();
    expect(() => handle[Symbol.asyncIterator]()).toThrow(/single-consumer|only be called once/);
    // Drain the first iterator cleanly to avoid leaks.
    while (!(await _iterA.next()).done) {}
    await runtime.dispose();
  });
});

describe("cross-runtime ownership: idle runtime cannot read or mutate sibling state", () => {
  test("runtime.interrupt() on idle runtime A does NOT abort active runtime B sharing the same registry+sessionId", async () => {
    const sharedRegistry = createSessionRegistry();
    const sid = "shared-sid-xruntime";
    const bAbortCtrl = new AbortController();
    const runtimeA = await createKoi({
      manifest: testManifest(),
      adapter: completingAdapter(),
      sessionRegistry: sharedRegistry,
      sessionId: sessionId(sid),
    });
    const runtimeB = await createKoi({
      manifest: testManifest(),
      adapter: pausingAdapter(bAbortCtrl.signal),
      sessionRegistry: sharedRegistry,
      sessionId: sessionId(sid),
    });

    // B starts a run; A stays idle.
    const iterB = runtimeB.run({ kind: "text", text: "b" })[Symbol.asyncIterator]();
    await iterB.next();
    expect(runtimeB.isInterrupted()).toBe(false);

    // A is idle — interrupt() and isInterrupted() must be no-ops, NOT
    // leak across runtimes and abort B.
    expect(runtimeA.interrupt("from-A")).toBe(false);
    expect(runtimeA.isInterrupted()).toBe(false);

    // B must still be running (not aborted by A's idle call).
    expect(runtimeB.isInterrupted()).toBe(false);

    // Drain B by aborting the adapter's wait signal.
    bAbortCtrl.abort("drain");
    while (!(await iterB.next()).done) {}
    await runtimeA.dispose();
    await runtimeB.dispose();
  });
});
