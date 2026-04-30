import type { Agent, ProcEntry, Tool } from "@koi/core";

export function toolsEntry(agent: Agent): ProcEntry {
  return {
    read: () => {
      const tools = agent.query<Tool>("tool:");
      return Array.from(tools.entries()).map(([token, tool]) => ({
        token,
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        policy: tool.policy,
      }));
    },
    list: () => {
      const tools = agent.query<Tool>("tool:");
      return Array.from(tools.keys());
    },
  };
}
