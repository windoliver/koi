/**
 * Environment variable interpolation for raw YAML strings.
 *
 * Supports:
 * - `${VAR}` — replaced with env value, or empty string if unset
 * - `${VAR:-default}` — replaced with env value, or `default` if unset
 */

/** Pattern matches `${VAR}` and `${VAR:-default}` */
const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

/**
 * Interpolates `${VAR}` and `${VAR:-default}` references in a raw YAML string.
 *
 * @param raw - The raw YAML string with env var references
 * @param env - Environment variables map (defaults to `process.env`)
 * @returns The interpolated string
 */
export function interpolateEnv(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return raw.replace(ENV_PATTERN, (_match, name: string, defaultValue?: string) => {
    const value = env[name];
    if (value !== undefined) {
      return value;
    }
    return defaultValue ?? "";
  });
}
