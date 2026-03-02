/**
 * /agents/<id>/env — read agent environment variables.
 */

import type { Agent, AgentEnv, ProcEntry } from "@koi/core";
import { ENV } from "@koi/core";

export function createEnvEntry(agent: Agent): ProcEntry {
  return {
    read: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined) return {};
      return { ...env.values };
    },
    list: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined) return [];
      return Object.keys(env.values);
    },
  };
}
