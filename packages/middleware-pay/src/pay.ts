/**
 * Pay middleware factory — token budget enforcement.
 */

import type { KoiError } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PayMiddlewareConfig } from "./config.js";

const DEFAULT_ALERT_THRESHOLDS: readonly number[] = [0.8, 0.95];

export function createPayMiddleware(config: PayMiddlewareConfig): KoiMiddleware {
  const {
    tracker,
    calculator,
    budget,
    alertThresholds = DEFAULT_ALERT_THRESHOLDS,
    onAlert,
    onUsage,
    hardKill = true,
  } = config;

  // Track which thresholds have already been fired to avoid repeats
  const firedThresholds = new Set<number>();

  function checkAndFireAlerts(pctUsed: number, remainingBudget: number): void {
    if (!onAlert) return;
    const sortedThresholds = [...alertThresholds].sort((a, b) => a - b);
    for (const threshold of sortedThresholds) {
      if (pctUsed >= threshold && !firedThresholds.has(threshold)) {
        firedThresholds.add(threshold);
        onAlert(pctUsed, remainingBudget);
      }
    }
  }

  async function checkBudget(sessionId: string): Promise<void> {
    const remainingBudget = await tracker.remaining(sessionId, budget);
    if (hardKill && remainingBudget <= 0) {
      const error: KoiError = {
        code: "RATE_LIMIT",
        message: `Budget exhausted. Limit: $${budget.toFixed(4)}`,
        retryable: RETRYABLE_DEFAULTS.RATE_LIMIT,
        context: { budget, remaining: 0 },
      };
      throw error;
    }
  }

  return {
    name: "pay",
    priority: 200,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId;
      await checkBudget(sessionId);

      const response = await next(request);

      // Record cost if usage is available
      if (response.usage) {
        const model = response.model;
        const costUsd = calculator.calculate(
          model,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        const costEntry = {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          model,
          costUsd,
          timestamp: Date.now(),
        };
        await tracker.record(sessionId, costEntry);

        // Parallel fetch — both reads depend on record being complete, not on each other
        const [totalSpent, remainingBudget] = await Promise.all([
          tracker.totalSpend(sessionId),
          tracker.remaining(sessionId, budget),
        ]);
        const pctUsed = budget > 0 ? totalSpent / budget : 1;
        checkAndFireAlerts(pctUsed, remainingBudget);

        if (onUsage) {
          onUsage({ entry: costEntry, totalSpent, remaining: remainingBudget });
        }
      }

      return response;
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId;
      await checkBudget(sessionId);
      return next(request);
    },
  };
}
