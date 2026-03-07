/**
 * GovernanceProvider — ComponentProvider that creates and attaches a
 * GovernanceControllerBuilder as the GOVERNANCE component during assembly.
 *
 * Registers built-in sensors (spawn, turns, tokens, duration, error rate).
 * L2-contributed variables are discovered later by GovernanceExtension.
 */

import type { Agent, ComponentProvider } from "@koi/core";
import { COMPONENT_PRIORITY, GOVERNANCE } from "@koi/core";
import { createGovernanceController } from "./governance-controller.js";
import type { GovernanceConfig } from "./governance-types.js";

export function createGovernanceProvider(
  config?: Partial<GovernanceConfig> | undefined,
): ComponentProvider {
  return {
    name: "koi:governance",
    priority: COMPONENT_PRIORITY.BUNDLED,
    async attach(agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      const builder = createGovernanceController(config, {
        agentDepth: agent.pid.depth,
      });
      return new Map([[GOVERNANCE as string, builder]]);
    },
  };
}
