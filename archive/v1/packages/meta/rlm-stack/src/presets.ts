/**
 * RLM stack preset tiers — light, standard, aggressive.
 *
 * Each tier configures the RLM middleware with different trade-offs
 * between thoroughness and cost/latency.
 */

import type { MiddlewareBundle } from "@koi/core";
import { createRlmStack } from "./create-rlm-stack.js";
import type { RlmStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Preset tier type
// ---------------------------------------------------------------------------

export type RlmPresetTier = "light" | "standard" | "aggressive";

// ---------------------------------------------------------------------------
// Preset configurations
// ---------------------------------------------------------------------------

const LIGHT_PRESET = {
  maxIterations: 10,
  contextWindowTokens: 30_000,
  maxConcurrency: 2,
  maxDepth: 1,
} as const satisfies Partial<RlmStackConfig>;

const STANDARD_PRESET = {
  maxIterations: 20,
  contextWindowTokens: 80_000,
  maxConcurrency: 4,
  maxDepth: 2,
} as const satisfies Partial<RlmStackConfig>;

const AGGRESSIVE_PRESET = {
  maxIterations: 30,
  contextWindowTokens: 128_000,
  maxConcurrency: 5,
  maxDepth: 3,
} as const satisfies Partial<RlmStackConfig>;

const PRESETS: Readonly<Record<RlmPresetTier, Partial<RlmStackConfig>>> = {
  light: LIGHT_PRESET,
  standard: STANDARD_PRESET,
  aggressive: AGGRESSIVE_PRESET,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an RLM stack bundle from a named preset tier.
 *
 * @param tier Preset tier: "light" (fast, cheap), "standard" (balanced), "aggressive" (thorough).
 * @param overrides Optional config overrides applied on top of the preset.
 */
export function createRlmStackFromPreset(
  tier: RlmPresetTier = "standard",
  overrides?: Partial<RlmStackConfig>,
): MiddlewareBundle {
  const presetConfig = PRESETS[tier];
  return createRlmStack({ ...presetConfig, ...overrides });
}
