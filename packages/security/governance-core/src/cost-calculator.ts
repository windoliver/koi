import { KoiRuntimeError } from "@koi/errors";

export interface PricingEntry {
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
}

export interface CostCalculator {
  readonly calculate: (modelId: string, inputTokens: number, outputTokens: number) => number;
}

export function createFlatRateCostCalculator(
  pricing: Readonly<Record<string, PricingEntry>>,
): CostCalculator {
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
      const inputCost = (inputTokens / 1_000_000) * entry.inputUsdPer1M;
      const outputCost = (outputTokens / 1_000_000) * entry.outputUsdPer1M;
      return inputCost + outputCost;
    },
  };
}
