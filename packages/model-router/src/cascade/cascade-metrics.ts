/**
 * Cost tracking for cascade routing.
 *
 * Tracks per-tier request counts, escalations, token usage,
 * and estimated costs.
 */

import type { ModelResponse } from "@koi/core";
import type { CascadeCostMetrics, CascadeTierConfig, TierCostMetrics } from "./cascade-types.js";

interface TierMetricsSnapshot {
  readonly requests: number;
  readonly escalations: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
}

export interface CascadeMetricsTracker {
  readonly record: (tierId: string, response: ModelResponse, escalated: boolean) => void;
  readonly getMetrics: () => CascadeCostMetrics;
}

export function createCascadeMetricsTracker(
  tiers: readonly CascadeTierConfig[],
): CascadeMetricsTracker {
  const tierMetrics = new Map<string, TierMetricsSnapshot>();
  const tierConfigs = new Map<string, CascadeTierConfig>();

  for (const tier of tiers) {
    tierMetrics.set(tier.targetId, {
      requests: 0,
      escalations: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    });
    tierConfigs.set(tier.targetId, tier);
  }

  return {
    record(tierId: string, response: ModelResponse, escalated: boolean): void {
      const prev = tierMetrics.get(tierId);
      if (!prev) return;

      tierMetrics.set(tierId, {
        requests: prev.requests + 1,
        escalations: prev.escalations + (escalated ? 1 : 0),
        totalInputTokens: prev.totalInputTokens + (response.usage?.inputTokens ?? 0),
        totalOutputTokens: prev.totalOutputTokens + (response.usage?.outputTokens ?? 0),
      });
    },

    getMetrics(): CascadeCostMetrics {
      let totalRequests = 0;
      let totalEscalations = 0;
      let totalEstimatedCost = 0;

      const tierSnapshots: TierCostMetrics[] = [];

      for (const tier of tiers) {
        const metrics = tierMetrics.get(tier.targetId);
        if (!metrics) continue;

        const config = tierConfigs.get(tier.targetId);
        const estimatedCost =
          metrics.totalInputTokens * (config?.costPerInputToken ?? 0) +
          metrics.totalOutputTokens * (config?.costPerOutputToken ?? 0);

        tierSnapshots.push({
          tierId: tier.targetId,
          requests: metrics.requests,
          escalations: metrics.escalations,
          totalInputTokens: metrics.totalInputTokens,
          totalOutputTokens: metrics.totalOutputTokens,
          estimatedCost,
        });

        totalRequests += metrics.requests;
        totalEscalations += metrics.escalations;
        totalEstimatedCost += estimatedCost;
      }

      return {
        tiers: tierSnapshots,
        totalRequests,
        totalEscalations,
        totalEstimatedCost,
      };
    },
  };
}
