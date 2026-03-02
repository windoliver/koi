/**
 * /agents/<id>/tools — list attached tools.
 */

import type { Agent, ProcEntry, Tool } from "@koi/core";

export function createToolsEntry(agent: Agent): ProcEntry {
  return {
    read: () => {
      const tools = agent.query<Tool>("tool:");
      return [...tools.entries()].map(([token, tool]) => ({
        token: token as string,
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        trustTier: tool.trustTier,
      }));
    },
    list: () => {
      const tools = agent.query<Tool>("tool:");
      return [...tools.keys()].map((t) => t as string);
    },
  };
}
