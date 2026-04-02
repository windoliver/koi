/**
 * Environment variable substitution for hook config values.
 *
 * Expands `${VAR_NAME}` patterns in strings using `process.env`.
 * Rejects unresolved variables to fail closed on misconfiguration —
 * hooks should not silently run with empty auth headers or signing keys.
 */

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Expand `${VAR}` references in a string using process.env.
 * Returns the expanded string, or an error listing unresolved variable names.
 */
export function expandEnvVars(
  value: string,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const missing: string[] = [];

  const expanded = value.replace(ENV_VAR_PATTERN, (_, name: string) => {
    const resolved = process.env[name];
    if (resolved === undefined) {
      missing.push(name);
      return "";
    }
    return resolved;
  });

  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, value: expanded };
}

/**
 * Expand env vars in all values of a string record.
 * Returns the expanded record, or an error listing unresolved variable names.
 */
export function expandEnvVarsInRecord(
  record: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly missing: readonly string[] } {
  const result: Record<string, string> = {};
  const allMissing: string[] = [];

  for (const [key, val] of Object.entries(record)) {
    const expanded = expandEnvVars(val);
    if (!expanded.ok) {
      allMissing.push(...expanded.missing);
      result[key] = "";
    } else {
      result[key] = expanded.value;
    }
  }

  if (allMissing.length > 0) {
    return { ok: false, missing: allMissing };
  }
  return { ok: true, value: result };
}
