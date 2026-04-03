import { beforeEach, describe, expect, test } from "bun:test";
import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import { useForgeStore } from "./forge-store.js";

const NOW = 1_000_000;

function forgeEvent(subKind: string, extra: Record<string, unknown> = {}): ForgeDashboardEvent {
  return { kind: "forge", subKind, timestamp: NOW, ...extra } as ForgeDashboardEvent;
}

function brickForged(brickId: string, name: string): ForgeDashboardEvent {
  return forgeEvent("brick_forged", {
    brickId,
    name,
    origin: "crystallize",
    ngramKey: "a>b",
    occurrences: 5,
    score: 0.9,
  });
}

function fitnessEvent(brickId: string, successRate: number): ForgeDashboardEvent {
  return forgeEvent("fitness_flushed", { brickId, successRate, sampleCount: 100 });
}

function monitorEvent(): MonitorDashboardEvent {
  return {
    kind: "monitor",
    subKind: "anomaly_detected",
    anomalyKind: "error_spike",
    agentId: "a-1",
    sessionId: "s-1",
    detail: {},
    timestamp: NOW,
  };
}

describe("ForgeStore", () => {
  beforeEach(() => {
    // Reset store to initial state
    useForgeStore.setState({
      bricks: {},
      recentEvents: [],
      recentMonitorEvents: [],
      sparklineData: {},
      demandCount: 0,
      crystallizeCount: 0,
    });
  });

  describe("empty state", () => {
    test("initial state has empty buffer, empty bricks, zero counters", () => {
      const state = useForgeStore.getState();
      expect(state.recentEvents).toHaveLength(0);
      expect(state.recentMonitorEvents).toHaveLength(0);
      expect(Object.keys(state.bricks)).toHaveLength(0);
      expect(state.demandCount).toBe(0);
      expect(state.crystallizeCount).toBe(0);
      expect(Object.keys(state.sparklineData)).toHaveLength(0);
    });
  });

  describe("applyBatch", () => {
    test("brick_forged creates brick in snapshot", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "my-tool")]);
      const state = useForgeStore.getState();
      expect(state.bricks["b-1"]).toBeDefined();
      expect(state.bricks["b-1"]?.name).toBe("my-tool");
      expect(state.bricks["b-1"]?.status).toBe("active");
      expect(state.recentEvents).toHaveLength(1);
    });

    test("brick_demand_forged creates brick in snapshot", () => {
      useForgeStore.getState().applyBatch([
        forgeEvent("brick_demand_forged", {
          brickId: "b-2",
          name: "search-tool",
          triggerId: "sig-1",
          triggerKind: "capability_gap",
          confidence: 0.8,
        }),
      ]);
      expect(useForgeStore.getState().bricks["b-2"]?.name).toBe("search-tool");
    });

    test("brick_deprecated updates status", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      useForgeStore.getState().applyBatch([
        forgeEvent("brick_deprecated", {
          brickId: "b-1",
          reason: "Low fitness",
          fitnessOriginal: 0.3,
        }),
      ]);
      expect(useForgeStore.getState().bricks["b-1"]?.status).toBe("deprecated");
    });

    test("brick_promoted updates status", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      useForgeStore
        .getState()
        .applyBatch([forgeEvent("brick_promoted", { brickId: "b-1", fitnessOriginal: 0.95 })]);
      expect(useForgeStore.getState().bricks["b-1"]?.status).toBe("promoted");
    });

    test("brick_quarantined updates status", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      useForgeStore.getState().applyBatch([forgeEvent("brick_quarantined", { brickId: "b-1" })]);
      expect(useForgeStore.getState().bricks["b-1"]?.status).toBe("quarantined");
    });

    test("fitness_flushed updates sparklineData", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      useForgeStore.getState().applyBatch([fitnessEvent("b-1", 0.8)]);
      useForgeStore.getState().applyBatch([fitnessEvent("b-1", 0.9)]);
      const sparkline = useForgeStore.getState().sparklineData["b-1"];
      expect(sparkline).toEqual([0.8, 0.9]);
    });

    test("demand_detected increments demand counter", () => {
      useForgeStore.getState().applyBatch([
        forgeEvent("demand_detected", {
          signalId: "sig-1",
          triggerKind: "capability_gap",
          confidence: 0.85,
          suggestedBrickKind: "tool",
        }),
      ]);
      expect(useForgeStore.getState().demandCount).toBe(1);
    });

    test("crystallize_candidate increments crystallize counter", () => {
      useForgeStore.getState().applyBatch([
        forgeEvent("crystallize_candidate", {
          ngramKey: "a>b",
          occurrences: 5,
          suggestedName: "combo",
          score: 0.9,
        }),
      ]);
      expect(useForgeStore.getState().crystallizeCount).toBe(1);
    });

    test("empty batch is a no-op", () => {
      const before = useForgeStore.getState();
      useForgeStore.getState().applyBatch([]);
      const after = useForgeStore.getState();
      expect(after).toBe(before);
    });
  });

  describe("overflow eviction", () => {
    test("buffer caps at 500 events, oldest evicted", () => {
      const events: ForgeDashboardEvent[] = [];
      for (let i = 0; i < 501; i++) {
        events.push(
          forgeEvent("demand_detected", {
            signalId: `sig-${String(i)}`,
            triggerKind: "capability_gap",
            confidence: 0.5,
            suggestedBrickKind: "tool",
          }),
        );
      }
      useForgeStore.getState().applyBatch(events);
      expect(useForgeStore.getState().recentEvents).toHaveLength(500);
    });
  });

  describe("reconnect reset", () => {
    test("resetBuffer clears all forge state (no REST rehydration path)", () => {
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      useForgeStore.getState().applyMonitorEvent(monitorEvent());
      useForgeStore.getState().resetBuffer();
      const state = useForgeStore.getState();
      expect(state.recentEvents).toHaveLength(0);
      expect(state.recentMonitorEvents).toHaveLength(0);
      expect(Object.keys(state.bricks)).toHaveLength(0);
      expect(Object.keys(state.sparklineData)).toHaveLength(0);
      expect(state.demandCount).toBe(0);
      expect(state.crystallizeCount).toBe(0);
    });
  });

  describe("duplicate tolerance", () => {
    test("same event applied twice results in both in buffer", () => {
      const event = brickForged("b-1", "tool");
      useForgeStore.getState().applyBatch([event]);
      useForgeStore.getState().applyBatch([event]);
      expect(useForgeStore.getState().recentEvents).toHaveLength(2);
    });
  });

  describe("event ordering", () => {
    test("batch preserves insertion order", () => {
      const e1 = forgeEvent("demand_detected", {
        signalId: "sig-1",
        triggerKind: "a",
        confidence: 0.5,
        suggestedBrickKind: "tool",
        timestamp: 300,
      }) as ForgeDashboardEvent;
      const e2 = forgeEvent("demand_detected", {
        signalId: "sig-2",
        triggerKind: "b",
        confidence: 0.5,
        suggestedBrickKind: "tool",
        timestamp: 100,
      }) as ForgeDashboardEvent;
      useForgeStore.getState().applyBatch([e1, e2]);
      const events = useForgeStore.getState().recentEvents;
      const firstEvent = events[0] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "demand_detected" }
      >;
      const secondEvent = events[1] as Extract<
        ForgeDashboardEvent,
        { readonly subKind: "demand_detected" }
      >;
      expect(firstEvent.signalId).toBe("sig-1");
      expect(secondEvent.signalId).toBe("sig-2");
    });
  });

  describe("snapshot+buffer consistency", () => {
    test("after overflow, snapshot still reflects all events", () => {
      // Create a brick, then overflow the buffer
      useForgeStore.getState().applyBatch([brickForged("b-1", "tool")]);
      const fillerEvents: ForgeDashboardEvent[] = [];
      for (let i = 0; i < 500; i++) {
        fillerEvents.push(
          forgeEvent("demand_detected", {
            signalId: `sig-${String(i)}`,
            triggerKind: "capability_gap",
            confidence: 0.5,
            suggestedBrickKind: "tool",
          }),
        );
      }
      useForgeStore.getState().applyBatch(fillerEvents);
      // Brick should still be in snapshot even though its event was evicted
      expect(useForgeStore.getState().bricks["b-1"]).toBeDefined();
      expect(useForgeStore.getState().bricks["b-1"]?.name).toBe("tool");
    });
  });

  describe("applyMonitorEvent", () => {
    test("appends monitor event to buffer", () => {
      useForgeStore.getState().applyMonitorEvent(monitorEvent());
      expect(useForgeStore.getState().recentMonitorEvents).toHaveLength(1);
    });

    test("caps monitor buffer at 100", () => {
      for (let i = 0; i < 101; i++) {
        useForgeStore.getState().applyMonitorEvent(monitorEvent());
      }
      expect(useForgeStore.getState().recentMonitorEvents).toHaveLength(100);
    });
  });
});
