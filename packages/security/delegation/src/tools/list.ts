/**
 * delegation_list tool — list active grants issued by this agent.
 *
 * Wraps DelegationManager.list() behind a Tool interface.
 */

import type { AgentId, JsonObject, Tool, ToolPolicy } from "@koi/core";
import type { DelegationManager } from "../delegation-manager.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDelegationListTool(
  manager: DelegationManager,
  ownerAgentId: AgentId,
  prefix: string,
  policy: ToolPolicy,
): Tool {
  return {
    descriptor: {
      name: `${prefix}_list`,
      description: "List all active delegation grants issued by or received by this agent.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    origin: "primordial",
    policy,
    execute: async (_args: JsonObject): Promise<unknown> => {
      const grants = manager.list(ownerAgentId);
      return {
        grants: grants.map((g) => ({
          id: g.id,
          issuerId: g.issuerId,
          delegateeId: g.delegateeId,
          scope: g.scope,
          expiresAt: g.expiresAt,
          chainDepth: g.chainDepth,
        })),
      };
    },
  };
}
