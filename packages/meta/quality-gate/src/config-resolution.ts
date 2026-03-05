/**
 * 3-layer config resolution: defaults → preset → user overrides.
 */

import type { FeedbackLoopConfig } from "@koi/middleware-feedback-loop";
import type { VerifierConfig } from "@koi/middleware-output-verifier";
import { QUALITY_GATE_PRESET_SPECS } from "./presets.js";
import type { QualityGateConfig, ResolvedQualityGateConfig } from "./types.js";

/** Resolves quality-gate config by merging defaults → preset → user overrides. */
export function resolveQualityGateConfig(config: QualityGateConfig): ResolvedQualityGateConfig {
  const preset = config.preset ?? "standard";
  const spec = QUALITY_GATE_PRESET_SPECS[preset];

  // Verifier: user override ?? preset default ?? undefined
  const verifier: VerifierConfig | undefined =
    config.verifier !== undefined ? { ...spec.verifier, ...config.verifier } : spec.verifier;

  // Feedback-loop: user override ?? preset default ?? undefined
  const feedbackLoop: FeedbackLoopConfig | undefined =
    config.feedbackLoop !== undefined
      ? { ...spec.feedbackLoop, ...config.feedbackLoop }
      : spec.feedbackLoop;

  // Budget: user override ?? preset default ?? undefined
  const maxTotalModelCalls = config.maxTotalModelCalls ?? spec.maxTotalModelCalls;

  return {
    preset,
    verifier,
    feedbackLoop,
    maxTotalModelCalls,
  };
}
