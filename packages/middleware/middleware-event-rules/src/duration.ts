/**
 * Duration string parser — converts "30s", "5m", "1h" to milliseconds.
 */

const DURATION_RE = /^(\d+)(s|m|h)$/;

const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a duration string into milliseconds.
 *
 * @returns milliseconds, or `undefined` for invalid/zero input.
 */
export function parseDuration(input: string): number | undefined {
  const match = DURATION_RE.exec(input);
  if (match === null) return undefined;
  const value = Number(match[1]);
  const unit = match[2];
  if (value === 0 || unit === undefined) return undefined;
  const multiplier = UNIT_MS[unit];
  if (multiplier === undefined) return undefined;
  return value * multiplier;
}
