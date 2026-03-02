/**
 * /agents/<id>/status — read agent process state.
 */

import type { Agent, ProcEntry } from "@koi/core";

export function createStatusEntry(agent: Agent): ProcEntry {
  return {
    read: () => ({
      pid: agent.pid,
      state: agent.state,
      terminationOutcome: agent.terminationOutcome,
    }),
  };
}
