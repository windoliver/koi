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
