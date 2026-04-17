import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core";
import { runId, sessionId } from "@koi/core";
import { createSessionRegistry } from "./session-registry.js";

describe("createSessionRegistry", () => {
  test("register returns an unregister function", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-1");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, runId("r-1"), ctrl, ctrl.signal);
    expect(typeof unregister).toBe("function");
    const list = registry.listActive();
    expect(list).toHaveLength(1);
    expect(list[0]?.sessionId).toBe(sid);
    unregister();
    expect(registry.listActive()).toHaveLength(0);
  });

  test("register throws when sessionId is already registered", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-2");
    registry.register(sid, runId("r-2"), new AbortController(), AbortSignal.any([]));
    expect(() =>
      registry.register(sid, runId("r-2b"), new AbortController(), AbortSignal.any([])),
    ).toThrow(/already registered/);
  });

  test("interrupt returns true on first call, false on subsequent calls", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-3");
    const ctrl = new AbortController();
    registry.register(sid, runId("r-3"), ctrl, ctrl.signal);
    expect(registry.interrupt(sid, "test")).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
    expect(registry.interrupt(sid, "test-again")).toBe(false);
  });

  test("interrupt returns false for unknown sessionId", () => {
    const registry = createSessionRegistry();
    expect(registry.interrupt(sessionId("unknown"))).toBe(false);
  });

  test("interrupt reason is passed to AbortController.abort", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-4");
    const ctrl = new AbortController();
    registry.register(sid, runId("r-4"), ctrl, ctrl.signal);
    registry.interrupt(sid, "user-cancel");
    expect(ctrl.signal.reason).toBe("user-cancel");
  });

  test("interrupt without reason still aborts", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-5");
    const ctrl = new AbortController();
    registry.register(sid, runId("r-5"), ctrl, ctrl.signal);
    expect(registry.interrupt(sid)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("isInterrupted reflects signal state", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-6");
    const ctrl = new AbortController();
    registry.register(sid, runId("r-6"), ctrl, ctrl.signal);
    expect(registry.isInterrupted(sid)).toBe(false);
    ctrl.abort();
    expect(registry.isInterrupted(sid)).toBe(true);
  });

  test("isInterrupted returns false for unknown sessionId", () => {
    const registry = createSessionRegistry();
    expect(registry.isInterrupted(sessionId("unknown"))).toBe(false);
  });

  test("isInterrupted returns false after unregister", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-7");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, runId("r-7"), ctrl, ctrl.signal);
    ctrl.abort();
    unregister();
    expect(registry.isInterrupted(sid)).toBe(false);
  });

  test("unregister is idempotent", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-8");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, runId("r-8"), ctrl, ctrl.signal);
    unregister();
    expect(() => unregister()).not.toThrow();
    expect(registry.listActive()).toHaveLength(0);
  });

  test("unregister after interrupt still clears the entry", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-9");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, runId("r-9"), ctrl, ctrl.signal);
    registry.interrupt(sid);
    unregister();
    expect(registry.listActive()).toHaveLength(0);
    expect(registry.interrupt(sid)).toBe(false);
  });

  test("multiple sessions coexist independently", () => {
    const registry = createSessionRegistry();
    const a = sessionId("a");
    const b = sessionId("b");
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    registry.register(a, runId("r-a"), ctrlA, ctrlA.signal);
    registry.register(b, runId("r-b"), ctrlB, ctrlB.signal);
    const list = registry.listActive();
    const sids = new Set(list.map((e) => e.sessionId));
    expect(sids).toEqual(new Set([a, b]));
    registry.interrupt(a);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
  });

  test("isInterrupted reflects an external abort on the composite runSignal", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("sc-1");
    const ctrl = new AbortController();
    const external = new AbortController();
    const runSignal = AbortSignal.any([external.signal, ctrl.signal]);
    registry.register(sid, runId("r-sc1"), ctrl, runSignal);

    expect(registry.isInterrupted(sid)).toBe(false);
    external.abort("from-input-signal");

    // The registry entry's runSignal is now aborted, even though the
    // internal controller is not.
    expect(registry.isInterrupted(sid)).toBe(true);
    // interrupt() must report "no-op" because the run is already
    // effectively aborted (per the composite signal).
    expect(registry.interrupt(sid)).toBe(false);
  });

  test("register throws CONFLICT (retryable) on cross-runtime collision, not INTERNAL", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("collide");
    registry.register(sid, runId("r-c1"), new AbortController(), AbortSignal.any([]));
    try {
      registry.register(sid, runId("r-c2"), new AbortController(), AbortSignal.any([]));
      throw new Error("expected throw");
    } catch (e: unknown) {
      // KoiRuntimeError has a `code` field — verify it's CONFLICT.
      expect((e as { code?: string }).code).toBe("CONFLICT");
    }
  });

  test("listActive returns a fresh array per call and tolerates caller mutation", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("snap");
    const ctrl = new AbortController();
    registry.register(sid, runId("r-snap"), ctrl, ctrl.signal);

    const snapshot = registry.listActive();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.sessionId).toBe(sid);

    // Two calls return two different array instances, so caller mutation
    // to one cannot leak into a subsequent read.
    const snapshot2 = registry.listActive();
    expect(snapshot2).not.toBe(snapshot);

    // Attempting to mutate the snapshot at runtime must not affect the
    // registry's internal state.
    (snapshot as unknown as SessionId[]).pop();
    const snapshot3 = registry.listActive();
    expect(snapshot3).toHaveLength(1);
    expect(snapshot3[0]?.sessionId).toBe(sid);
  });

  test("forceUnregister requires runId match OR aborted entry (ownership guard)", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("stuck");
    const r1 = runId("r-stuck");
    const ctrl = new AbortController();
    registry.register(sid, r1, ctrl, ctrl.signal);

    // Without runId or abort state, eviction is refused.
    expect(registry.forceUnregister(sid)).toBe(false);
    expect(registry.listActive()).toHaveLength(1);

    // Wrong runId — still refused.
    expect(registry.forceUnregister(sid, runId("other"))).toBe(false);
    expect(registry.listActive()).toHaveLength(1);

    // Correct runId — removed.
    expect(registry.forceUnregister(sid, r1)).toBe(true);
    expect(registry.listActive()).toHaveLength(0);

    // Fresh register now succeeds.
    const r2 = runId("r-fresh");
    expect(() =>
      registry.register(sid, r2, new AbortController(), AbortSignal.any([])),
    ).not.toThrow();

    // forceUnregister on an unknown sid returns false.
    expect(registry.forceUnregister(sessionId("nonexistent"), r2)).toBe(false);
  });

  test("forceUnregister removes an aborted entry without runId proof (stale recovery)", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("aborted");
    const r1 = runId("r-aborted");
    const ctrl = new AbortController();
    registry.register(sid, r1, ctrl, ctrl.signal);

    // Not aborted yet — refuse without runId.
    expect(registry.forceUnregister(sid)).toBe(false);

    // Abort the entry's signal.
    ctrl.abort();
    // Now the entry is stale; forceUnregister without runId removes it.
    expect(registry.forceUnregister(sid)).toBe(true);
    expect(registry.listActive()).toHaveLength(0);
  });

  test("interrupt with expectedRunId mismatch is a no-op (cross-generation safety)", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-x");
    const r1 = runId("run-1");
    const ctrl = new AbortController();
    registry.register(sid, r1, ctrl, ctrl.signal);

    // expectedRunId = "run-2" (mismatch) — do not abort.
    expect(registry.interrupt(sid, "stale-cancel", runId("run-2"))).toBe(false);
    expect(ctrl.signal.aborted).toBe(false);

    // expectedRunId = "run-1" (match) — abort.
    expect(registry.interrupt(sid, "live-cancel", r1)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });
});
