/**
 * Config validation and default resolution for @koi/middleware-user-model.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";
import { createCascadedDriftDetector } from "./cascaded-drift.js";
import { createDefaultCorrectionDetector } from "./correction-detector.js";
import { createKeywordDriftDetector } from "./keyword-drift.js";
import type { ResolvedUserModelConfig, UserModelConfig } from "./types.js";

const DEFAULT_SIGNAL_TIMEOUT_MS = 200;
const DEFAULT_MAX_PREFERENCE_TOKENS = 400;
const DEFAULT_MAX_SENSOR_TOKENS = 100;
const DEFAULT_MAX_META_TOKENS = 100;
const DEFAULT_RELEVANCE_THRESHOLD = 0.7;
const DEFAULT_PREFERENCE_NAMESPACE = "preferences";
const DEFAULT_PREFERENCE_CATEGORY = "preference";
const DEFAULT_RECALL_LIMIT = 5;

export function validateUserModelConfig(config: unknown): Result<UserModelConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "UserModelConfig must be a non-null object",
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
        message:
          "UserModelConfig requires a 'memory' MemoryComponent with recall and store methods",
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
        message:
          "UserModelConfig requires a 'memory' MemoryComponent with recall and store methods",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as UserModelConfig };
}

function resolveDriftDetector(
  config: UserModelConfig,
): ResolvedUserModelConfig["drift"]["detector"] {
  if (config.drift?.detector !== undefined) return config.drift.detector;
  if (config.drift?.classify !== undefined) {
    return createCascadedDriftDetector(config.drift.classify);
  }
  return createKeywordDriftDetector();
}

export function resolveUserModelDefaults(config: UserModelConfig): ResolvedUserModelConfig {
  return {
    memory: config.memory,
    preAction: {
      enabled: config.preAction?.enabled ?? true,
      classifier: config.preAction?.classifier ?? createDefaultAmbiguityClassifier(),
    },
    postAction: {
      enabled: config.postAction?.enabled ?? true,
      detector: config.postAction?.detector ?? createDefaultCorrectionDetector(),
    },
    drift: {
      enabled: config.drift?.enabled ?? true,
      detector: resolveDriftDetector(config),
    },
    signalSources: config.signalSources ?? [],
    signalTimeoutMs: config.signalTimeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS,
    maxPreferenceTokens: config.maxPreferenceTokens ?? DEFAULT_MAX_PREFERENCE_TOKENS,
    maxSensorTokens: config.maxSensorTokens ?? DEFAULT_MAX_SENSOR_TOKENS,
    maxMetaTokens: config.maxMetaTokens ?? DEFAULT_MAX_META_TOKENS,
    relevanceThreshold: config.relevanceThreshold ?? DEFAULT_RELEVANCE_THRESHOLD,
    preferenceNamespace: config.preferenceNamespace ?? DEFAULT_PREFERENCE_NAMESPACE,
    preferenceCategory: config.preferenceCategory ?? DEFAULT_PREFERENCE_CATEGORY,
    recallLimit: config.recallLimit ?? DEFAULT_RECALL_LIMIT,
    salienceGate: config.salienceGate,
    onError: config.onError,
  };
}
