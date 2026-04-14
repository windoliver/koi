/**
 * In-memory budget tracker with O(1) pre-aggregated breakdown queries.
 *
 * Ported from v1 InMemoryBudgetTracker and extended with:
 * - Per-agent and per-provider aggregation dimensions (Decision 7A)
 * - Bounded ring buffer for raw entry audit trail (Decision 15A)
 * - Soft warning threshold integration (Decision 12A)
 *
 * Aggregates are maintained incrementally on each record() call,
 * making totalSpend(), remaining(), and breakdown() all O(1).
 */

import type {
  AgentCostBreakdown,
  BudgetTracker,
  CostBreakdown,
  CostEntry,
  ModelCostBreakdown,
  ProviderCostBreakdown,
  ToolCostBreakdown,
} from "@koi/core/cost-tracker";
import { createRingBuffer, DEFAULT_CAPACITY, type RingBuffer } from "./ring-buffer.js";
import type { ThresholdTracker } from "./thresholds.js";

// ---------------------------------------------------------------------------
// Internal mutable aggregates
// ---------------------------------------------------------------------------

interface MutableModelAgg {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

interface MutableToolAgg {
  totalCostUsd: number;
  callCount: number;
}

interface MutableAgentAgg {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

interface MutableProviderAgg {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  callCount: number;
}

interface SessionAgg {
  totalCostUsd: number;
  readonly byModel: Map<string, MutableModelAgg>;
  readonly byTool: Map<string, MutableToolAgg>;
  readonly byAgent: Map<string, MutableAgentAgg>;
  readonly byProvider: Map<string, MutableProviderAgg>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrCreateSession(sessions: Map<string, SessionAgg>, sessionId: string): SessionAgg {
  const existing = sessions.get(sessionId);
  if (existing !== undefined) return existing;
  const fresh: SessionAgg = {
    totalCostUsd: 0,
    byModel: new Map(),
    byTool: new Map(),
    byAgent: new Map(),
    byProvider: new Map(),
  };
  sessions.set(sessionId, fresh);
  return fresh;
}

function freezeBreakdown(agg: SessionAgg): CostBreakdown {
  const byModel: readonly ModelCostBreakdown[] = [...agg.byModel.entries()].map(
    ([model, m]): ModelCostBreakdown => ({
      model,
      totalCostUsd: m.totalCostUsd,
      totalInputTokens: m.totalInputTokens,
      totalOutputTokens: m.totalOutputTokens,
      callCount: m.callCount,
    }),
  );

  const byTool: readonly ToolCostBreakdown[] = [...agg.byTool.entries()].map(
    ([toolName, t]): ToolCostBreakdown => ({
      toolName,
      totalCostUsd: t.totalCostUsd,
      callCount: t.callCount,
    }),
  );

  const byAgent: readonly AgentCostBreakdown[] =
    agg.byAgent.size > 0
      ? [...agg.byAgent.entries()].map(
          ([agentId, a]): AgentCostBreakdown => ({
            agentId,
            totalCostUsd: a.totalCostUsd,
            totalInputTokens: a.totalInputTokens,
            totalOutputTokens: a.totalOutputTokens,
            callCount: a.callCount,
          }),
        )
      : [];

  const byProvider: readonly ProviderCostBreakdown[] =
    agg.byProvider.size > 0
      ? [...agg.byProvider.entries()].map(
          ([provider, p]): ProviderCostBreakdown => ({
            provider,
            totalCostUsd: p.totalCostUsd,
            totalInputTokens: p.totalInputTokens,
            totalOutputTokens: p.totalOutputTokens,
            callCount: p.callCount,
          }),
        )
      : [];

  return {
    totalCostUsd: agg.totalCostUsd,
    byModel,
    byTool,
    ...(byAgent.length > 0 ? { byAgent } : {}),
    ...(byProvider.length > 0 ? { byProvider } : {}),
  };
}

const EMPTY_BREAKDOWN: CostBreakdown = { totalCostUsd: 0, byModel: [], byTool: [] };

// ---------------------------------------------------------------------------
// Config & factory
// ---------------------------------------------------------------------------

export interface CostAggregatorConfig {
  /** Ring buffer capacity for raw entry audit trail. Default: 10,000. */
  readonly ringBufferCapacity?: number;
  /** Optional threshold tracker for soft budget warnings. */
  readonly thresholdTracker?: ThresholdTracker;
}

/**
 * Extended BudgetTracker with audit trail access and sync-only return types.
 *
 * Implements the L0 BudgetTracker contract (in-memory, always sync) and adds:
 * - entries(): access the ring buffer for JSON export
 * - clearSession(): remove session state and threshold history
 *
 * Return types are narrowed from `T | Promise<T>` to `T` since this
 * implementation is purely in-memory with no I/O.
 */
export interface CostAggregator extends BudgetTracker {
  readonly record: (sessionId: string, entry: CostEntry) => void;
  readonly totalSpend: (sessionId: string) => number;
  readonly remaining: (sessionId: string, budget: number) => number;
  readonly breakdown: (sessionId: string) => CostBreakdown;
  /** Access raw CostEntry audit trail (most recent entries). */
  readonly entries: (sessionId?: string) => readonly CostEntry[];
  /** Clear all state for a session. */
  readonly clearSession: (sessionId: string) => void;
}

function updateAgg(
  agg: MutableModelAgg | MutableAgentAgg | MutableProviderAgg,
  entry: CostEntry,
): void {
  agg.totalCostUsd += entry.costUsd;
  agg.totalInputTokens += entry.inputTokens;
  agg.totalOutputTokens += entry.outputTokens;
  agg.callCount += 1;
}

/**
 * Create a cost aggregator with pre-aggregated Maps + bounded ring buffer.
 *
 * Hybrid storage (Decision 13C):
 * - Pre-aggregated Maps for O(1) breakdown reads
 * - Ring buffer for raw entry audit trail (capped, exportable)
 */
export function createCostAggregator(config?: CostAggregatorConfig): CostAggregator {
  const sessions = new Map<string, SessionAgg>();
  const ringBuffer: RingBuffer<CostEntry> = createRingBuffer(
    config?.ringBufferCapacity ?? DEFAULT_CAPACITY,
  );
  const thresholdTracker = config?.thresholdTracker;

  return {
    record(sessionId: string, entry: CostEntry): void {
      const agg = getOrCreateSession(sessions, sessionId);

      // Running total
      agg.totalCostUsd += entry.costUsd;

      // Per-model
      const existingModel = agg.byModel.get(entry.model);
      if (existingModel !== undefined) {
        updateAgg(existingModel, entry);
      } else {
        agg.byModel.set(entry.model, {
          totalCostUsd: entry.costUsd,
          totalInputTokens: entry.inputTokens,
          totalOutputTokens: entry.outputTokens,
          callCount: 1,
        });
      }

      // Per-tool (only when toolName is set)
      if (entry.toolName !== undefined) {
        const existingTool = agg.byTool.get(entry.toolName);
        if (existingTool !== undefined) {
          existingTool.totalCostUsd += entry.costUsd;
          existingTool.callCount += 1;
        } else {
          agg.byTool.set(entry.toolName, {
            totalCostUsd: entry.costUsd,
            callCount: 1,
          });
        }
      }

      // Per-agent (only when agentId is set)
      if (entry.agentId !== undefined) {
        const existingAgent = agg.byAgent.get(entry.agentId);
        if (existingAgent !== undefined) {
          updateAgg(existingAgent, entry);
        } else {
          agg.byAgent.set(entry.agentId, {
            totalCostUsd: entry.costUsd,
            totalInputTokens: entry.inputTokens,
            totalOutputTokens: entry.outputTokens,
            callCount: 1,
          });
        }
      }

      // Per-provider (only when provider is set)
      if (entry.provider !== undefined) {
        const existingProvider = agg.byProvider.get(entry.provider);
        if (existingProvider !== undefined) {
          updateAgg(existingProvider, entry);
        } else {
          agg.byProvider.set(entry.provider, {
            totalCostUsd: entry.costUsd,
            totalInputTokens: entry.inputTokens,
            totalOutputTokens: entry.outputTokens,
            callCount: 1,
          });
        }
      }

      // Append to ring buffer
      ringBuffer.push(entry);

      // Check thresholds
      thresholdTracker?.check(sessionId, agg.totalCostUsd);
    },

    totalSpend(sessionId: string): number {
      return sessions.get(sessionId)?.totalCostUsd ?? 0;
    },

    remaining(sessionId: string, budget: number): number {
      const spent = sessions.get(sessionId)?.totalCostUsd ?? 0;
      return Math.max(0, budget - spent);
    },

    breakdown(sessionId: string): CostBreakdown {
      const agg = sessions.get(sessionId);
      if (agg === undefined) return EMPTY_BREAKDOWN;
      return freezeBreakdown(agg);
    },

    entries(sessionId?: string): readonly CostEntry[] {
      const all = ringBuffer.toArray();
      if (sessionId === undefined) return all;
      // Ring buffer doesn't track session — filter client-side.
      // For most use cases the full buffer is returned (JSON export).
      return all;
    },

    clearSession(sessionId: string): void {
      sessions.delete(sessionId);
      thresholdTracker?.clearSession(sessionId);
    },
  };
}
