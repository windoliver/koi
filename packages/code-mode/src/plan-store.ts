/**
 * Session-scoped, single-plan store for code-mode.
 *
 * Only one plan is active at a time. Creating a new plan discards the old one.
 */

import type { CodePlan } from "./types.js";

export interface PlanStore {
  readonly get: () => CodePlan | undefined;
  readonly set: (plan: CodePlan) => void;
  readonly clear: () => void;
  readonly update: (id: string, patch: Partial<Pick<CodePlan, "state">>) => CodePlan | undefined;
}

export function createPlanStore(): PlanStore {
  /* let justified: single mutable slot for session-scoped plan */
  let current: CodePlan | undefined;

  return {
    get: (): CodePlan | undefined => current,

    set: (plan: CodePlan): void => {
      current = plan;
    },

    clear: (): void => {
      current = undefined;
    },

    update: (id: string, patch: Partial<Pick<CodePlan, "state">>): CodePlan | undefined => {
      if (current === undefined || current.id !== id) return undefined;
      current = { ...current, ...patch };
      return current;
    },
  };
}
