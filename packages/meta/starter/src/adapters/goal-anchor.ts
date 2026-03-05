/**
 * Manifest adapter for @koi/middleware-goal-anchor.
 *
 * Reads manifest.middleware[].options for JSON-serializable values
 * (objectives, header). The onComplete callback is JS-only and is
 * supplied via GoalAnchorCallbacks from createDefaultRegistry so
 * callers never need to touch createGoalAnchorMiddleware directly.
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";
import type { TodoItem } from "@koi/middleware-goal";
import { createGoalAnchorMiddleware, validateGoalAnchorConfig } from "@koi/middleware-goal";
import type { RuntimeOpts } from "../registry.js";

/**
 * Typed callbacks for @koi/middleware-goal-anchor — provided via
 * createDefaultRegistry(callbacks) since they are JS functions that
 * cannot be expressed in JSON manifests.
 */
export interface GoalAnchorCallbacks {
  /** Called when an objective is marked complete by the heuristic scanner. */
  readonly onComplete?: (item: TodoItem) => void;
}

/**
 * Instantiates @koi/middleware-goal-anchor from a manifest MiddlewareConfig.
 * Throws on invalid options so misconfigured manifests fail fast at setup time.
 */
export function createGoalAnchorAdapter(
  config: MiddlewareConfig,
  _opts?: RuntimeOpts,
  callbacks?: GoalAnchorCallbacks,
): KoiMiddleware {
  const rawConfig: unknown = {
    ...(config.options ?? {}),
    ...(callbacks?.onComplete !== undefined ? { onComplete: callbacks.onComplete } : {}),
  };

  const result = validateGoalAnchorConfig(rawConfig);
  if (!result.ok) {
    throw new Error(`[starter] goal-anchor: invalid manifest options: ${result.error.message}`, {
      cause: result.error,
    });
  }

  return createGoalAnchorMiddleware(result.value);
}
