/**
 * Per-agent token budget enforcement.
 *
 * Tracks token consumption per agent and enforces soft (80%) / hard (100%) limits.
 * Budget allocation is depth-aware: deeper agents receive smaller budgets.
 *
 * Integrated into the pay middleware via composition — not a standalone middleware.
 */

import type { InboundMessage } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentBudgetConfig {
  /** Maximum tokens per agent. Applied per agentId. Default: undefined (no per-agent limit). */
  readonly maxTokensPerAgent?: number;
  /** Soft threshold percentage (0-1). At this level, a system warning is injected. Default: 0.8. */
  readonly softThresholdPercent?: number;
  /**
   * Agent depth in the process tree (0 = root copilot).
   * Used for depth-based budget allocation: deeper agents get smaller budgets.
   * Should be set from CreateKoiOptions.parentPid.depth + 1 (computed in @koi/starter).
   * Default: 0 (full budget).
   */
  readonly agentDepth?: number;
}

export interface ResolvedAgentBudgetConfig {
  readonly maxTokensPerAgent: number;
  readonly softThresholdPercent: number;
}

interface AgentBudgetEntry {
  /** Total tokens consumed so far. */
  consumed: number; // let: incremented on each model call
  /** Allocated token budget for this agent. */
  readonly allocated: number;
  /** Whether the soft warning has already been injected. */
  softWarningFired: boolean; // let: set to true after first injection
}

// ---------------------------------------------------------------------------
// Budget system message
// ---------------------------------------------------------------------------

const BUDGET_WARNING_SENDER = "system:budget-warning";

function createBudgetWarningMessage(consumed: number, allocated: number): InboundMessage {
  const pct = Math.round((consumed / allocated) * 100);
  return {
    senderId: BUDGET_WARNING_SENDER,
    timestamp: Date.now(),
    content: [
      {
        kind: "text",
        text: `[Budget Warning] You have used ${String(pct)}% of your token budget (${String(consumed)}/${String(allocated)} tokens). Please wrap up your current task concisely.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentBudgetTracker {
  /**
   * Compute the allocated budget for an agent based on depth.
   * Depth 0 = full budget, depth 1 = 50%, depth 2 = 25%, etc.
   * Minimum floor: 1024 tokens.
   */
  readonly computeAllocation: (agentDepth: number) => number;
  /**
   * Record token usage for an agent. Returns whether the hard limit is exceeded.
   */
  readonly recordUsage: (agentId: string, tokens: number, agentDepth: number) => boolean;
  /**
   * Check if the agent has exceeded its budget. Returns "ok" | "warn" | "exceeded".
   */
  readonly checkBudget: (agentId: string) => "ok" | "warn" | "exceeded";
  /**
   * Get the budget warning message to inject, or undefined if not needed.
   * Returns the message only once (idempotent soft warning).
   */
  readonly getBudgetWarning: (agentId: string) => InboundMessage | undefined;
  /**
   * Clean up budget state for an agent.
   */
  readonly cleanup: (agentId: string) => void;
}

const MIN_BUDGET_FLOOR = 1024;

export function createAgentBudgetTracker(config: ResolvedAgentBudgetConfig): AgentBudgetTracker {
  const entries = new Map<string, AgentBudgetEntry>();

  function getOrCreateEntry(agentId: string, agentDepth: number): AgentBudgetEntry {
    const existing = entries.get(agentId);
    if (existing !== undefined) return existing;

    const allocated = computeAllocation(agentDepth);
    const entry: AgentBudgetEntry = {
      consumed: 0,
      allocated,
      softWarningFired: false,
    };
    entries.set(agentId, entry);
    return entry;
  }

  function computeAllocation(agentDepth: number): number {
    // Halve budget for each depth level, with a minimum floor
    const factor = 1 / 2 ** Math.min(agentDepth, 10);
    return Math.max(MIN_BUDGET_FLOOR, Math.floor(config.maxTokensPerAgent * factor));
  }

  return {
    computeAllocation,

    recordUsage(agentId: string, tokens: number, agentDepth: number): boolean {
      const entry = getOrCreateEntry(agentId, agentDepth);
      entry.consumed += tokens;
      return entry.consumed >= entry.allocated;
    },

    checkBudget(agentId: string): "ok" | "warn" | "exceeded" {
      const entry = entries.get(agentId);
      if (entry === undefined) return "ok";

      const ratio = entry.consumed / entry.allocated;
      if (ratio >= 1) return "exceeded";
      if (ratio >= config.softThresholdPercent) return "warn";
      return "ok";
    },

    getBudgetWarning(agentId: string): InboundMessage | undefined {
      const entry = entries.get(agentId);
      if (entry === undefined) return undefined;

      const ratio = entry.consumed / entry.allocated;
      if (ratio < config.softThresholdPercent) return undefined;
      if (entry.softWarningFired) return undefined;

      entry.softWarningFired = true;
      return createBudgetWarningMessage(entry.consumed, entry.allocated);
    },

    cleanup(agentId: string): void {
      entries.delete(agentId);
    },
  };
}
