/**
 * Pay middleware factory — token budget enforcement.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
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

  // Cached remaining budget for describeCapabilities (updated after each model call)
  // let justified: mutable state updated by wrapModelCall to reflect latest budget snapshot
  let lastKnownRemaining: number = budget;

  // Track which thresholds have already been fired to avoid repeats
  const firedThresholds = new Set<number>();
  // Sort once at factory level, not on every call
  const sortedThresholds = [...alertThresholds].sort((a, b) => a - b);

  function checkAndFireAlerts(pctUsed: number, remainingBudget: number): void {
    if (!onAlert) return;
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
      throw KoiRuntimeError.from("RATE_LIMIT", `Budget exhausted. Limit: $${budget.toFixed(4)}`, {
        context: { budget, remaining: 0 },
      });
    }
  }

  return {
    name: "pay",
    priority: 200,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "budget",
      description: `Token budget: $${lastKnownRemaining.toFixed(4)} of $${budget.toFixed(4)} remaining`,
    }),

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
        lastKnownRemaining = remainingBudget;
        const pctUsed = budget > 0 ? totalSpent / budget : 1;
        checkAndFireAlerts(pctUsed, remainingBudget);

        if (onUsage) {
          onUsage({ entry: costEntry, totalSpent, remaining: remainingBudget });
        }
      }

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sessionId = ctx.session.sessionId;
      await checkBudget(sessionId);

      for await (const chunk of next(request)) {
        yield chunk;

        // Record cost from the done chunk, which carries the full ModelResponse + usage.
        if (chunk.kind === "done" && chunk.response.usage) {
          const { model } = chunk.response;
          const { inputTokens, outputTokens } = chunk.response.usage;
          const costUsd = calculator.calculate(model, inputTokens, outputTokens);
          const costEntry = {
            inputTokens,
            outputTokens,
            model,
            costUsd,
            timestamp: Date.now(),
          };
          await tracker.record(sessionId, costEntry);

          const [totalSpent, remainingBudget] = await Promise.all([
            tracker.totalSpend(sessionId),
            tracker.remaining(sessionId, budget),
          ]);
          lastKnownRemaining = remainingBudget;
          const pctUsed = budget > 0 ? totalSpent / budget : 1;
          checkAndFireAlerts(pctUsed, remainingBudget);

          if (onUsage) {
            onUsage({ entry: costEntry, totalSpent, remaining: remainingBudget });
          }
        }
      }
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
