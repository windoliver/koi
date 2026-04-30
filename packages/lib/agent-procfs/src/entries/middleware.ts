import type { Agent, ProcEntry } from "@koi/core";

export function middlewareEntry(agent: Agent): ProcEntry {
  // Middleware components are keyed by `middleware:<name>` SubsystemTokens.
  // Enumerate via agent.query<unknown>("middleware:") and report names + token.
  return {
    read: () => {
      const mw = agent.query<unknown>("middleware:");
      return Array.from(mw.keys()).map((token) => ({
        token,
        name: token.replace(/^middleware:/, ""),
      }));
    },
    list: () => Array.from(agent.query<unknown>("middleware:").keys()),
  };
}
