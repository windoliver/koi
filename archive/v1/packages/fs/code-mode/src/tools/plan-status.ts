/**
 * code_plan_status tool — Returns the current plan state.
 */

import type { JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { PlanStore } from "../plan-store.js";
import type { PlanStatus } from "../types.js";

export function createPlanStatusTool(store: PlanStore, prefix: string, policy: ToolPolicy): Tool {
  return {
    descriptor: {
      name: `${prefix}_status`,
      description: "Get the status of the current code plan (pending, applied, or failed)",
      inputSchema: {
        type: "object",
        properties: {},
      } as JsonObject,
    },
    origin: "primordial",
    policy,
    execute: async (_args: JsonObject): Promise<unknown> => {
      const plan = store.get();
      const status: PlanStatus = {
        planId: plan?.id,
        state: plan?.state,
        stepCount: plan?.steps.length ?? 0,
      };
      return status;
    },
  };
}
