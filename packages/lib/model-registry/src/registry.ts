/**
 * Per-model context window registry.
 *
 * Values are effective *input* context window sizes in tokens — not max output tokens.
 * Calibrated against provider documentation; update when providers change limits.
 *
 * Layer: L0u — zero deps, pure data + pure functions only.
 */

/**
 * Union of all built-in model IDs.
 * Defined explicitly so isolatedDeclarations can generate the declaration file
 * without cross-file type inference on the KNOWN_MODELS const.
 */
export type KnownModelId =
  | "claude-haiku-4-5-20251001"
  | "claude-opus-4-6"
  | "claude-sonnet-4-6"
  | "gemini-2.0-flash"
  | "gemini-2.5-pro"
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-5.2"
  | "o3"
  | "o4-mini";

// Internal — annotated with Record<KnownModelId, number> so isolatedDeclarations is satisfied.
const KNOWN_MODELS: Readonly<Record<KnownModelId, number>> = {
  // Anthropic
  "claude-opus-4-6": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5-20251001": 200_000,
  // OpenAI
  "gpt-5.2": 200_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  o3: 200_000,
  "o4-mini": 200_000,
  // Google
  "gemini-2.5-pro": 1_000_000,
  "gemini-2.0-flash": 1_000_000,
};

/**
 * Canonical context window sizes for known models.
 * Widened to `Record<string, number>` so callers can index with arbitrary strings
 * — unknown models return `undefined`, which `resolveModelWindow` maps to the default.
 */
export const MODEL_WINDOWS: Readonly<Record<string, number>> = KNOWN_MODELS;

/** Fallback window used for models not present in the registry or caller overrides. */
export const DEFAULT_MODEL_WINDOW = 128_000;

/**
 * Resolve the context window size (in tokens) for a model ID.
 *
 * Lookup order:
 * 1. Caller `overrides` — allows runtime configuration without mutating the registry
 * 2. Built-in `MODEL_WINDOWS`
 * 3. `DEFAULT_MODEL_WINDOW` (128K conservative baseline)
 */
export function resolveModelWindow(
  modelId: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  return overrides?.[modelId] ?? MODEL_WINDOWS[modelId] ?? DEFAULT_MODEL_WINDOW;
}

/**
 * Returns true if `modelId` is a known entry in the built-in registry.
 * Does not check caller overrides.
 */
export function isKnownModel(modelId: string): modelId is KnownModelId {
  return Object.hasOwn(KNOWN_MODELS, modelId);
}
