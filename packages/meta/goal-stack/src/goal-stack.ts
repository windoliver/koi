/**
 * Factory for the goal stack bundle.
 *
 * Composes up to 3 goal-management middleware into a single bundle:
 *   - goal-reminder (priority 330)
 *   - goal-anchor   (priority 340)
 *   - plan           (priority 450)
 */

import type { KoiMiddleware } from "@koi/core";
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";
import { createGoalReminderMiddleware } from "@koi/middleware-goal-reminder";
import { createPlanMiddleware } from "@koi/middleware-planning";

import { resolveGoalStackConfig } from "./config-resolution.js";
import type { GoalStackBundle, GoalStackConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a goal management stack from config.
 *
 * Returns an ordered array of middleware (ascending priority: 330, 340, 450)
 * plus metadata for inspection.
 */
export function createGoalStack(config: GoalStackConfig = {}): GoalStackBundle {
  const resolved = resolveGoalStackConfig(config);

  // Engine sorts middleware by priority; insertion order does not matter.
  // goal-reminder=330, goal-anchor=340, plan=450 (set by L2 factories)
  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    resolved.reminder !== undefined ? createGoalReminderMiddleware(resolved.reminder) : undefined,
    resolved.anchor !== undefined ? createGoalAnchorMiddleware(resolved.anchor) : undefined,
    resolved.planning !== undefined ? createPlanMiddleware(resolved.planning) : undefined,
  ];

  const middlewares = candidates.filter((m): m is KoiMiddleware => m !== undefined);

  return { middlewares, config: resolved.meta };
}
