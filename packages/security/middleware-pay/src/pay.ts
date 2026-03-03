/**
 * Pay middleware factory — token budget enforcement.
 */

import type { CostEntry } from "@koi/core/cost-tracker";
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

  // Per-session cached remaining budget for describeCapabilities
  const lastKnownRemaining = new Map<string, number>();

  // Per-session threshold tracking to avoid firing the same alert twice
  const firedThresholds = new Map<string, Set<number>>();

  // Sort once at factory level, not on every call
  const sortedThresholds = [...alertThresholds].sort((a, b) => a - b);

  function getSessionThresholds(sessionId: string): Set<number> {
    const existing = firedThresholds.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = new Set<number>();
    firedThresholds.set(sessionId, fresh);
    return fresh;
  }

  function checkAndFireAlerts(sessionId: string, pctUsed: number, remainingBudget: number): void {
    if (!onAlert) return;
    const fired = getSessionThresholds(sessionId);
    for (const threshold of sortedThresholds) {
      if (pctUsed >= threshold && !fired.has(threshold)) {
        fired.add(threshold);
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

  /**
   * DRY cost recording helper — shared by wrapModelCall and wrapModelStream.
   * Calculates cost, records entry, updates remaining, fires alerts and onUsage.
   */
  async function recordCost(
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    toolName?: string | undefined,
  ): Promise<void> {
    const costUsd = calculator.calculate(model, inputTokens, outputTokens);
    const costEntry: CostEntry = {
      inputTokens,
      outputTokens,
      model,
      costUsd,
      timestamp: Date.now(),
      ...(toolName !== undefined ? { toolName } : {}),
    };
    await tracker.record(sessionId, costEntry);

    // Parallel fetch — both reads depend on record being complete, not on each other
    const [totalSpent, remainingBudget] = await Promise.all([
      tracker.totalSpend(sessionId),
      tracker.remaining(sessionId, budget),
    ]);
    lastKnownRemaining.set(sessionId, remainingBudget);
    const pctUsed = budget > 0 ? totalSpent / budget : 1;
    checkAndFireAlerts(sessionId, pctUsed, remainingBudget);

    if (onUsage) {
      const breakdown = await tracker.breakdown(sessionId);
      onUsage({ entry: costEntry, totalSpent, remaining: remainingBudget, breakdown });
    }
  }

  // Resolve the most recently cached remaining for any session (for describeCapabilities)
  function getLastKnownRemaining(): number {
    if (lastKnownRemaining.size === 0) return budget;
    // Return the minimum across sessions as a conservative display
    // let: accumulates minimum across map iteration
    let min = budget;
    for (const v of lastKnownRemaining.values()) {
      if (v < min) min = v;
    }
    return min;
  }

  return {
    name: "pay",
    priority: 200,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "budget",
      description:
        `Token budget: $${getLastKnownRemaining().toFixed(4)} of $${budget.toFixed(4)} remaining` +
        (hardKill ? " (hard kill on exhaustion)" : " (soft warning on exhaustion)"),
    }),

    async onSessionEnd(ctx): Promise<void> {
      const sessionId = ctx.sessionId;
      lastKnownRemaining.delete(sessionId);
      firedThresholds.delete(sessionId);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const sessionId = ctx.session.sessionId;
      const remainingBudget = await tracker.remaining(sessionId, budget);
      lastKnownRemaining.set(sessionId, remainingBudget);
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId;
      await checkBudget(sessionId);

      const response = await next(request);

      if (response.usage) {
        await recordCost(
          sessionId,
          response.model,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
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
          await recordCost(sessionId, model, inputTokens, outputTokens);
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
