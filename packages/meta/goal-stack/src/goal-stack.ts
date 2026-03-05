/**
 * Goal stack factory — composes goal-anchor, goal-reminder, and planning
 * middleware into a single bundle with preset-driven defaults.
 */

import type { KoiMiddleware } from "@koi/core";
import type { GoalAnchorConfig } from "@koi/middleware-goal-anchor";
import { createGoalAnchorMiddleware } from "@koi/middleware-goal-anchor";
import type { GoalReminderConfig } from "@koi/middleware-goal-reminder";
import { createGoalReminderMiddleware } from "@koi/middleware-goal-reminder";
import { createPlanMiddleware } from "@koi/middleware-planning";
import { resolveGoalStackConfig } from "./config-resolution.js";
import { GOAL_STACK_PRESET_SPECS } from "./presets.js";
import type { GoalStackBundle, GoalStackConfig, GoalStackPresetSpec } from "./types.js";

function buildReminderMiddleware(
  config: GoalStackConfig,
  spec: GoalStackPresetSpec,
): KoiMiddleware {
  const objectives = config.objectives ?? [];
  const sources = config.reminder?.sources ?? [{ kind: "manifest" as const, objectives }];

  const reminderConfig: GoalReminderConfig = {
    sources,
    baseInterval: config.reminder?.baseInterval ?? spec.reminderBaseInterval,
    maxInterval: config.reminder?.maxInterval ?? spec.reminderMaxInterval,
    ...(config.reminder?.isDrifting !== undefined
      ? { isDrifting: config.reminder.isDrifting }
      : {}),
    ...(config.reminder?.header !== undefined
      ? { header: config.reminder.header }
      : { header: spec.reminderHeader }),
  };

  return createGoalReminderMiddleware(reminderConfig);
}

function buildAnchorMiddleware(config: GoalStackConfig, spec: GoalStackPresetSpec): KoiMiddleware {
  const anchorConfig: GoalAnchorConfig = {
    objectives: config.objectives ?? [],
    ...(config.anchor?.header !== undefined
      ? { header: config.anchor.header }
      : { header: spec.anchorHeader }),
    ...(config.anchor?.onComplete !== undefined ? { onComplete: config.anchor.onComplete } : {}),
  };

  return createGoalAnchorMiddleware(anchorConfig);
}

function buildPlanMiddleware(config: GoalStackConfig): KoiMiddleware {
  return createPlanMiddleware({
    ...(config.planning?.onPlanUpdate !== undefined
      ? { onPlanUpdate: config.planning.onPlanUpdate }
      : {}),
    ...(config.planning?.priority !== undefined ? { priority: config.planning.priority } : {}),
  });
}

/**
 * Creates a composed goal stack from configuration.
 *
 * Middleware are added in priority order:
 *   1. goal-reminder (330) — adaptive periodic injection
 *   2. goal-anchor (340) — every-call todo injection
 *   3. planning (450) — write_plan tool
 */
export function createGoalStack(config: GoalStackConfig = {}): GoalStackBundle {
  const { preset } = resolveGoalStackConfig(config);
  const spec = GOAL_STACK_PRESET_SPECS[preset];

  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    spec.includeReminder ? buildReminderMiddleware(config, spec) : undefined,
    spec.includeAnchor ? buildAnchorMiddleware(config, spec) : undefined,
    spec.includePlanning ? buildPlanMiddleware(config) : undefined,
  ];

  const middlewares = candidates.filter((mw): mw is KoiMiddleware => mw !== undefined);

  return {
    middlewares,
    providers: [],
    config: {
      preset,
      middlewareCount: middlewares.length,
      includesAnchor: spec.includeAnchor,
      includesReminder: spec.includeReminder,
      includesPlanning: spec.includePlanning,
    },
  };
}
