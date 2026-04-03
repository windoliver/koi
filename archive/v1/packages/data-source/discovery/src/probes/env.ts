/**
 * Environment probe — scans environment variables matching patterns
 * and infers data source protocol from connection URI prefixes.
 *
 * SECURITY: Never logs or includes the actual credential value in descriptors.
 */

import type { DataSourceProbeResult } from "../types.js";

/** Map of URI prefixes to protocol identifiers. */
const PROTOCOL_PREFIX_MAP: Readonly<Record<string, string>> = {
  "postgres://": "postgres",
  "postgresql://": "postgres",
  "mysql://": "mysql",
  "sqlite://": "sqlite",
  "sqlite:": "sqlite",
};

/** Infer protocol from a connection URI value. */
function inferProtocol(value: string): string | undefined {
  for (const [prefix, protocol] of Object.entries(PROTOCOL_PREFIX_MAP)) {
    if (value.startsWith(prefix)) return protocol;
  }
  return undefined;
}

/** Simple glob matching: *FOO* matches anything containing FOO. */
function matchesPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
  return regex.test(name);
}

/** Probe environment variables matching the given patterns and infer data source descriptors. */
export function probeEnv(
  env: Readonly<Record<string, string | undefined>>,
  patterns: readonly string[],
): readonly DataSourceProbeResult[] {
  const results: DataSourceProbeResult[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value.trim() === "") continue;

    const matches = patterns.some((p) => matchesPattern(name, p));
    if (!matches) continue;

    const protocol = inferProtocol(value);
    if (protocol === undefined) continue;

    results.push({
      source: "env",
      descriptor: {
        name: name.toLowerCase().replace(/_/g, "-"),
        protocol,
        description: `Discovered from environment variable ${name}`,
        auth: { kind: "connection_string", ref: name },
      },
    });
  }

  return results;
}
