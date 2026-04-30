import type { Agent, AgentEnv, ProcEntry } from "@koi/core";
import { ENV } from "@koi/core";

// Redaction patterns for common secret-bearing env-var names. Matches are
// case-insensitive and applied as substring tests, so KEY/TOKEN/SECRET etc.
// catch the typical credential surface inherited via AgentEnv.
const SECRET_PATTERNS: readonly RegExp[] = [
  /key/i,
  /secret/i,
  /token/i,
  /password/i,
  /credential/i,
  /auth/i,
  /api[_-]?key/i,
  /private/i,
];

const REDACTED = "[REDACTED]";

function isSecretKey(name: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

function redact(values: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = isSecretKey(k) ? REDACTED : v;
  }
  return out;
}

export function envEntry(agent: Agent): ProcEntry {
  return {
    // Values are redacted by default — names of secret-bearing keys are
    // visible (operators need to know what's set) but their contents are
    // replaced with [REDACTED] to prevent secret exfiltration through procfs.
    read: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined) {
        return {};
      }
      return redact(env.values);
    },
    list: () => {
      const env = agent.component<AgentEnv>(ENV);
      if (env === undefined) {
        return [];
      }
      return Object.keys(env.values);
    },
  };
}
