/**
 * Model pricing table — bundled defaults derived from LiteLLM's registry (MIT licensed).
 *
 * Covers major Anthropic, OpenAI, and Google models as of April 2026.
 * Users can override via CostAggregatorConfig.pricingOverrides.
 *
 * Prices are per-token (not per-million).
 *
 * Sources:
 * - LiteLLM model_prices_and_context_window.json
 * - Anthropic pricing page
 * - OpenAI API pricing
 * - Google AI pricing
 */

export interface ModelPricing {
  /** Cost per input token in USD. */
  readonly input: number;
  /** Cost per output token in USD. */
  readonly output: number;
  /** Cost per cached input token (read). Defaults to input rate if absent. */
  readonly cachedInput?: number | undefined;
  /** Cost per cache creation token (write). Defaults to input rate if absent. */
  readonly cacheCreation?: number | undefined;
}

/**
 * Default pricing table — per-token rates for common models.
 *
 * Sourced from LiteLLM's model_prices_and_context_window.json (MIT).
 * Last synced: April 2026. Update via PR when major model launches occur.
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  // --- Anthropic Claude 4 family ---
  "claude-opus-4-6": { input: 15e-6, output: 75e-6, cachedInput: 1.5e-6, cacheCreation: 18.75e-6 },
  "claude-sonnet-4-6": { input: 3e-6, output: 15e-6, cachedInput: 0.3e-6, cacheCreation: 3.75e-6 },
  "claude-haiku-4-5": { input: 0.8e-6, output: 4e-6, cachedInput: 0.08e-6, cacheCreation: 1e-6 },

  // --- Anthropic Claude 3.5 family ---
  "claude-3-5-sonnet-20241022": {
    input: 3e-6,
    output: 15e-6,
    cachedInput: 0.3e-6,
    cacheCreation: 3.75e-6,
  },
  "claude-3-5-haiku-20241022": {
    input: 0.8e-6,
    output: 4e-6,
    cachedInput: 0.08e-6,
    cacheCreation: 1e-6,
  },

  // --- OpenAI GPT-4o family ---
  "gpt-4o": { input: 2.5e-6, output: 10e-6, cachedInput: 1.25e-6 },
  "gpt-4o-2024-11-20": { input: 2.5e-6, output: 10e-6, cachedInput: 1.25e-6 },
  "gpt-4o-mini": { input: 0.15e-6, output: 0.6e-6, cachedInput: 0.075e-6 },

  // --- OpenAI o-series (reasoning) ---
  o3: { input: 10e-6, output: 40e-6, cachedInput: 5e-6 },
  "o3-mini": { input: 1.1e-6, output: 4.4e-6, cachedInput: 0.55e-6 },
  "o4-mini": { input: 1.1e-6, output: 4.4e-6, cachedInput: 0.55e-6 },

  // --- Google Gemini ---
  "gemini-2.5-pro": { input: 1.25e-6, output: 10e-6, cachedInput: 0.315e-6 },
  "gemini-2.5-flash": { input: 0.15e-6, output: 0.6e-6, cachedInput: 0.0375e-6 },
  "gemini-2.0-flash": { input: 0.1e-6, output: 0.4e-6, cachedInput: 0.025e-6 },
} as const;

/**
 * Resolve pricing for a model, trying exact match then date-suffix fallback.
 *
 * Model aliasing: "claude-sonnet-4-6-20260414" → strip "-20260414" → "claude-sonnet-4-6".
 *
 * @returns Pricing entry or undefined if model not found.
 */
export function resolvePricing(
  model: string,
  table: Readonly<Record<string, ModelPricing>>,
): ModelPricing | undefined {
  // Exact match first
  const exact = table[model];
  if (exact !== undefined) return exact;

  // Strip provider prefix: "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  // OpenRouter and similar routers use "provider/model" format.
  const slashIdx = model.indexOf("/");
  if (slashIdx >= 0) {
    const withoutPrefix = model.slice(slashIdx + 1);
    const prefixed = table[withoutPrefix];
    if (prefixed !== undefined) return prefixed;
    // Also try date-suffix stripping on the prefix-stripped name
    const dateSuffix = /-\d{8}$/.exec(withoutPrefix);
    if (dateSuffix !== null) {
      const base = withoutPrefix.slice(0, dateSuffix.index);
      const aliased = table[base];
      if (aliased !== undefined) return aliased;
    }
  }

  // Strip date suffix: model-YYYYMMDD → model
  const dateSuffixPattern = /-\d{8}$/;
  if (dateSuffixPattern.test(model)) {
    const base = model.replace(dateSuffixPattern, "");
    const aliased = table[base];
    if (aliased !== undefined) return aliased;
  }

  return undefined;
}
