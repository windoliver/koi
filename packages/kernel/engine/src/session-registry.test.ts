import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import { createSessionRegistry } from "./session-registry.js";

describe("createSessionRegistry", () => {
  test("register returns an unregister function", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-1");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, ctrl);
    expect(typeof unregister).toBe("function");
    expect(registry.listActive()).toEqual([sid]);
    unregister();
    expect(registry.listActive()).toEqual([]);
  });

  test("register throws when sessionId is already registered", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-2");
    registry.register(sid, new AbortController());
    expect(() => registry.register(sid, new AbortController())).toThrow(/already registered/);
  });

  test("interrupt returns true on first call, false on subsequent calls", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-3");
    const ctrl = new AbortController();
    registry.register(sid, ctrl);
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
    registry.register(sid, ctrl);
    registry.interrupt(sid, "user-cancel");
    expect(ctrl.signal.reason).toBe("user-cancel");
  });

  test("interrupt without reason still aborts", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-5");
    const ctrl = new AbortController();
    registry.register(sid, ctrl);
    expect(registry.interrupt(sid)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  test("isInterrupted reflects signal state", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-6");
    const ctrl = new AbortController();
    registry.register(sid, ctrl);
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
    const unregister = registry.register(sid, ctrl);
    ctrl.abort();
    unregister();
    expect(registry.isInterrupted(sid)).toBe(false);
  });

  test("unregister is idempotent", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-8");
    const unregister = registry.register(sid, new AbortController());
    unregister();
    expect(() => unregister()).not.toThrow();
    expect(registry.listActive()).toEqual([]);
  });

  test("unregister after interrupt still clears the entry", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("s-9");
    const ctrl = new AbortController();
    const unregister = registry.register(sid, ctrl);
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
    registry.register(a, ctrlA);
    registry.register(b, ctrlB);
    expect(new Set(registry.listActive())).toEqual(new Set([a, b]));
    registry.interrupt(a);
    expect(ctrlA.signal.aborted).toBe(true);
    expect(ctrlB.signal.aborted).toBe(false);
  });

  test("listActive returns a stable snapshot (caller mutation does not affect registry)", () => {
    const registry = createSessionRegistry();
    const sid = sessionId("snap");
    registry.register(sid, new AbortController());
    const snapshot = registry.listActive();
    expect(snapshot).toEqual([sid]);
    const snapshot2 = registry.listActive();
    expect(snapshot2).not.toBe(snapshot);
  });
});
