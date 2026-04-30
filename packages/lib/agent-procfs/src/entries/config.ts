import type { Agent, ProcEntry } from "@koi/core";

export function configEntry(agent: Agent): ProcEntry {
  return {
    read: () => ({
      name: agent.manifest.name,
      description: agent.manifest.description,
      model: agent.manifest.model,
      lifecycle: agent.manifest.lifecycle,
    }),
  };
}
