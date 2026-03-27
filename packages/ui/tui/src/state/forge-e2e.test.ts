/**
 * Forge E2E tests — exercises the full forge data pipeline:
 * SSE events → store reducer → sparkline/trend computation → view state.
 *
 * Tests brick lifecycle, fitness tracking, sparkline generation,
 * trend detection, demand feed ordering, hydration from REST API,
 * and edge cases like buffer overflow and empty state transitions.
 */

import { describe, expect, test } from "bun:test";
import type { ForgeDashboardEvent } from "@koi/dashboard-types";
import { relativeTime } from "../lib/relative-time.js";
import { computeTrend, sparkline } from "../lib/sparkline.js";
import { brickStatusConfig } from "../theme.js";
import { reduce } from "./store.js";
import { createInitialState, type TuiState } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE = createInitialState("http://localhost:3100");

function forgeEvent(subKind: string, extra: Record<string, unknown> = {}): ForgeDashboardEvent {
  return { kind: "forge", subKind, timestamp: Date.now(), ...extra } as ForgeDashboardEvent;
}

function applyBatch(state: TuiState, events: readonly ForgeDashboardEvent[]): TuiState {
  return reduce(state, { kind: "apply_forge_batch", events });
}

function forgeBrick(state: TuiState, brickId: string, name: string): TuiState {
  return applyBatch(state, [
    forgeEvent("brick_forged", {
      brickId,
      name,
      origin: "crystallize",
      ngramKey: "a>b",
      occurrences: 5,
      score: 0.9,
    }),
  ]);
}

function flushFitness(state: TuiState, brickId: string, successRate: number): TuiState {
  return applyBatch(state, [
    forgeEvent("fitness_flushed", { brickId, successRate, sampleCount: 10 }),
  ]);
}

// ---------------------------------------------------------------------------
// 1. Brick lifecycle through SSE events
// ---------------------------------------------------------------------------

