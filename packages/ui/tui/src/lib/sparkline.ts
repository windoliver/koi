/**
 * Unicode sparkline renderer for TUI forge view.
 *
 * Maps a series of numeric values to Unicode block characters (▁▂▃▄▅▆▇█)
 * for compact inline visualization in the terminal.
 */

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return "";

  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }

  const range = max - min;
  const lastIndex = SPARK_CHARS.length - 1;

  let result = "";
  for (const v of values) {
    const index =
      range === 0 ? Math.floor(lastIndex / 2) : Math.round(((v - min) / range) * lastIndex);
    result += SPARK_CHARS[index];
  }
  return result;
}

/** Trend direction derived from a sparkline series. */
export type TrendDirection = "rising" | "declining" | "flat";

/**
 * Compute the trend direction of a numeric series by comparing
 * the average of the first half to the average of the second half.
 * Returns "flat" when the series is too short or the halves are equal.
 */
export function computeTrend(values: readonly number[]): TrendDirection {
  if (values.length < 2) return "flat";

  const mid = Math.floor(values.length / 2);
  let firstSum = 0;
  let secondSum = 0;

  for (let i = 0; i < mid; i++) {
    const v = values[i];
    if (v !== undefined) firstSum += v;
  }
  for (let i = mid; i < values.length; i++) {
    const v = values[i];
    if (v !== undefined) secondSum += v;
  }

  const firstAvg = firstSum / mid;
  const secondAvg = secondSum / (values.length - mid);

  if (secondAvg > firstAvg) return "rising";
  if (secondAvg < firstAvg) return "declining";
  return "flat";
}
