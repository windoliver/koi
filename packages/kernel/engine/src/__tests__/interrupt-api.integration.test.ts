/**
 * Integration tests for the programmatic interrupt API (#1682).
 *
 * Tests the full createKoi + SessionRegistry flow end-to-end: registry-driven
 * interrupt, runtime.interrupt() delegation, fallback to internal controller,
 * auto-cleanup on completion, and isInterrupted reflecting composite signals.
 */

import { describe, expect, test } from "bun:test";
import type { AgentManifest, EngineAdapter, EngineEvent, EngineOutput } from "@koi/core";
import { sessionId } from "@koi/core";
import { createKoi } from "../koi.js";
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
    expect(registry.listActive()).toContain(sid);

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
    expect(registry.listActive()).not.toContain(sid);

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
    expect(registry.listActive()).not.toContain(sid);

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
// Test 6 & 7: Abandoned iterable cleanup (#1682)
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
    expect(registry.listActive()).toContain(sid);

    // cycleSession sweeps the abandoned state.
    await runtime.cycleSession?.();

    // Registry entry gone; a fresh run is accepted without an "already running" throw.
    expect(registry.listActive()).not.toContain(sid);

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
    expect(registry.listActive()).toContain(sid);

    await runtime.dispose();
    expect(registry.listActive()).not.toContain(sid);
  });
});
