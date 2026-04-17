import type { PricingEntry } from "./cost-calculator.js";

/**
 * Default provider pricing (USD per 1M tokens, list price). Keyed by canonical
 * model id. Callers override via plain object spread:
 *
 *   const pricing = { ...DEFAULT_PRICING, "my-model": { inputUsdPer1M, outputUsdPer1M } };
 *
 * Update as providers change list prices.
 */
export const DEFAULT_PRICING: Readonly<Record<string, PricingEntry>> = Object.freeze({
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "gpt-5": { inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  "gpt-5-mini": { inputUsdPer1M: 0.25, outputUsdPer1M: 2 },
  "claude-opus-4-7": { inputUsdPer1M: 15, outputUsdPer1M: 75 },
  "claude-sonnet-4-6": { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  "claude-haiku-4-5": { inputUsdPer1M: 1, outputUsdPer1M: 5 },
});
