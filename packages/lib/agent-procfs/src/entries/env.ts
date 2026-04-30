import type { Agent, AgentEnv, ProcEntry } from "@koi/core";
import { ENV } from "@koi/core";

/**
 * Returns a procfs entry exposing the agent's environment variables.
 *
 * Default-deny: when no allowlist is provided, both `read()` and `list()`
 * return empty results so procfs cannot become a credential exfiltration
 * channel. Operators must explicitly opt specific keys in via the
 * `allowedEnvKeys` parameter on AgentMounterConfig.
 */
export function envEntry(agent: Agent, allowedEnvKeys?: readonly string[]): ProcEntry {
  const allow = new Set(allowedEnvKeys ?? []);
  return {
    read: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined || allow.size === 0) {
        return {};
      }
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env.values)) {
        if (allow.has(k)) out[k] = v;
      }
      return out;
    },
    list: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined || allow.size === 0) {
        return [];
      }
      return Object.keys(env.values).filter((k) => allow.has(k));
    },
  };
}
