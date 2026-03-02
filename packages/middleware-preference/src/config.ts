/**
 * PreferenceMiddlewareConfig and validation for @koi/middleware-preference.
 */

import type { MemoryComponent } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { LlmClassifier, PreferenceDriftDetector, SalienceGate } from "./types.js";

export interface PreferenceMiddlewareConfig {
  /** Custom drift detector. Auto-wired from classify if not provided. */
  readonly driftDetector?: PreferenceDriftDetector | undefined;
  /** Custom salience gate. Auto-wired from classify if not provided. */
  readonly salienceGate?: SalienceGate | undefined;
  /** LLM classifier callback. Used to auto-wire detector and gate. */
  readonly classify?: LlmClassifier | undefined;
  /** Additional keyword patterns for the cascaded drift detector. */
  readonly additionalPatterns?: readonly RegExp[] | undefined;
  /** Maximum number of recalled preferences to consider for supersession. Default: 5. */
  readonly recallLimit?: number | undefined;
  /** Category used when storing/recalling preferences. Default: "preference". */
  readonly preferenceCategory?: string | undefined;
  /** Memory component for store/recall. If not provided, store/recall is skipped. */
  readonly memory?: MemoryComponent | undefined;
}

function validationError(message: string): Result<PreferenceMiddlewareConfig, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

export function validatePreferenceConfig(
  config: unknown,
): Result<PreferenceMiddlewareConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("PreferenceMiddlewareConfig must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  // driftDetector: optional object with detect method
  if (c.driftDetector !== undefined) {
    if (
      typeof c.driftDetector !== "object" ||
      c.driftDetector === null ||
      typeof (c.driftDetector as Record<string, unknown>).detect !== "function"
    ) {
      return validationError(
        "PreferenceMiddlewareConfig.driftDetector must have a detect() method",
      );
    }
  }

  // salienceGate: optional object with isSalient method
  if (c.salienceGate !== undefined) {
    if (
      typeof c.salienceGate !== "object" ||
      c.salienceGate === null ||
      typeof (c.salienceGate as Record<string, unknown>).isSalient !== "function"
    ) {
      return validationError(
        "PreferenceMiddlewareConfig.salienceGate must have an isSalient() method",
      );
    }
  }

  // classify: optional function
  if (c.classify !== undefined && typeof c.classify !== "function") {
    return validationError("PreferenceMiddlewareConfig.classify must be a function if provided");
  }

  // additionalPatterns: optional array of RegExp
  if (c.additionalPatterns !== undefined) {
    if (!Array.isArray(c.additionalPatterns)) {
      return validationError(
        "PreferenceMiddlewareConfig.additionalPatterns must be an array of RegExp if provided",
      );
    }
    for (const p of c.additionalPatterns as unknown[]) {
      if (!(p instanceof RegExp)) {
        return validationError(
          "PreferenceMiddlewareConfig.additionalPatterns must contain only RegExp values",
        );
      }
    }
  }

  // recallLimit: optional positive integer
  if (c.recallLimit !== undefined) {
    if (
      typeof c.recallLimit !== "number" ||
      !Number.isFinite(c.recallLimit) ||
      !Number.isInteger(c.recallLimit) ||
      c.recallLimit < 1
    ) {
      return validationError("PreferenceMiddlewareConfig.recallLimit must be a positive integer");
    }
  }

  // preferenceCategory: optional non-empty string
  if (c.preferenceCategory !== undefined) {
    if (typeof c.preferenceCategory !== "string" || c.preferenceCategory.length === 0) {
      return validationError(
        "PreferenceMiddlewareConfig.preferenceCategory must be a non-empty string if provided",
      );
    }
  }

  // memory: optional object with recall and store methods
  if (c.memory !== undefined) {
    if (
      typeof c.memory !== "object" ||
      c.memory === null ||
      typeof (c.memory as Record<string, unknown>).recall !== "function" ||
      typeof (c.memory as Record<string, unknown>).store !== "function"
    ) {
      return validationError(
        "PreferenceMiddlewareConfig.memory must have recall() and store() methods",
      );
    }
  }

  return { ok: true, value: config as PreferenceMiddlewareConfig };
}
