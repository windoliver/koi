/**
 * Frozen preset specifications for quality-gate bundles.
 *
 * "light"      — deterministic checks only, no feedback-loop, no budget.
 * "standard"   — deterministic + feedback-loop with moderate retry budget.
 * "aggressive" — deterministic + feedback-loop with higher retry budget.
 *
 * Note: judge config requires a modelCall function from the user.
 * Presets configure deterministic checks and retry budgets only.
 */

import { nonEmpty } from "@koi/middleware-output-verifier";
import type { QualityGatePreset, QualityGatePresetSpec } from "./types.js";

const LIGHT: QualityGatePresetSpec = Object.freeze({
  verifier: Object.freeze({
    deterministic: Object.freeze([nonEmpty("block")]),
  }),
});

const STANDARD: QualityGatePresetSpec = Object.freeze({
  verifier: Object.freeze({
    deterministic: Object.freeze([nonEmpty("block")]),
    maxRevisions: 1,
  }),
  feedbackLoop: Object.freeze({
    retry: Object.freeze({
      validation: Object.freeze({ maxAttempts: 2 }),
    }),
  }),
  maxTotalModelCalls: 6,
});

const AGGRESSIVE: QualityGatePresetSpec = Object.freeze({
  verifier: Object.freeze({
    deterministic: Object.freeze([nonEmpty("block")]),
    maxRevisions: 2,
  }),
  feedbackLoop: Object.freeze({
    retry: Object.freeze({
      validation: Object.freeze({ maxAttempts: 3 }),
    }),
  }),
  maxTotalModelCalls: 10,
});

/** Frozen registry of quality-gate preset specifications. */
export const QUALITY_GATE_PRESET_SPECS: Readonly<Record<QualityGatePreset, QualityGatePresetSpec>> =
  Object.freeze({
    light: LIGHT,
    standard: STANDARD,
    aggressive: AGGRESSIVE,
  });
