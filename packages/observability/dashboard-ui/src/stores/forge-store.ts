/**
 * Zustand store for forge self-improvement observability.
 *
 * Maintains a rolling event buffer, brick snapshot map, sparkline data,
 * and aggregate counters. All mutations go through applyBatch for
 * single-render batch updates (Decision 14A).
 */

import type { ForgeDashboardEvent, MonitorDashboardEvent } from "@koi/dashboard-types";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BUFFER_SIZE = 500;
const MAX_SPARKLINE_POINTS = 50;
const MAX_MONITOR_BUFFER = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrickSummary {
  readonly brickId: string;
  readonly name: string;
  readonly status: "active" | "deprecated" | "promoted" | "quarantined";
  readonly lastFitness: number;
  readonly lastUpdatedAt: number;
}

interface ForgeState {
  readonly bricks: Readonly<Record<string, BrickSummary>>;
  readonly recentEvents: readonly ForgeDashboardEvent[];
  readonly recentMonitorEvents: readonly MonitorDashboardEvent[];
  readonly sparklineData: Readonly<Record<string, readonly number[]>>;
  readonly demandCount: number;
  readonly crystallizeCount: number;
  readonly applyBatch: (events: readonly ForgeDashboardEvent[]) => void;
  readonly applyMonitorEvent: (event: MonitorDashboardEvent) => void;
  readonly resetBuffer: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useForgeStore = create<ForgeState>((set) => ({
  bricks: {},
  recentEvents: [],
  recentMonitorEvents: [],
  sparklineData: {},
  demandCount: 0,
  crystallizeCount: 0,

  applyBatch: (events) =>
    set((state) => {
      if (events.length === 0) return state;

      const bricks = { ...state.bricks };
      const sparklineData = { ...state.sparklineData };
      let demandCount = state.demandCount;
      let crystallizeCount = state.crystallizeCount;

      for (const event of events) {
        switch (event.subKind) {
          case "brick_forged":
            bricks[event.brickId] = {
              brickId: event.brickId,
              name: event.name,
              status: "active",
              lastFitness: 0,
              lastUpdatedAt: event.timestamp,
            };
            break;
          case "brick_demand_forged":
            bricks[event.brickId] = {
              brickId: event.brickId,
              name: event.name,
              status: "active",
              lastFitness: 0,
              lastUpdatedAt: event.timestamp,
            };
            break;
          case "brick_deprecated": {
            const existing = bricks[event.brickId];
            if (existing !== undefined) {
              bricks[event.brickId] = {
                ...existing,
                status: "deprecated",
                lastFitness: event.fitnessOriginal,
                lastUpdatedAt: event.timestamp,
              };
            }
            break;
          }
          case "brick_promoted": {
            const existing = bricks[event.brickId];
            if (existing !== undefined) {
              bricks[event.brickId] = {
                ...existing,
                status: "promoted",
                lastFitness: event.fitnessOriginal,
                lastUpdatedAt: event.timestamp,
              };
            }
            break;
          }
          case "brick_quarantined": {
            const existing = bricks[event.brickId];
            if (existing !== undefined) {
              bricks[event.brickId] = {
                ...existing,
                status: "quarantined",
                lastUpdatedAt: event.timestamp,
              };
            }
            break;
          }
          case "demand_detected":
            demandCount++;
            break;
          case "crystallize_candidate":
            crystallizeCount++;
            break;
          case "fitness_flushed": {
            const existing = bricks[event.brickId];
            if (existing !== undefined) {
              bricks[event.brickId] = {
                ...existing,
                lastFitness: event.successRate,
                lastUpdatedAt: event.timestamp,
              };
            }
            // Update sparkline data
            const prev = sparklineData[event.brickId] ?? [];
            sparklineData[event.brickId] = [...prev, event.successRate].slice(
              -MAX_SPARKLINE_POINTS,
            );
            break;
          }
        }
      }

      // Append to buffer with eviction
      const combined = [...state.recentEvents, ...events];
      const recentEvents =
        combined.length > MAX_BUFFER_SIZE ? combined.slice(-MAX_BUFFER_SIZE) : combined;

      return {
        bricks,
        recentEvents,
        sparklineData,
        demandCount,
        crystallizeCount,
      };
    }),

  applyMonitorEvent: (event) =>
    set((state) => {
      const combined = [...state.recentMonitorEvents, event];
      const recentMonitorEvents =
        combined.length > MAX_MONITOR_BUFFER ? combined.slice(-MAX_MONITOR_BUFFER) : combined;
      return { recentMonitorEvents };
    }),

  resetBuffer: () =>
    set({
      recentEvents: [],
      recentMonitorEvents: [],
    }),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function useBricksList(): readonly BrickSummary[] {
  return useForgeStore(useShallow((s) => Object.values(s.bricks)));
}

export function useForgeTimeline(): readonly ForgeDashboardEvent[] {
  return useForgeStore((s) => s.recentEvents);
}

export function useSparklineData(brickId: string): readonly number[] {
  return useForgeStore((s) => s.sparklineData[brickId] ?? []);
}
