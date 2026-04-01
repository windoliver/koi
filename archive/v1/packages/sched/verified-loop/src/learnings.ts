/**
 * Per-iteration learnings store with rolling window.
 *
 * Learnings are advisory — a malformed file is recovered gracefully
 * rather than failing the loop.
 */

import { rename } from "node:fs/promises";
import type { LearningsEntry, LearningsFile } from "./types.js";

/** Read learnings from a JSON file. Returns [] if missing or malformed. */
export async function readLearnings(path: string): Promise<readonly LearningsEntry[]> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return [];
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[verified-loop] Malformed learnings file, resetting: ${path}`);
    return [];
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("entries" in parsed) ||
    !Array.isArray((parsed as { readonly entries?: unknown }).entries)
  ) {
    console.warn(`[verified-loop] Learnings file missing 'entries' array, resetting: ${path}`);
    return [];
  }

  return (parsed as LearningsFile).entries;
}

/** Append a learning entry, enforcing the rolling window max. */
export async function appendLearning(
  path: string,
  entry: LearningsEntry,
  maxEntries: number,
): Promise<void> {
  const existing = await readLearnings(path);
  const combined = [...existing, entry];
  const trimmed =
    combined.length > maxEntries ? combined.slice(combined.length - maxEntries) : combined;

  const data: LearningsFile = { entries: trimmed };
  const tmpPath = `${path}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(data, null, 2));
  await rename(tmpPath, path);
}
