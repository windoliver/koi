import { describe, expect, mock, test } from "bun:test";
import type { GovernanceController, GovernanceSnapshot, SystemSignal } from "@koi/core";
import { createGovernanceSignalSource } from "./governance.js";
import { createSubscriptionController, matchesAnyPathFilter } from "./shared.js";

function createController(readings: GovernanceSnapshot["readings"]): GovernanceController {
  return {
    check: async () => ({ ok: true }),
    checkAll: async () => ({ ok: true }),
    record: async () => {},
    snapshot: async () => ({
      timestamp: 100,
      readings,
      healthy: true,
      violations: [],
    }),
    variables: () => new Map(),
    reading: (name) => readings.find((reading) => reading.name === name),
  };
}

describe("createGovernanceSignalSource", () => {
  test("emits only on threshold crossing", async () => {
    let current = 0.1;
    const controller = createController([
      { name: "error_rate", current, limit: 1, utilization: current },
    ]);
    controller.snapshot = async () => ({
      timestamp: 100,
      readings: [{ name: "error_rate", current, limit: 1, utilization: current }],
      healthy: true,
      violations: [],
    });

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 1, now: () => 100 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));

    await new Promise((resolve) => setTimeout(resolve, 5));
    current = 0.4;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen).toEqual([
      {
        kind: "governance",
        sensor: "error_rate",
        value: 0.4,
        limit: 0.3,
        direction: "above",
        emittedAt: 100,
      },
    ]);
  });

  test("replay emits an already-alerting threshold immediately", async () => {
    const controller = createController([
      { name: "context_occupancy", current: 0.92, limit: 1, utilization: 0.92 },
    ]);
    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "context_occupancy", limit: 0.8, direction: "above" }],
      { now: () => 200 },
    );

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal), { replay: true });
    await new Promise((resolve) => queueMicrotask(resolve));

    stop();
    expect(seen[0]).toEqual({
      kind: "governance",
      sensor: "context_occupancy",
      value: 0.92,
      limit: 0.8,
      direction: "above",
      emittedAt: 200,
    });
  });

  test("snapshot failures report to onError and do not throw", async () => {
    const err = new Error("boom");
    const controller = {
      ...createController([]),
      snapshot: async () => {
        throw err;
      },
    } satisfies GovernanceController;

    const source = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { pollIntervalMs: 1 },
    );

    const onError = mock(() => {});
    const stop = source.watch(() => {}, { onError });
    await new Promise((resolve) => setTimeout(resolve, 5));
    stop();

    expect(onError).toHaveBeenCalledWith(err);
  });
});

describe("shared helper coverage for focused governance run", () => {
  test("subscription controller reports closed after unsubscribe", () => {
    const controller = createSubscriptionController(() => {});

    expect(controller.closed).toBe(false);
    controller.unsubscribe();
    expect(controller.closed).toBe(true);
  });

  test("path filter helper supports wildcard and exact matching", () => {
    expect(matchesAnyPathFilter("/workspace/docs/a.md", ["/workspace/docs/*"])).toBe(
      true,
    );
    expect(matchesAnyPathFilter("/workspace/docs/a.md", ["/workspace/docs/a.md"])).toBe(
      true,
    );
    expect(matchesAnyPathFilter("/workspace/src/a.ts", ["/workspace/docs/*"])).toBe(
      false,
    );
  });
});
