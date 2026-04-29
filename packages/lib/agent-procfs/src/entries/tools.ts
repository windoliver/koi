import type { Agent, ProcEntry, Tool } from "@koi/core";

export function toolsEntry(agent: Agent): ProcEntry {
  return {
    read: () => {
      const tools = agent.query<Tool>("tool:");
      // agent.query returns a ReadonlyMap, which doesn't have a direct .entries() in all TS contexts
      // Use Array.from(...) for compatibility
      const entries = Array.from(tools.entries());
      return entries.map(([token, tool]) => ({
        token: token as string,
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        policy: tool.policy,
      }));
    },
    list: () => {
      const tools = agent.query<Tool>("tool:");
      return Array.from(tools.keys()).map((t) => t as string);
    },
  };
}
