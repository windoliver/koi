import { describe, expect, test } from "bun:test";
import type { SessionId } from "@koi/core";
import { sessionId } from "@koi/core";
import { createSessionRegistry } from "./session-registry.js";

describe("createSessionRegistry", () => {
  test("register returns an unregister function", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-1");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, ctrl, ctrl.signal);
    expect(typeof unregister).toBe("function");
    expect(registry.listActive()).toEqual([sid]);
    unregister();
    expect(registry.listActive()).toEqual([]);
  });

  test("register throws when sessionId is already registered", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-2");
    registry.register(sid, new AbortController(), AbortSignal.any([]));
    expect(() => registry.register(sid, new AbortController(), AbortSignal.any([]))).toThrow(
      /already registered/,
    );
  });

  test("interrupt returns true on first call, false on subsequent calls", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-3");
    const ctrl = new AbortController();
    registry.register(sid, ctrl, ctrl.signal);
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
    registry.register(sid, ctrl, ctrl.signal);
    registry.interrupt(sid, "user-cancel");
    expect(ctrl.signal.reason).toBe("user-cancel");
  });

  test("interrupt without reason still aborts", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-5");
    const ctrl = new AbortController();
    registry.register(sid, ctrl, ctrl.signal);
    expect(registry.interrupt(sid)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("isInterrupted reflects signal state", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-6");
    const ctrl = new AbortController();
    registry.register(sid, ctrl, ctrl.signal);
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
    const unregister = registry.register(sid, ctrl, ctrl.signal);
    ctrl.abort();
    unregister();
    expect(registry.isInterrupted(sid)).toBe(false);
  });

  test("unregister is idempotent", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-8");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, ctrl, ctrl.signal);
    unregister();
    expect(() => unregister()).not.toThrow();
    expect(registry.listActive()).toEqual([]);
  });

  test("unregister after interrupt still clears the entry", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-9");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, ctrl, ctrl.signal);
    registry.interrupt(sid);
    unregister();
    expect(registry.listActive()).toEqual([]);
    expect(registry.interrupt(sid)).toBe(false);
  });

  test("multiple sessions coexist independently", () => {
    const registry = createSessionRegistry();
    const a = sessionId("a");
    const b = sessionId("b");
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();
    registry.register(a, ctrlA, ctrlA.signal);
    registry.register(b, ctrlB, ctrlB.signal);
    expect(new Set(registry.listActive())).toEqual(new Set([a, b]));
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
    registry.register(sid, ctrl, runSignal);

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
    registry.register(sid, new AbortController(), AbortSignal.any([]));
    try {
      registry.register(sid, new AbortController(), AbortSignal.any([]));
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
    registry.register(sid, ctrl, ctrl.signal);

    const snapshot = registry.listActive();
    expect(snapshot).toEqual([sid]);

    // Two calls return two different array instances, so caller mutation
    // to one cannot leak into a subsequent read.
    const snapshot2 = registry.listActive();
    expect(snapshot2).not.toBe(snapshot);

    // Attempting to mutate the snapshot at runtime (the type system
    // forbids it; this cast reaches past the readonly guard) must not
    // affect the registry's internal state.
    (snapshot as unknown as SessionId[]).pop();
    const snapshot3 = registry.listActive();
    expect(snapshot3).toEqual([sid]);
  });
});
