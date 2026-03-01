/**
 * /agents/<id>/children — list child agent IDs from registry.
 */

import type { AgentId, AgentRegistry, ProcEntry } from "@koi/core";

export function createChildrenEntry(agentId: AgentId, registry: AgentRegistry): ProcEntry {
  return {
    read: async () => {
      const children = await registry.list({ parentId: agentId });
      return children.map((entry) => ({
        agentId: entry.agentId,
        agentType: entry.agentType,
        phase: entry.status.phase,
        priority: entry.priority,
      }));
    },
    list: async () => {
      const children = await registry.list({ parentId: agentId });
      return children.map((entry) => entry.agentId as string);
    },
  };
}