describe("forge E2E — brick lifecycle", () => {
  test("brick_forged creates active brick with zero fitness", () => {
    const state = forgeBrick(BASE, "b-1", "search-refine");
    expect(state.forgeBricks["b-1"]).toEqual({
      name: "search-refine",
      status: "active",
      fitness: 0,
    });
  });

  test("brick_demand_forged creates active brick", () => {
    const state = applyBatch(BASE, [
      forgeEvent("brick_demand_forged", {
        brickId: "b-2",
        name: "gap-filler",
        triggerId: "t-1",
        triggerKind: "capability_gap",
        confidence: 0.8,
      }),
    ]);
    expect(state.forgeBricks["b-2"]?.status).toBe("active");
    expect(state.forgeBricks["b-2"]?.name).toBe("gap-filler");
  });

  test("brick_promoted transitions status and sets fitness", () => {
    let state = forgeBrick(BASE, "b-1", "tool");
    state = applyBatch(state, [
      forgeEvent("brick_promoted", { brickId: "b-1", fitnessOriginal: 0.95 }),
    ]);
    expect(state.forgeBricks["b-1"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.95);
  });

  test("brick_deprecated transitions status and sets fitness", () => {
    let state = forgeBrick(BASE, "b-1", "tool");
    state = applyBatch(state, [
      forgeEvent("brick_deprecated", {
        brickId: "b-1",
        reason: "low performance",
        fitnessOriginal: 0.2,
      }),
    ]);
    expect(state.forgeBricks["b-1"]?.status).toBe("deprecated");
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.2);
  });

  test("brick_quarantined transitions status", () => {
    let state = forgeBrick(BASE, "b-1", "tool");
    state = applyBatch(state, [forgeEvent("brick_quarantined", { brickId: "b-1" })]);
    expect(state.forgeBricks["b-1"]?.status).toBe("quarantined");
  });

  test("full lifecycle: forged → fitness → promoted", () => {
    let state = forgeBrick(BASE, "b-1", "my-tool");
    expect(state.forgeBricks["b-1"]?.status).toBe("active");

    state = flushFitness(state, "b-1", 0.85);
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.85);

    state = flushFitness(state, "b-1", 0.92);
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.92);

    state = applyBatch(state, [
      forgeEvent("brick_promoted", { brickId: "b-1", fitnessOriginal: 0.92 }),
    ]);
    expect(state.forgeBricks["b-1"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.92);
  });

  test("full lifecycle: forged → fitness decline → deprecated → quarantined", () => {
    let state = forgeBrick(BASE, "b-1", "declining-tool");

    state = flushFitness(state, "b-1", 0.7);
    state = flushFitness(state, "b-1", 0.5);
    state = flushFitness(state, "b-1", 0.3);

    state = applyBatch(state, [
      forgeEvent("brick_deprecated", {
        brickId: "b-1",
        reason: "below threshold",
        fitnessOriginal: 0.3,
      }),
    ]);
    expect(state.forgeBricks["b-1"]?.status).toBe("deprecated");

    state = applyBatch(state, [forgeEvent("brick_quarantined", { brickId: "b-1" })]);
    expect(state.forgeBricks["b-1"]?.status).toBe("quarantined");
  });

  test("events for unknown brick are silently ignored", () => {
    const state = applyBatch(BASE, [
      forgeEvent("brick_promoted", { brickId: "nonexistent", fitnessOriginal: 0.9 }),
    ]);
    expect(state.forgeBricks.nonexistent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Sparkline accumulation + trend detection
// ---------------------------------------------------------------------------

describe("forge E2E — sparklines and trends", () => {
  test("fitness_flushed events build sparkline array", () => {
    let state = forgeBrick(BASE, "b-1", "tool");
    state = flushFitness(state, "b-1", 0.6);
    state = flushFitness(state, "b-1", 0.75);
    state = flushFitness(state, "b-1", 0.85);
    state = flushFitness(state, "b-1", 0.92);

    expect(state.forgeSparklines["b-1"]).toEqual([0.6, 0.75, 0.85, 0.92]);
  });

  test("sparkline renders correct characters for rising fitness", () => {
    const values = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const result = sparkline(values);
    expect(result).toHaveLength(7);
    // First char should be lower than last char
    expect(result[0]).toBe("▁");
    expect(result[6]).toBe("█");
  });

  test("computeTrend detects rising trend from fitness history", () => {
    const values = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    expect(computeTrend(values)).toBe("rising");
  });

  test("computeTrend detects declining trend from fitness history", () => {
    const values = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
    expect(computeTrend(values)).toBe("declining");
  });

  test("computeTrend returns flat for stable fitness", () => {
    const values = [0.85, 0.85, 0.85, 0.85];
    expect(computeTrend(values)).toBe("flat");
  });

  test("sparkline caps at 50 data points", () => {
    let state = forgeBrick(BASE, "b-1", "tool");
    for (let i = 0; i < 60; i++) {
      state = flushFitness(state, "b-1", 0.5 + (i % 10) * 0.05);
    }
    expect(state.forgeSparklines["b-1"]).toHaveLength(50);
  });

  test("sparkline for brick with no fitness data returns empty string", () => {
    expect(sparkline([])).toBe("");
  });

  test("end-to-end: fitness events → sparkline → trend", () => {
    let state = forgeBrick(BASE, "b-1", "improving-tool");
    const fitnessValues = [0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 0.95];
    for (const v of fitnessValues) {
      state = flushFitness(state, "b-1", v);
    }

    const data = state.forgeSparklines["b-1"] ?? [];
    expect(data).toEqual(fitnessValues);
    expect(computeTrend(data)).toBe("rising");
    expect(sparkline(data)).toHaveLength(fitnessValues.length);
  });
});

// ---------------------------------------------------------------------------
// 3. Status badges
// ---------------------------------------------------------------------------

describe("forge E2E — status badges", () => {
  test("active brick gets green badge with dot symbol", () => {
    const badge = brickStatusConfig("active");
    expect(badge.label).toContain("●");
    expect(badge.label).toContain("active");
    expect(badge.color).toBe("#22C55E"); // green
  });

  test("promoted brick gets cream badge with checkmark", () => {
    const badge = brickStatusConfig("promoted");
    expect(badge.label).toContain("✓");
    expect(badge.color).toBe("#FAF3DE"); // accent/cream
  });

  test("deprecated brick gets yellow badge with down arrow", () => {
    const badge = brickStatusConfig("deprecated");
    expect(badge.label).toContain("▼");
    expect(badge.color).toBe("#EAB308"); // yellow
  });

  test("quarantined brick gets red badge with x", () => {
    const badge = brickStatusConfig("quarantined");
    expect(badge.label).toContain("✕");
    expect(badge.color).toBe("#EF4444"); // red
  });

  test("unknown status gets dim fallback badge", () => {
    const badge = brickStatusConfig("some-future-status");
    expect(badge.label).toContain("○");
    expect(badge.color).toBe("#8899AA"); // dim
  });
});

// ---------------------------------------------------------------------------
// 4. Demand feed and event ordering
// ---------------------------------------------------------------------------

describe("forge E2E — demand feed", () => {
  test("events accumulate in order", () => {
    const now = Date.now();
    const state = applyBatch(BASE, [
      forgeEvent("demand_detected", {
        signalId: "s-1",
        triggerKind: "capability_gap",
        confidence: 0.8,
        suggestedBrickKind: "tool",
        timestamp: now - 3000,
      }),
      forgeEvent("brick_forged", {
        brickId: "b-1",
        name: "new-tool",
        origin: "crystallize",
        ngramKey: "x>y",
        occurrences: 3,
        score: 0.7,
        timestamp: now - 2000,
      }),
      forgeEvent("crystallize_candidate", {
        ngramKey: "a>b>c",
        occurrences: 5,
        suggestedName: "abc-pipeline",
        score: 0.6,
        timestamp: now - 1000,
      }),
    ]);

    expect(state.forgeEvents).toHaveLength(3);
    expect(state.forgeEvents[0]?.subKind).toBe("demand_detected");
    expect(state.forgeEvents[1]?.subKind).toBe("brick_forged");
    expect(state.forgeEvents[2]?.subKind).toBe("crystallize_candidate");
  });

  test("demand count is computable from events", () => {
    const state = applyBatch(BASE, [
      forgeEvent("demand_detected", {
        signalId: "s-1",
        triggerKind: "capability_gap",
        confidence: 0.8,
        suggestedBrickKind: "tool",
      }),
      forgeEvent("demand_detected", {
        signalId: "s-2",
        triggerKind: "tool_missing",
        confidence: 0.6,
        suggestedBrickKind: "tool",
      }),
      forgeEvent("brick_forged", {
        brickId: "b-1",
        name: "tool",
        origin: "crystallize",
        ngramKey: "x",
        occurrences: 1,
        score: 0.5,
      }),
    ]);

    const demandCount = state.forgeEvents.filter((e) => e.subKind === "demand_detected").length;
    expect(demandCount).toBe(2);
  });

  test("relative time formatting for demand feed timestamps", () => {
    const now = Date.now();
    expect(relativeTime(now - 30_000, now)).toBe("just now");
    expect(relativeTime(now - 120_000, now)).toBe("2m ago");
    expect(relativeTime(now - 3_600_000, now)).toBe("1h ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("1d ago");
  });
});

// ---------------------------------------------------------------------------
// 5. hydrate_forge — REST API initial load
// ---------------------------------------------------------------------------

describe("forge E2E — hydrate_forge", () => {
  test("hydrates bricks from REST API response", () => {
    const state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [
        { brickId: "b-1", name: "search-refine", status: "active", fitness: 0.92 },
        { brickId: "b-2", name: "code-explain", status: "promoted", fitness: 0.95 },
        { brickId: "b-3", name: "data-validate", status: "deprecated", fitness: 0.31 },
      ],
      events: [],
    });

    expect(Object.keys(state.forgeBricks)).toHaveLength(3);
    expect(state.forgeBricks["b-1"]?.name).toBe("search-refine");
    expect(state.forgeBricks["b-1"]?.status).toBe("active");
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.92);
    expect(state.forgeBricks["b-2"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-3"]?.status).toBe("deprecated");
  });

  test("hydrates events from REST API response", () => {
    const events: ForgeDashboardEvent[] = [
      forgeEvent("demand_detected", {
        signalId: "s-1",
        triggerKind: "capability_gap",
        confidence: 0.78,
        suggestedBrickKind: "tool",
      }),
      forgeEvent("brick_forged", {
        brickId: "b-1",
        name: "search-refine",
        origin: "crystallize",
        ngramKey: "search>filter>refine",
        occurrences: 12,
        score: 0.87,
      }),
    ];

    const state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [],
      events,
    });

    expect(state.forgeEvents).toHaveLength(2);
    expect(state.forgeEvents[0]?.subKind).toBe("demand_detected");
  });

  test("SSE events merge on top of hydrated state", () => {
    // First: hydrate from REST
    let state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [{ brickId: "b-1", name: "search-refine", status: "active", fitness: 0.92 }],
      events: [],
    });
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.92);

    // Then: SSE fitness update arrives
    state = flushFitness(state, "b-1", 0.95);
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.95);
    expect(state.forgeSparklines["b-1"]).toEqual([0.95]);
  });

  test("hydrate with empty data is a no-op", () => {
    const state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [],
      events: [],
    });
    // hydrate_forge always sets forgeBricks/forgeEvents, even if empty
    expect(state.forgeBricks).toEqual({});
    expect(state.forgeEvents).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple bricks interleaved
