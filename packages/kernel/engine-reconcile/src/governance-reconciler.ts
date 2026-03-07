/**
 * GovernanceReconciler — ReconciliationController that monitors governance
 * health via background drift sweeps.
 *
 * Tracks consecutive violations per agent. After MAX_CONSECUTIVE violations,
 * returns terminal to request agent shutdown.
 */

import type {
  Agent,
  AgentId,
  GovernanceController,
  ReconcileContext,
  ReconcileResult,
  ReconciliationController,
  SubsystemToken,
} from "@koi/core";
import { GOVERNANCE } from "@koi/core";

const MAX_CONSECUTIVE_VIOLATIONS = 5;
const RECHECK_MS = 5_000;

/**
 * Lookup function to resolve AgentId → Agent entity.
 * The engine runtime provides this; it maps from the registry's AgentId
 * to the in-memory Agent entity that carries governance components.
 */
export type AgentLookup = (agentId: AgentId) => Agent | undefined;

export function createGovernanceReconciler(agentLookup: AgentLookup): ReconciliationController {
  const violationCounts = new Map<string, number>();

  return {
    name: "koi:governance-reconciler",

    async reconcile(targetAgentId: AgentId, _ctx: ReconcileContext): Promise<ReconcileResult> {
      const agent = agentLookup(targetAgentId);
      if (agent === undefined) {
        return { kind: "converged" };
      }

      // Get governance controller from agent components
      const controller = agent.component<GovernanceController>(
        GOVERNANCE as SubsystemToken<GovernanceController>,
      );
      if (controller === undefined) {
        return { kind: "converged" };
      }

      const snap = await controller.snapshot();
      if (snap.healthy) {
        violationCounts.delete(targetAgentId);
        return { kind: "converged" };
      }

      const count = (violationCounts.get(targetAgentId) ?? 0) + 1;
      violationCounts.set(targetAgentId, count);

      if (count >= MAX_CONSECUTIVE_VIOLATIONS) {
        return {
          kind: "terminal",
          reason: `Governance violation persisted: ${snap.violations.join(", ")}`,
        };
      }

      return { kind: "recheck", afterMs: RECHECK_MS };
    },

    async [Symbol.asyncDispose](): Promise<void> {
      violationCounts.clear();
    },
  };
}
