/**
 * Environment variable expansion with ${VAR} and ${VAR:-default} syntax.
 *
 * Compatible with Claude Code's env var expansion format.
 * Cannot import from @koi/hooks (L2 peer import rule).
 */

const ENV_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Expands environment variables in a string.
 *
 * Supports:
 * - `${VAR}` — expands to process.env.VAR
 * - `${VAR:-default}` — expands to process.env.VAR, or "default" if not set
 *
 * Returns the expanded string and a list of unresolved variables (missing + no default).
 */
export function expandEnvVars(value: string): {
  readonly expanded: string;
  readonly missing: readonly string[];
} {
  const missing: string[] = [];

  const expanded = value.replace(ENV_PATTERN, (_match, expr: string) => {
    const sepIndex = expr.indexOf(":-");
    if (sepIndex !== -1) {
      const varName = expr.slice(0, sepIndex);
      const defaultValue = expr.slice(sepIndex + 2);
      const envValue = process.env[varName];
      return envValue !== undefined && envValue !== "" ? envValue : defaultValue;
    }
    const envValue = process.env[expr];
    if (envValue === undefined || envValue === "") {
      missing.push(expr);
      return `\${${expr}}`; // preserve original for debugging
    }
    return envValue;
  });

  return { expanded, missing };
}

/**
 * Expands env vars in all string values of a record (shallow).
 * Returns the expanded record and all missing variables.
 */
export function expandEnvVarsInRecord(record: Readonly<Record<string, string>>): {
  readonly expanded: Record<string, string>;
  readonly missing: readonly string[];
} {
  const expanded: Record<string, string> = {};
  const allMissing: string[] = [];

  for (const [key, value] of Object.entries(record)) {
    const result = expandEnvVars(value);
    expanded[key] = result.expanded;
    allMissing.push(...result.missing);
  }

  return { expanded, missing: allMissing };
}
