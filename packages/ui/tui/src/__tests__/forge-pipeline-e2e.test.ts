/**
 * Forge pipeline E2E — real forge events through store to TUI view state.
 *
 * Creates realistic forge event sequences that mirror what the actual forge
 * middleware emits, feeds them through the TUI store, and verifies the view
 * state matches what the TUI would render (sparklines, badges, demand feed).
 *
 * This bridges the gap between the forge middleware tests (which verify event
 * emission) and the TUI unit tests (which verify rendering from state).
 */

import { describe, expect, test } from "bun:test";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import { relativeTime } from "../lib/relative-time.js";
import { computeTrend, sparkline } from "../lib/sparkline.js";
import { reduce } from "../state/store.js";
import { createInitialState, type TuiState } from "../state/types.js";
import { brickStatusConfig } from "../theme.js";
import type { ForgeViewState } from "../views/forge-view.js";

// ---------------------------------------------------------------------------
// Realistic event factories — mirror what the forge middleware actually emits
// ---------------------------------------------------------------------------

const BASE = createInitialState("http://localhost:3100");
let seq = 0;

function ts(minutesAgo: number): number {
  return Date.now() - minutesAgo * 60_000;
}

function forgeBrickForged(brickId: string, name: string, minutesAgo: number): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "brick_forged",
    brickId,
    name,
    origin: "crystallize",
    ngramKey: `${name.replace(/-/g, ">")}`,
    occurrences: 5 + (seq++ % 10),
    score: 0.7 + Math.random() * 0.2,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeBrickDemandForged(
  brickId: string,
  name: string,
  triggerKind: string,
  minutesAgo: number,
): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "brick_demand_forged",
    brickId,
    name,
    triggerId: `trigger-${seq++}`,
    triggerKind,
    confidence: 0.75 + Math.random() * 0.2,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeFitnessFlushed(
  brickId: string,
  successRate: number,
  sampleCount: number,
  minutesAgo: number,
): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "fitness_flushed",
    brickId,
    successRate,
    sampleCount,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeDemandDetected(triggerKind: string, minutesAgo: number): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "demand_detected",
    signalId: `sig-${seq++}`,
    triggerKind,
    confidence: 0.8,
    suggestedBrickKind: "tool",
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeBrickPromoted(
  brickId: string,
  fitness: number,
  minutesAgo: number,
): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "brick_promoted",
    brickId,
    fitnessOriginal: fitness,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeBrickDeprecated(
  brickId: string,
  fitness: number,
  reason: string,
  minutesAgo: number,
): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "brick_deprecated",
    brickId,
    fitnessOriginal: fitness,
    reason,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeBrickQuarantined(brickId: string, minutesAgo: number): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "brick_quarantined",
    brickId,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function forgeCrystallizeCandidate(suggestedName: string, minutesAgo: number): ForgeDashboardEvent {
  return {
    kind: "forge",
    subKind: "crystallize_candidate",
    ngramKey: suggestedName.replace(/-/g, ">"),
    occurrences: 4 + (seq++ % 8),
    suggestedName,
    score: 0.6 + Math.random() * 0.3,
    timestamp: ts(minutesAgo),
  } as ForgeDashboardEvent;
}

function monitorAnomaly(anomalyKind: string): MonitorDashboardEvent {
  return {
    kind: "monitor",
    subKind: "anomaly_detected",
    anomalyKind,
    agentId: "agent-1",
    sessionId: "session-1",
    detail: {},
    timestamp: Date.now(),
  };
}

function applyBatch(state: TuiState, events: readonly ForgeDashboardEvent[]): TuiState {
  return reduce(state, { kind: "apply_forge_batch", events });
}

