/**
 * Environment variable resolution for child processes.
 *
 * Default: safe allowlist that prevents leaking secrets (API keys, tokens).
 * Mirrors the env scrubbing pattern from packages/node/src/tools/shell.ts.
 */

import type { EnvStrategy } from "./types.js";

const SAFE_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
  "TMPDIR",
  "TZ",
];

/**
 * Resolve environment variables for a child process based on the strategy.
 *
 * - `undefined` / allowlist: only safe keys from process.env
 * - `inherit`: full process.env (use with caution)
 * - `explicit`: only the provided key-value pairs
 */
export function resolveEnv(strategy: EnvStrategy | undefined): Record<string, string> {
  if (strategy === undefined) {
    return filterEnv(SAFE_ENV_KEYS);
  }

  switch (strategy.kind) {
    case "inherit": {
      const result: Record<string, string> = {};
      for (const [key, val] of Object.entries(process.env)) {
        if (val !== undefined) {
          result[key] = val;
        }
      }
      return result;
    }
    case "allowlist":
      return filterEnv(strategy.keys);
    case "explicit":
      return { ...strategy.env };
  }
}

function filterEnv(keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const val = process.env[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}
