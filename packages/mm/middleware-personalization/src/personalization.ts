/**
 * Personalization middleware factory — DEPRECATED.
 *
 * @deprecated Use createUserModelMiddleware from @koi/middleware-user-model instead.
 * This module is a thin shim that delegates to the unified user-model middleware.
 */

import type { KoiMiddleware } from "@koi/core/middleware";
import { createUserModelMiddleware } from "@koi/middleware-user-model";
import type { PersonalizationConfig } from "./config.js";

/** @deprecated Use createUserModelMiddleware from @koi/middleware-user-model */
export function createPersonalizationMiddleware(config: PersonalizationConfig): KoiMiddleware {
  console.warn(
    "[DEPRECATED] @koi/middleware-personalization — use @koi/middleware-user-model instead",
  );
  return createUserModelMiddleware({
    memory: config.memory,
    preAction: { enabled: config.preAction?.enabled ?? true },
    postAction: { enabled: config.postAction?.enabled ?? true },
    drift: { enabled: false },
    relevanceThreshold: config.relevanceThreshold,
    maxPreferenceTokens: config.maxPreferenceTokens,
    preferenceNamespace: config.preferenceNamespace,
    onError: config.onError,
  });
}