/** Extract the forge view state slice (same shape the ForgeView component receives). */
function extractForgeViewState(state: TuiState): ForgeViewState {
  return {
    forgeBricks: state.forgeBricks,
    forgeSparklines: state.forgeSparklines,
    forgeEvents: state.forgeEvents,
    monitorEvents: state.monitorEvents,
    forgeSelectedBrickIndex: state.forgeSelectedBrickIndex,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1: Tool that consistently succeeds → gets promoted
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — successful tool lifecycle", () => {
  test("tool forged via crystallization, fitness improves, gets promoted", () => {
    // 1. Agent uses search>filter>rank pattern 5+ times → crystallize detects it
    let state = applyBatch(BASE, [forgeCrystallizeCandidate("search-filter-rank", 60)]);
    expect(state.forgeEvents).toHaveLength(1);

    // 2. Forge creates the brick
    state = applyBatch(state, [forgeBrickForged("brick-sfr-001", "search-filter-rank", 55)]);
    expect(state.forgeBricks["brick-sfr-001"]?.status).toBe("active");
    expect(state.forgeBricks["brick-sfr-001"]?.fitness).toBe(0);

    // 3. Tool is called successfully — fitness flushes over time
    const fitnessHistory = [0.6, 0.7, 0.75, 0.82, 0.88, 0.91, 0.94, 0.96];
    for (let i = 0; i < fitnessHistory.length; i++) {
      state = applyBatch(state, [
        forgeFitnessFlushed("brick-sfr-001", fitnessHistory[i]!, 10 * (i + 1), 50 - i * 5),
      ]);
    }

    // Verify sparkline accumulated
    const sparkData = state.forgeSparklines["brick-sfr-001"] ?? [];
    expect(sparkData).toEqual(fitnessHistory);
    expect(computeTrend(sparkData)).toBe("rising");
    expect(sparkline(sparkData)).toHaveLength(8);

    // 4. Promoted after sustained success
    state = applyBatch(state, [forgeBrickPromoted("brick-sfr-001", 0.96, 5)]);
    expect(state.forgeBricks["brick-sfr-001"]?.status).toBe("promoted");

    // Verify badge renders correctly
    const badge = brickStatusConfig(state.forgeBricks["brick-sfr-001"]?.status ?? "unknown");
    expect(badge.label).toContain("✓");
    expect(badge.color).toBe("#FAF3DE");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Tool that fails → gets quarantined
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — failing tool lifecycle", () => {
  test("tool with declining fitness gets deprecated then quarantined", () => {
    // 1. Demand signal: agent hits capability gap
    let state = applyBatch(BASE, [forgeDemandDetected("capability_gap", 120)]);

    // 2. Forge creates brick from demand
    state = applyBatch(state, [
      forgeBrickDemandForged("brick-gap-001", "data-validator", "capability_gap", 115),
    ]);
    expect(state.forgeBricks["brick-gap-001"]?.status).toBe("active");

    // 3. Tool starts failing — fitness declines
    const decliningFitness = [0.8, 0.7, 0.55, 0.4, 0.3, 0.2, 0.15];
    for (let i = 0; i < decliningFitness.length; i++) {
      state = applyBatch(state, [
        forgeFitnessFlushed("brick-gap-001", decliningFitness[i]!, 5 * (i + 1), 100 - i * 10),
      ]);
    }

    // Verify declining trend
    const sparkData = state.forgeSparklines["brick-gap-001"] ?? [];
    expect(computeTrend(sparkData)).toBe("declining");

    // 4. Deprecated due to low fitness
    state = applyBatch(state, [
      forgeBrickDeprecated("brick-gap-001", 0.15, "sustained error rate > 30%", 20),
    ]);
    expect(state.forgeBricks["brick-gap-001"]?.status).toBe("deprecated");

    const deprecatedBadge = brickStatusConfig("deprecated");
    expect(deprecatedBadge.label).toContain("▼");
    expect(deprecatedBadge.color).toBe("#EAB308");

    // 5. Quarantined after continued failures
    state = applyBatch(state, [forgeBrickQuarantined("brick-gap-001", 10)]);
    expect(state.forgeBricks["brick-gap-001"]?.status).toBe("quarantined");

    const quarantinedBadge = brickStatusConfig("quarantined");
    expect(quarantinedBadge.label).toContain("✕");
    expect(quarantinedBadge.color).toBe("#EF4444");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Mixed fleet — multiple bricks at different lifecycle stages
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — multi-brick fleet", () => {
  test("fleet with active, promoted, deprecated, and quarantined bricks", () => {
    let state = BASE;

    // Create 4 bricks
    state = applyBatch(state, [
      forgeBrickForged("b-active", "csv-analyzer", 200),
      forgeBrickForged("b-promoted", "api-search", 300),
      forgeBrickForged("b-deprecated", "old-parser", 400),
      forgeBrickForged("b-quarantined", "broken-tool", 500),
    ]);
    expect(Object.keys(state.forgeBricks)).toHaveLength(4);

    // Apply fitness to each
    state = applyBatch(state, [
      forgeFitnessFlushed("b-active", 0.85, 20, 100),
      forgeFitnessFlushed("b-promoted", 0.95, 50, 100),
      forgeFitnessFlushed("b-deprecated", 0.3, 15, 100),
      forgeFitnessFlushed("b-quarantined", 0.05, 30, 100),
    ]);

    // Transition lifecycle states
    state = applyBatch(state, [
      forgeBrickPromoted("b-promoted", 0.95, 50),
      forgeBrickDeprecated("b-deprecated", 0.3, "low fitness", 40),
      forgeBrickQuarantined("b-quarantined", 30),
    ]);

    // Verify each brick's state
    expect(state.forgeBricks["b-active"]?.status).toBe("active");
    expect(state.forgeBricks["b-promoted"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-deprecated"]?.status).toBe("deprecated");
    expect(state.forgeBricks["b-quarantined"]?.status).toBe("quarantined");

    // Verify view state counters
    const viewState = extractForgeViewState(state);
    const entries = Object.entries(viewState.forgeBricks);
    const promotedCount = entries.filter(([, b]) => b.status === "promoted").length;
    expect(promotedCount).toBe(1);

    // Verify all badges render
    for (const [, brick] of entries) {
      const badge = brickStatusConfig(brick.status);
      expect(badge.label.length).toBeGreaterThan(0);
      expect(badge.color.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Demand feed with mixed events + timestamps
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — demand feed rendering", () => {
  test("feed shows correct event types with relative timestamps", () => {
    const now = Date.now();
    const state = applyBatch(BASE, [
      {
        ...forgeDemandDetected("tool_missing", 120),
        timestamp: now - 7_200_000,
      } as ForgeDashboardEvent,
      {
        ...forgeBrickForged("b-1", "new-tool", 60),
        timestamp: now - 3_600_000,
      } as ForgeDashboardEvent,
      {
        ...forgeFitnessFlushed("b-1", 0.8, 10, 30),
        timestamp: now - 1_800_000,
      } as ForgeDashboardEvent,
      {
        ...forgeCrystallizeCandidate("yaml-linter", 5),
        timestamp: now - 300_000,
      } as ForgeDashboardEvent,
    ]);

    expect(state.forgeEvents).toHaveLength(4);

    // Verify relative time formatting for each event
    expect(relativeTime(state.forgeEvents[0]?.timestamp ?? 0, now)).toBe("2h ago");
    expect(relativeTime(state.forgeEvents[1]?.timestamp ?? 0, now)).toBe("1h ago");
    expect(relativeTime(state.forgeEvents[2]?.timestamp ?? 0, now)).toBe("30m ago");
    expect(relativeTime(state.forgeEvents[3]?.timestamp ?? 0, now)).toBe("5m ago");

    // Verify demand count
    const demands = state.forgeEvents.filter((e) => e.subKind === "demand_detected");
    expect(demands).toHaveLength(1);

    // Last 5 events (reversed for feed display)
    const feedEvents = state.forgeEvents.slice(-5).reverse();
    expect(feedEvents[0]?.subKind).toBe("crystallize_candidate");
    expect(feedEvents[3]?.subKind).toBe("demand_detected");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Hydrate from REST + live SSE merge
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — REST hydration + SSE merge", () => {
  test("hydrated bricks receive live fitness updates via SSE", () => {
    // Step 1: REST hydration (simulates what happens on TUI connect)
    let state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [
        { brickId: "b-1", name: "search-refine", status: "active", fitness: 0.85 },
        { brickId: "b-2", name: "code-explain", status: "promoted", fitness: 0.95 },
      ],
      events: [
        forgeBrickForged("b-1", "search-refine", 120),
        forgeBrickForged("b-2", "code-explain", 180),
      ],
    });

    expect(Object.keys(state.forgeBricks)).toHaveLength(2);
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.85);
    expect(state.forgeEvents).toHaveLength(2);

    // Step 2: Live SSE events arrive — fitness updates
    state = applyBatch(state, [
      forgeFitnessFlushed("b-1", 0.88, 30, 5),
      forgeFitnessFlushed("b-1", 0.91, 35, 3),
      forgeFitnessFlushed("b-1", 0.93, 40, 1),
    ]);

    // Fitness updated, sparkline has 3 new points
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.93);
    expect(state.forgeSparklines["b-1"]).toEqual([0.88, 0.91, 0.93]);
    expect(computeTrend(state.forgeSparklines["b-1"]!)).toBe("rising");

    // Events accumulated (2 from hydration + 3 from SSE)
    expect(state.forgeEvents).toHaveLength(5);
  });

  test("SSE promotion overrides hydrated status", () => {
    let state = reduce(BASE, {
      kind: "hydrate_forge",
      bricks: [{ brickId: "b-1", name: "tool-a", status: "active", fitness: 0.9 }],
      events: [],
    });
    expect(state.forgeBricks["b-1"]?.status).toBe("active");

    // SSE delivers promotion event
    state = applyBatch(state, [forgeBrickPromoted("b-1", 0.95, 1)]);
    expect(state.forgeBricks["b-1"]?.status).toBe("promoted");
    expect(state.forgeBricks["b-1"]?.fitness).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Monitor anomalies alongside forge events
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — monitor anomalies", () => {
  test("anomaly events tracked alongside forge bricks", () => {
    let state = applyBatch(BASE, [forgeBrickForged("b-1", "my-tool", 30)]);

    // Monitor detects anomaly
    state = reduce(state, {
      kind: "apply_monitor_event",
      event: monitorAnomaly("error_spike"),
    });
    state = reduce(state, {
      kind: "apply_monitor_event",
      event: monitorAnomaly("latency_spike"),
    });

    const viewState = extractForgeViewState(state);
    expect(Object.keys(viewState.forgeBricks)).toHaveLength(1);
    expect(viewState.monitorEvents).toHaveLength(2);

    // Summary bar would show: "Anomalies: 2"
    const anomalyCount = viewState.monitorEvents.length;
    expect(anomalyCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Edge cases
// ---------------------------------------------------------------------------

describe("forge pipeline E2E — edge cases", () => {
  test("fitness flush for unknown brick creates sparkline entry only", () => {
    const state = applyBatch(BASE, [forgeFitnessFlushed("unknown-brick", 0.75, 10, 5)]);
    // No brick entry (fitness_flushed only updates existing bricks)
    expect(state.forgeBricks["unknown-brick"]).toBeUndefined();
    // But sparkline IS created (store.ts line 887-888 doesn't guard on brick existence)
    expect(state.forgeSparklines["unknown-brick"]).toEqual([0.75]);
  });

  test("rapid fitness flushes respect sparkline cap (50 points)", () => {
    let state = applyBatch(BASE, [forgeBrickForged("b-1", "tool", 100)]);

    // Send 60 fitness events
    for (let i = 0; i < 60; i++) {
      state = applyBatch(state, [forgeFitnessFlushed("b-1", 0.5 + (i % 10) * 0.05, i + 1, 60 - i)]);
    }

    expect(state.forgeSparklines["b-1"]!).toHaveLength(50);
    // Should keep last 50 (indices 10-59)
    expect(state.forgeSparklines["b-1"]?.[0]).toBe(0.5 + (10 % 10) * 0.05);
  });

  test("event buffer caps at 200", () => {
    let state = BASE;
    const events: ForgeDashboardEvent[] = [];
    for (let i = 0; i < 210; i++) {
      events.push(forgeDemandDetected("test", i));
    }
    state = applyBatch(state, events);
    expect(state.forgeEvents).toHaveLength(200);
  });

  test("empty batch leaves state unchanged", () => {
    const before = applyBatch(BASE, [forgeBrickForged("b-1", "tool", 10)]);
    const after = applyBatch(before, []);
    expect(after.forgeBricks).toBe(before.forgeBricks);
  });
});
