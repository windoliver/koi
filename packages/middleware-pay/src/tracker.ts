/**
 * Budget tracking interfaces and default implementations.
 */

export interface CostEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly costUsd: number;
  readonly timestamp: number;
}

export interface CostCalculator {
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
}

export interface BudgetTracker {
  readonly record: (sessionId: string, entry: CostEntry) => Promise<void>;
  readonly totalSpend: (sessionId: string) => Promise<number>;
  readonly remaining: (sessionId: string, budget: number) => Promise<number>;
}

/**
 * In-memory budget tracker. Map-backed, sums costs per session.
 */
export function createInMemoryBudgetTracker(): BudgetTracker {
  const entries = new Map<string, readonly CostEntry[]>();

  return {
    async record(sessionId: string, entry: CostEntry): Promise<void> {
      const existing = entries.get(sessionId) ?? [];
      entries.set(sessionId, [...existing, entry]);
    },

    async totalSpend(sessionId: string): Promise<number> {
      const existing = entries.get(sessionId) ?? [];
      return existing.reduce((sum, e) => sum + e.costUsd, 0);
    },

    async remaining(sessionId: string, budget: number): Promise<number> {
      const spent = await this.totalSpend(sessionId);
      return Math.max(0, budget - spent);
    },
  };
}

/**
 * Default cost calculator with simple per-token pricing.
 */
export function createDefaultCostCalculator(
  rates?: Partial<Record<string, { readonly input: number; readonly output: number }>>,
): CostCalculator {
  const defaultRates = {
    input: 0.000003, // $3 per million input tokens
    output: 0.000015, // $15 per million output tokens
  };

  return {
    calculate(model: string, inputTokens: number, outputTokens: number): number {
      const modelRates = rates?.[model];
      const inputRate = modelRates?.input ?? defaultRates.input;
      const outputRate = modelRates?.output ?? defaultRates.output;
      return inputTokens * inputRate + outputTokens * outputRate;
    },
  };
}
