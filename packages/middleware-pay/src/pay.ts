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

/** Cost amount precision for PayLedger string amounts. */
const COST_PRECISION = 10;

/**
 * Parse a PayLedger string amount, failing closed on invalid data.
 * Returns a finite number; throws on NaN/Infinity to prevent silent bypass.
 */
function parseAmount(raw: string): number {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw KoiRuntimeError.from("INTERNAL", `Invalid balance amount: "${raw}"`, {
      context: { rawValue: raw },
    });
  }
  return n;
}

export function createPayMiddleware(config: PayMiddlewareConfig): KoiMiddleware {
  const {
    ledger,
    calculator,
    budget,
    alertThresholds = DEFAULT_ALERT_THRESHOLDS,
    onAlert,
    onUsage,
    hardKill = true,
  } = config;

  // Cached remaining budget for describeCapabilities (updated after each model call)
  // let justified: mutable state updated by recordCost to reflect latest budget snapshot
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

  async function checkBudget(): Promise<void> {
    const balance = await ledger.getBalance();
    const remaining = parseAmount(balance.available);
    if (hardKill && remaining <= 0) {
      throw KoiRuntimeError.from("RATE_LIMIT", `Budget exhausted. Limit: $${budget.toFixed(4)}`, {
        context: { budget, remaining: 0 },
      });
    }
  }

  async function recordCost(
    model: string,
    costUsd: number,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    await ledger.meter(costUsd.toFixed(COST_PRECISION), "model_call");
    const balance = await ledger.getBalance();
    const remaining = parseAmount(balance.available);
    const totalSpent = budget - remaining;
    lastKnownRemaining = remaining;

    const pctUsed = budget > 0 ? totalSpent / budget : 1;
    checkAndFireAlerts(pctUsed, remaining);

    if (onUsage) {
      onUsage({ model, costUsd, inputTokens, outputTokens, totalSpent, remaining });
    }
  }

  return {
    name: "pay",
    priority: 200,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => ({
      label: "budget",
      description:
        `Token budget: $${lastKnownRemaining.toFixed(4)} of $${budget.toFixed(4)} remaining` +
        (hardKill ? " (hard kill on exhaustion)" : " (soft warning on exhaustion)"),
    }),

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      await checkBudget();

      const response = await next(request);

      if (response.usage) {
        const costUsd = calculator.calculate(
          response.model,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
        await recordCost(
          response.model,
          costUsd,
          response.usage.inputTokens,
          response.usage.outputTokens,
        );
      }

      return response;
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      await checkBudget();

      for await (const chunk of next(request)) {
        yield chunk;

        if (chunk.kind === "done" && chunk.response.usage) {
          const { model } = chunk.response;
          const { inputTokens, outputTokens } = chunk.response.usage;
          const costUsd = calculator.calculate(model, inputTokens, outputTokens);
          await recordCost(model, costUsd, inputTokens, outputTokens);
        }
      }
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      await checkBudget();
      return next(request);
    },
  };
}
