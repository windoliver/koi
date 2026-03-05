/**
 * createPreferenceMiddleware — DEPRECATED.
 *
 * @deprecated Use createUserModelMiddleware from @koi/middleware-user-model instead.
 * This module is a thin shim that delegates to the unified user-model middleware.
 */

import type { KoiMiddleware } from "@koi/core/middleware";
import type { PreferenceDriftDetector as NewDetector } from "@koi/middleware-user-model";
import { createUserModelMiddleware } from "@koi/middleware-user-model";
import type { PreferenceMiddlewareConfig } from "./config.js";
import type { PreferenceDriftDetector } from "./types.js";

/**
 * Adapts the old PreferenceDriftDetector (feedback, ctx) to the new one (feedback only).
 * The TurnContext parameter is dropped since the unified middleware manages context internally.
 */
function adaptDetector(old: PreferenceDriftDetector): NewDetector {
  return { detect: (feedback: string) => old.detect(feedback, undefined as never) };
}

/** @deprecated Use createUserModelMiddleware from @koi/middleware-user-model */
export function createPreferenceMiddleware(config: PreferenceMiddlewareConfig): KoiMiddleware {
  console.warn("[DEPRECATED] @koi/middleware-preference — use @koi/middleware-user-model instead");

  // Build a no-op memory when none provided (matches original behavior)
  const memory = config.memory ?? {
    recall: async () => [] as const,
    store: async () => {},
  };

  return createUserModelMiddleware({
    memory,
    drift: {
      enabled: true,
      ...(config.driftDetector !== undefined
        ? { detector: adaptDetector(config.driftDetector) }
        : {}),
      classify: config.classify,
    },
    preAction: { enabled: false },
    postAction: { enabled: false },
    salienceGate: config.salienceGate,
    recallLimit: config.recallLimit,
    preferenceCategory: config.preferenceCategory,
  });
}
