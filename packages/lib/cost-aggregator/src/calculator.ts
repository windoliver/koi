/**
 * Cost calculator with tiered pricing support.
 *
 * Implements CostCalculator (L0 contract) with both simple and detailed
 * calculation methods. Uses a Map<string, ModelPricing> for O(1) lookups
 * with date-suffix alias fallback (Decision 16A).
 */

import type { CostCalculator, CostTokenBreakdown } from "@koi/core/cost-tracker";
import { DEFAULT_PRICING, type ModelPricing, resolvePricing } from "./pricing.js";

export interface CostCalculatorConfig {
  /**
   * Custom pricing overrides — highest priority, checked first.
   * Use for private/custom models not in any registry.
   */
  readonly pricingOverrides?: Readonly<Record<string, ModelPricing>> | undefined;
  /**
   * Live pricing table from models.dev — checked after overrides, before bundled.
   * Populated by fetchModelPricing() at startup.
   */
  readonly livePricing?: Readonly<Record<string, ModelPricing>> | undefined;
}

/**
 * Create a cost calculator with tiered pricing lookup.
 *
 * Lookup priority:
 *   1. pricingOverrides (user config)
 *   2. livePricing (models.dev, refreshed at startup)
 *   3. DEFAULT_PRICING (bundled snapshot, always available)
 *   4. Returns 0 for unknown models (no error — missing pricing is not a crash)
 */
export function createCostCalculator(config?: CostCalculatorConfig): CostCalculator {
  const overrides = config?.pricingOverrides ?? {};
  const live = config?.livePricing ?? {};

  function resolve(model: string): ModelPricing | undefined {
    return (
      resolvePricing(model, overrides) ??
      resolvePricing(model, live) ??
      resolvePricing(model, DEFAULT_PRICING)
    );
  }

  function calculate(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = resolve(model);
    if (pricing === undefined) return 0;
    return inputTokens * pricing.input + outputTokens * pricing.output;
  }

  function calculateDetailed(model: string, breakdown: CostTokenBreakdown): number {
    const pricing = resolve(model);
    if (pricing === undefined) return 0;

    // Base input tokens (non-cached)
    const cachedInput = breakdown.cachedInputTokens ?? 0;
    const cacheCreation = breakdown.cacheCreationTokens ?? 0;
    const regularInput = Math.max(0, breakdown.inputTokens - cachedInput - cacheCreation);

    // Base output tokens (non-reasoning)
    const reasoning = breakdown.reasoningTokens ?? 0;
    const regularOutput = Math.max(0, breakdown.outputTokens - reasoning);

    // Compute cost per tier
    const inputCost = regularInput * pricing.input;
    const cachedInputCost = cachedInput * (pricing.cachedInput ?? pricing.input);
    const cacheCreationCost = cacheCreation * (pricing.cacheCreation ?? pricing.input);
    const outputCost = regularOutput * pricing.output;
    // Reasoning tokens billed at output rate (Anthropic + OpenAI behavior)
    const reasoningCost = reasoning * pricing.output;

    return inputCost + cachedInputCost + cacheCreationCost + outputCost + reasoningCost;
  }

  return { calculate, calculateDetailed };
}
