import { KoiRuntimeError } from "@koi/errors";

/**
 * Structural mirror of `PricingEntry` from `@koi/governance-core`. Declared
 * locally so this package depends on L0 only (layer rule: L2 runtime deps ⊆
 * L0 + L0u). The shape must stay in sync with the governance-core source of
 * truth; a snapshot test in `__tests__/structural-compat.test.ts` asserts the
 * two are interchangeable.
 */
export interface PricingEntry {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
}

/** Structural mirror of `CostCalculator` from `@koi/governance-core`. */
export interface CostCalculator {
  readonly calculate: (modelId: string, inputTokens: number, outputTokens: number) => number;
}

/**
 * Flat per-1M-token cost calculator over a pricing table. Matches the
 * governance-core implementation so a config produced here drops straight
 * into `createGovernanceMiddleware`.
 */
function assertValidPricingEntry(modelId: string, entry: PricingEntry): void {
  if (!Number.isFinite(entry.inputUsdPer1M) || entry.inputUsdPer1M < 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Invalid pricing for ${modelId}: inputUsdPer1M must be a finite non-negative number`,
      { context: { modelId, inputUsdPer1M: entry.inputUsdPer1M } },
    );
  }
  if (!Number.isFinite(entry.outputUsdPer1M) || entry.outputUsdPer1M < 0) {
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Invalid pricing for ${modelId}: outputUsdPer1M must be a finite non-negative number`,
      { context: { modelId, outputUsdPer1M: entry.outputUsdPer1M } },
    );
  }
}

export function createFlatRateCostCalculator(
  pricing: Readonly<Record<string, PricingEntry>>,
): CostCalculator {
  // Validate every pricing entry at construction time so a typo in overrides
  // (e.g. `{ inputUsdPer1M: NaN }`) fails loud rather than silently returning
  // `NaN` from `calculate()`, which the middleware then drops and the spend
  // cap never trips.
  for (const [modelId, entry] of Object.entries(pricing)) {
    assertValidPricingEntry(modelId, entry);
  }

  return {
    calculate(modelId: string, inputTokens: number, outputTokens: number): number {
      if (!Object.hasOwn(pricing, modelId)) {
        throw KoiRuntimeError.from("VALIDATION", `Unknown model: ${modelId}`, {
          context: { modelId },
        });
      }
      if (!Number.isFinite(inputTokens) || inputTokens < 0) {
        throw KoiRuntimeError.from("VALIDATION", `Invalid inputTokens: ${inputTokens}`, {
          context: { inputTokens },
        });
      }
      if (!Number.isFinite(outputTokens) || outputTokens < 0) {
        throw KoiRuntimeError.from("VALIDATION", `Invalid outputTokens: ${outputTokens}`, {
          context: { outputTokens },
        });
      }
      const entry = pricing[modelId];
      if (entry === undefined) {
        throw KoiRuntimeError.from("INTERNAL", `Pricing entry missing for ${modelId}`);
      }
      const inputCost = (inputTokens / 1_000_000) * entry.inputUsdPer1M;
      const outputCost = (outputTokens / 1_000_000) * entry.outputUsdPer1M;
      return inputCost + outputCost;
    },
  };
}
