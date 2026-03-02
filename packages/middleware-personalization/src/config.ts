/**
 * Personalization middleware configuration and validation.
 */

import type { MemoryComponent } from "@koi/core/ecs";
import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { AmbiguityClassifier } from "./ambiguity-classifier.js";
import type { CorrectionDetector } from "./correction-detector.js";

export interface PreActionConfig {
  readonly enabled?: boolean;
  readonly classifier?: AmbiguityClassifier;
  readonly maxQuestionTokens?: number;
}

export interface PostActionConfig {
  readonly enabled?: boolean;
  readonly detector?: CorrectionDetector;
}

export interface PersonalizationConfig {
  readonly memory: MemoryComponent;
  readonly preAction?: PreActionConfig;
  readonly postAction?: PostActionConfig;
  readonly relevanceThreshold?: number;
  readonly maxPreferenceTokens?: number;
  readonly preferenceNamespace?: string;
  readonly onError?: (error: unknown) => void;
}

/** Resolved config with all defaults applied. */
export interface ResolvedPersonalizationConfig {
  readonly memory: MemoryComponent;
  readonly preAction: {
    readonly enabled: boolean;
    readonly classifier: AmbiguityClassifier;
    readonly maxQuestionTokens: number;
  };
  readonly postAction: { readonly enabled: boolean; readonly detector: CorrectionDetector };
  readonly relevanceThreshold: number;
  readonly maxPreferenceTokens: number;
  readonly preferenceNamespace: string;
  readonly onError?: ((error: unknown) => void) | undefined;
}

const DEFAULT_RELEVANCE_THRESHOLD = 0.7;
const DEFAULT_MAX_PREFERENCE_TOKENS = 500;
const DEFAULT_PREFERENCE_NAMESPACE = "preferences";

export function validatePersonalizationConfig(
  config: unknown,
): Result<PersonalizationConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (!c.memory || typeof c.memory !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'memory' MemoryComponent with recall and store methods",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const mem = c.memory as Record<string, unknown>;
  if (typeof mem.recall !== "function" || typeof mem.store !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config requires a 'memory' MemoryComponent with recall and store methods",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.relevanceThreshold !== undefined) {
    if (
      typeof c.relevanceThreshold !== "number" ||
      c.relevanceThreshold < 0 ||
      c.relevanceThreshold > 1
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "relevanceThreshold must be a number between 0 and 1",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.maxPreferenceTokens !== undefined) {
    if (typeof c.maxPreferenceTokens !== "number" || c.maxPreferenceTokens <= 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "maxPreferenceTokens must be a positive number",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as PersonalizationConfig };
}

export function resolveDefaults(
  config: PersonalizationConfig,
  defaultClassifier: AmbiguityClassifier,
  defaultDetector: CorrectionDetector,
): ResolvedPersonalizationConfig {
  return {
    memory: config.memory,
    preAction: {
      enabled: config.preAction?.enabled ?? true,
      classifier: config.preAction?.classifier ?? defaultClassifier,
      maxQuestionTokens: config.preAction?.maxQuestionTokens ?? 100,
    },
    postAction: {
      enabled: config.postAction?.enabled ?? true,
      detector: config.postAction?.detector ?? defaultDetector,
    },
    relevanceThreshold: config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
    maxPreferenceTokens: config.maxPreferenceTokens ?? DEFAULT_MAX_PREFERENCE_TOKENS,
    preferenceNamespace: config.preferenceNamespace ?? DEFAULT_PREFERENCE_NAMESPACE,
    onError: config.onError,
  };
}
