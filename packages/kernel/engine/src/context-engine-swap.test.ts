/**
 * Unit tests for createContextEngineSwapController — runtime swap + rollback
 * (issue #1767, Phase 5; consumes boundary semantics from #1939).
 */

import { describe, expect, test } from "bun:test";
import type { ContextEngine } from "@koi/core";
import { turnId } from "@koi/core";
import { createContextEngineSwapController } from "./context-engine-swap.js";

const engineA: ContextEngine = {
  identity: { name: "engine-a", version: "1.0.0" },
  prepare: (_ctx, m) => m,
};

const engineB: ContextEngine = {
  identity: { name: "engine-b", version: "1.0.0" },
  prepare: (_ctx, m) => m,
};

const engineC: ContextEngine = {
  identity: { name: "engine-c", version: "1.0.0" },
  prepare: (_ctx, m) => m,
};

const t = (i: number) => turnId("run-1" as Parameters<typeof turnId>[0], i);

describe("createContextEngineSwapController", () => {
  test("starts with the initial engine and no swap history", () => {
    const ctrl = createContextEngineSwapController(engineA);
    expect(ctrl.current()).toBe(engineA);
    expect(ctrl.history()).toHaveLength(0);
  });

  test("swap emits a structured event with from/to/reason", () => {
    const ctrl = createContextEngineSwapController(engineA);
    const evt = ctrl.swap(engineB, { turnId: t(1), reason: "operator force" });
    if (evt === undefined) throw new Error("expected swap event");
    expect(evt.kind).toBe("context-engine-swap");
    expect(evt.from.name).toBe("engine-a");
    expect(evt.to.name).toBe("engine-b");
    expect(evt.reason).toBe("operator force");
    expect(ctrl.current()).toBe(engineB);
  });

  test("swap event timestamp is ISO-8601", () => {
    const ctrl = createContextEngineSwapController(engineA);
    const evt = ctrl.swap(engineB, { turnId: t(1), reason: "test" });
    if (evt === undefined) throw new Error("expected swap event");
    expect(() => new Date(evt.timestamp).toISOString()).not.toThrow();
    expect(new Date(evt.timestamp).toISOString()).toBe(evt.timestamp);
  });

  test("swap into the same engine identity is a noop and returns no event", () => {
    const ctrl = createContextEngineSwapController(engineA);
    const sameId: ContextEngine = { ...engineA, prepare: (_c, m) => m };
    expect(ctrl.swap(sameId, { turnId: t(1), reason: "no change" })).toBeUndefined();
    expect(ctrl.history()).toHaveLength(0);
  });

  test("rollback reverts to the previous engine and emits a swap event", () => {
    const ctrl = createContextEngineSwapController(engineA);
    ctrl.swap(engineB, { turnId: t(1), reason: "experiment" });
    const rb = ctrl.rollback({ turnId: t(2), reason: "regression detected" });
    expect(rb).toBeDefined();
    expect(rb?.from.name).toBe("engine-b");
    expect(rb?.to.name).toBe("engine-a");
    expect(ctrl.current()).toBe(engineA);
  });

  test("rollback when never swapped returns undefined", () => {
    const ctrl = createContextEngineSwapController(engineA);
    expect(ctrl.rollback({ turnId: t(1), reason: "nothing to revert" })).toBeUndefined();
  });

  test("multiple swaps build an ordered history", () => {
    const ctrl = createContextEngineSwapController(engineA);
    ctrl.swap(engineB, { turnId: t(1), reason: "first" });
    ctrl.swap(engineC, { turnId: t(2), reason: "second" });
    const hist = ctrl.history();
    expect(hist).toHaveLength(2);
    expect(hist[0]?.to.name).toBe("engine-b");
    expect(hist[1]?.to.name).toBe("engine-c");
    expect(ctrl.current()).toBe(engineC);
  });

  test("rollback honors declared rollbackTarget across multiple swaps", () => {
    // A → B (rollbackTarget=A), then B → C (rollbackTarget=A).
    // Regression in C must roll back to A, not B.
    const ctrl = createContextEngineSwapController(engineA);
    ctrl.swap(engineB, { turnId: t(1), reason: "first", rollbackTarget: engineA.identity });
    ctrl.swap(engineC, { turnId: t(2), reason: "second", rollbackTarget: engineA.identity });
    const rb = ctrl.rollback({ turnId: t(3), reason: "regression in C" });
    expect(rb).toBeDefined();
    expect(rb?.from.name).toBe("engine-c");
    expect(rb?.to.name).toBe("engine-a");
    expect(ctrl.current()).toBe(engineA);
    // Stack collapsed past the intervening B frame.
    const next = ctrl.rollback({ turnId: t(4), reason: "extra" });
    expect(next).toBeUndefined();
  });

  test("swap rejects unreachable rollbackTarget up-front instead of deferring to rollback time", () => {
    const ctrl = createContextEngineSwapController(engineA);
    const engineMissing: ContextEngine = {
      identity: { name: "missing", version: "0.0.0" },
      prepare: (_c, m) => m,
    };
    // Validating at swap time means a configuration typo or stale target
    // fails fast, instead of turning rollback() into a silent no-op at
    // incident time when operators need it most.
    expect(() =>
      ctrl.swap(engineB, {
        turnId: t(1),
        reason: "experiment",
        rollbackTarget: engineMissing.identity,
      }),
    ).toThrow(/rollbackTarget.*not reachable/);
    // Stack untouched; active engine unchanged.
    expect(ctrl.current()).toBe(engineA);
  });

  test("swap may carry an explicit rollbackTarget identity", () => {
    const ctrl = createContextEngineSwapController(engineA);
    const evt = ctrl.swap(engineB, {
      turnId: t(1),
      reason: "experiment",
      rollbackTarget: engineA.identity,
    });
    expect(evt?.rollbackTarget?.name).toBe("engine-a");
  });
});
