import type { Agent, ProcEntry } from "@koi/core";

export function statusEntry(agent: Agent): ProcEntry {
  return {
    read: () => ({
      pid: agent.pid,
      state: agent.state,
      terminationOutcome: agent.terminationOutcome,
    }),
  };
}
