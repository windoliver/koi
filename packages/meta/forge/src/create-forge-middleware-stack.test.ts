/**
 * Unit tests for createForgeMiddlewareStack factory.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeStore, KoiError, Result, TurnTrace } from "@koi/core";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createForgeMiddlewareStack } from "./create-forge-middleware-stack.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function emptyTraces(): Promise<Result<readonly TurnTrace[], KoiError>> {
  return Promise.resolve({ ok: true, value: [] });
}

function noopResolveBrickId(): string | undefined {
  return undefined;
}

function createStack(storeOverride?: ForgeStore) {
  const store = storeOverride ?? createInMemoryForgeStore();
  return createForgeMiddlewareStack({
    forgeStore: store,
    forgeConfig: createDefaultForgeConfig(),
    scope: "agent",
    readTraces: emptyTraces,
    resolveBrickId: noopResolveBrickId,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createForgeMiddlewareStack", () => {
  test("creates all 7 middleware in correct priority order", () => {
    const result = createStack();

    expect(result.middlewares).toHaveLength(7);

    const priorities = result.middlewares.map((m) => m.priority);
    // feedback-loop(450), demand(455), exaptation(465), usage(900), crystallize(950), auto-forge(960), optimizer(990)
    expect(priorities).toEqual([450, 455, 465, 900, 950, 960, 990]);
  });

  test("middleware names are correct", () => {
    const result = createStack();

    const names = result.middlewares.map((m) => m.name);
    expect(names).toEqual([
      "feedback-loop",
      "forge-demand-detector",
      "forge-exaptation-detector",
      "forge-usage",
      "crystallize",
      "auto-forge",
      "forge-optimizer",
    ]);
  });

  test("returns demand handle with signal API", () => {
    const result = createStack();

    expect(result.handles.demand).toBeDefined();
    expect(typeof result.handles.demand.getSignals).toBe("function");
    expect(typeof result.handles.demand.dismiss).toBe("function");
    expect(typeof result.handles.demand.getActiveSignalCount).toBe("function");
    expect(result.handles.demand.getSignals()).toEqual([]);
  });

  test("returns crystallize handle with candidate API", () => {
    const result = createStack();

    expect(result.handles.crystallize).toBeDefined();
    expect(typeof result.handles.crystallize.getCandidates).toBe("function");
    expect(typeof result.handles.crystallize.dismiss).toBe("function");
    expect(result.handles.crystallize.getCandidates()).toEqual([]);
  });

  test("returns exaptation handle with signal API", () => {
    const result = createStack();

    expect(result.handles.exaptation).toBeDefined();
    expect(typeof result.handles.exaptation.getSignals).toBe("function");
    expect(typeof result.handles.exaptation.dismiss).toBe("function");
    expect(typeof result.handles.exaptation.getActiveSignalCount).toBe("function");
    expect(result.handles.exaptation.getSignals()).toEqual([]);
  });

  test("exaptation middleware uses priority 465", () => {
    const result = createStack();

    const exaptation = result.middlewares.find((m) => m.name === "forge-exaptation-detector");
    expect(exaptation).toBeDefined();
    expect(exaptation?.priority).toBe(465);
  });

  test("accepts custom clock", () => {
    let _clockCalls = 0;
    const customClock = (): number => {
      _clockCalls += 1;
      return 1000;
    };

    const store = createInMemoryForgeStore();
    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      clock: customClock,
    });

    // Stack should be created successfully with custom clock
    expect(result.middlewares).toHaveLength(7);
  });

  test("returns feedbackLoop handle with health API", () => {
    const result = createStack();

    expect(result.handles.feedbackLoop).toBeDefined();
    expect(typeof result.handles.feedbackLoop.getHealthSnapshot).toBe("function");
    expect(typeof result.handles.feedbackLoop.getAllHealthSnapshots).toBe("function");
    expect(typeof result.handles.feedbackLoop.isQuarantined).toBe("function");
  });

  test("feedbackLoop handle returns undefined for unknown tools", () => {
    const result = createStack();

    expect(result.handles.feedbackLoop.getHealthSnapshot("unknown-tool")).toBeUndefined();
    expect(result.handles.feedbackLoop.isQuarantined("unknown-tool")).toBe(false);
    expect(result.handles.feedbackLoop.getAllHealthSnapshots()).toEqual([]);
  });

  test("passes forgeStore and resolveBrickId through to feedback-loop", () => {
    const store = createInMemoryForgeStore();
    const resolveCalls: string[] = [];
    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: (name: string) => {
        resolveCalls.push(name);
        return undefined;
      },
    });

    // The feedback-loop middleware should exist and be wired
    const feedbackLoop = result.middlewares.find((m) => m.name === "feedback-loop");
    expect(feedbackLoop).toBeDefined();
    expect(feedbackLoop?.priority).toBe(450);
  });

  test("accepts optional snapshotStore", () => {
    const store = createInMemoryForgeStore();
    const result = createForgeMiddlewareStack({
      forgeStore: store,
      forgeConfig: createDefaultForgeConfig(),
      scope: "agent",
      readTraces: emptyTraces,
      resolveBrickId: noopResolveBrickId,
      snapshotStore: {
        record: async () => ({ ok: true as const, value: undefined }),
        get: async () => ({
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "noop", retryable: false },
        }),
        list: async () => ({ ok: true as const, value: [] }),
        history: async () => ({ ok: true as const, value: [] }),
        latest: async () => ({
          ok: false as const,
          error: { code: "NOT_FOUND" as const, message: "noop", retryable: false },
        }),
      },
    });

    expect(result.middlewares).toHaveLength(7);
  });
});
