import type { Agent, AgentRegistry, ProcEntry } from "@koi/core";

export function statusEntry(agent: Agent, registry: AgentRegistry): ProcEntry {
  return {
    // Always resolve from the registry so phase transitions after mount
    // (e.g. running → terminated) are reflected on every read.
    read: async () => {
      const entry = await registry.lookup(agent.pid.id);
      if (entry === undefined) {
        return { pid: agent.pid, state: agent.state, terminationOutcome: agent.terminationOutcome };
      }
      return {
        pid: agent.pid,
        state: entry.status.phase,
        terminationOutcome: agent.terminationOutcome,
        generation: entry.status.generation,
        conditions: entry.status.conditions,
      };
    },
  };
}