// ---------------------------------------------------------------------------

describe("forge E2E — multi-brick scenarios", () => {
  test("multiple bricks tracked independently", () => {
    let state = forgeBrick(BASE, "b-1", "tool-a");
    state = forgeBrick(state, "b-2", "tool-b");

    state = flushFitness(state, "b-1", 0.9);
    state = flushFitness(state, "b-2", 0.4);
    state = flushFitness(state, "b-1", 0.95);
    state = flushFitness(state, "b-2", 0.3);

    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.95);
    expect(state.forgeBricks["b-2"]?.fitness).toBe(0.3);
    expect(state.forgeSparklines["b-1"]).toEqual([0.9, 0.95]);
    expect(state.forgeSparklines["b-2"]).toEqual([0.4, 0.3]);

    expect(computeTrend(state.forgeSparklines["b-1"] ?? [])).toBe("rising");
    expect(computeTrend(state.forgeSparklines["b-2"] ?? [])).toBe("declining");
  });

  test("promoted count computable from brick statuses", () => {
    let state = forgeBrick(BASE, "b-1", "tool-a");
    state = forgeBrick(state, "b-2", "tool-b");
    state = forgeBrick(state, "b-3", "tool-c");

    state = applyBatch(state, [
      forgeEvent("brick_promoted", { brickId: "b-1", fitnessOriginal: 0.95 }),
      forgeEvent("brick_promoted", { brickId: "b-3", fitnessOriginal: 0.88 }),
    ]);

    const promotedCount = Object.values(state.forgeBricks).filter(
      (b) => b.status === "promoted",
    ).length;
    expect(promotedCount).toBe(2);
  });

  test("batch of mixed events processes correctly", () => {
    const state = applyBatch(BASE, [
      forgeEvent("brick_forged", {
        brickId: "b-1",
        name: "alpha",
        origin: "crystallize",
        ngramKey: "x",
        occurrences: 3,
        score: 0.7,
      }),
      forgeEvent("brick_demand_forged", {
        brickId: "b-2",
        name: "beta",
        triggerId: "t-1",
        triggerKind: "tool_missing",
        confidence: 0.6,
      }),
      forgeEvent("fitness_flushed", { brickId: "b-1", successRate: 0.8, sampleCount: 20 }),
      forgeEvent("demand_detected", {
        signalId: "s-1",
        triggerKind: "capability_gap",
        confidence: 0.9,
        suggestedBrickKind: "tool",
      }),
      forgeEvent("brick_promoted", { brickId: "b-1", fitnessOriginal: 0.8 }),
    ]);

    expect(Object.keys(state.forgeBricks)).toHaveLength(2);
    expect(state.forgeBricks["b-1"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-2"]?.status).toBe("active");
    expect(state.forgeSparklines["b-1"]).toEqual([0.8]);
    expect(state.forgeEvents).toHaveLength(5);
  });
});
