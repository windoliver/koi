/**
 * JSON export — serializes cost aggregator state for external dashboards.
 *
 * Produces a JSON-serializable snapshot of the current cost breakdown
 * plus the raw entry audit trail from the ring buffer.
 */

import type { CostBreakdown, CostEntry } from "@koi/core/cost-tracker";
import { formatCost } from "@koi/core/cost-tracker";
import type { TokenRateTracker } from "./token-rate.js";
import type { CostAggregator } from "./tracker.js";

/**
 * JSON-serializable cost export payload.
 * Designed for consumption by external dashboards (Grafana, custom UIs).
 */
export interface CostExportPayload {
  readonly exportedAt: string;
  readonly sessionId: string;
  readonly breakdown: CostBreakdown;
  readonly formattedTotal: string;
  readonly entries: readonly CostEntry[];
  readonly tokenRate?:
    | {
        readonly inputPerSecond: number;
        readonly outputPerSecond: number;
      }
    | undefined;
}

/**
 * Export the current cost state as a JSON-serializable payload.
 *
 * @param aggregator - The cost aggregator instance.
 * @param sessionId - Session to export.
 * @param tokenRate - Optional token rate tracker for throughput data.
 */
export function exportCostJson(
  aggregator: CostAggregator,
  sessionId: string,
  tokenRate?: TokenRateTracker,
): CostExportPayload {
  const breakdown = aggregator.breakdown(sessionId);
  return {
    exportedAt: new Date().toISOString(),
    sessionId,
    breakdown,
    formattedTotal: formatCost(breakdown.totalCostUsd),
    entries: aggregator.entries(sessionId),
    ...(tokenRate !== undefined
      ? {
          tokenRate: {
            inputPerSecond: tokenRate.inputPerSecond(),
            outputPerSecond: tokenRate.outputPerSecond(),
          },
        }
      : {}),
  };
}
