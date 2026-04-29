import type { Agent, AgentRegistry, ProcEntry } from "@koi/core";

export function childrenEntry(agent: Agent, registry: AgentRegistry): ProcEntry {
  return {
    read: async () => {
      const children = await registry.list({ parentId: agent.pid.id });
      return children.map((entry) => ({
        agentId: entry.agentId,
        agentType: entry.agentType,
        phase: entry.status.phase,
        priority: entry.priority,
      }));
    },
    list: async () => {
      const children = await registry.list({ parentId: agent.pid.id });
      return children.map((entry) => entry.agentId as string);
    },
  };
}
