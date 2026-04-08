/**
 * Doom loop detection — pure functions + data structures.
 *
 * A "doom loop" occurs when the model calls the same tool with identical
 * arguments across consecutive turns, ignoring the result it already received.
 *
 * Uses per-key streak counters (Map<string, number>) bounded by tools-per-turn,
 * not session length.
 */

/** Default consecutive turns before intervention. */
export const DEFAULT_DOOM_LOOP_THRESHOLD = 3;

/** Default max interventions before giving up (maxTurns is the ultimate cap). */
export const DEFAULT_MAX_DOOM_LOOP_INTERVENTIONS = 2;

/**
 * Check whether ALL keys in `currentKeys` have a consecutive streak
 * >= `threshold` in the streak map. This ensures we only intervene when
 * the model is making zero progress — if even one call is new/different,
 * the model is doing something different and should be allowed to proceed.
 *
 * Returns the first offending key (`toolName\0canonicalArgs`) or null.
 * Pure function — no mutations.
 */
export function detectDoomLoop(
  streaks: ReadonlyMap<string, number>,
  currentKeys: readonly string[],
  threshold: number,
): string | null {
  if (threshold < 2 || currentKeys.length === 0) return null;

  // let justified: mutable tracker for first offending key
  let firstRepeated: string | null = null;
  for (const key of currentKeys) {
    const count = streaks.get(key);
    if (count === undefined || count < threshold) return null; // at least one call is new → no doom loop
    if (firstRepeated === null) firstRepeated = key;
  }
  return firstRepeated;
}

/**
 * Update streak counters after a turn's tool calls.
 *
 * Increments keys present in `currentKeys`, drops keys absent (streak broken).
 * Returns a new Map — does not mutate the input.
 */
export function updateStreaks(
  streaks: ReadonlyMap<string, number>,
  currentKeys: readonly string[],
): Map<string, number> {
  const next = new Map<string, number>();
  for (const key of currentKeys) {
    const prev = streaks.get(key) ?? 0;
    next.set(key, prev + 1);
  }
  return next;
}

/**
 * Parse a doom-loop key back into tool name and canonical args.
 * Key format: `${toolName}\0${canonicalArgs}` (same as within-turn dedup).
 */
export function parseDoomLoopKey(key: string): {
  readonly toolName: string;
  readonly canonicalArgs: string;
} {
  const sep = key.indexOf("\0");
  return sep === -1
    ? { toolName: key, canonicalArgs: "" }
    : { toolName: key.slice(0, sep), canonicalArgs: key.slice(sep + 1) };
}
