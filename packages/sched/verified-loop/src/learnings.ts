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

  // Use let — justified: try/catch must reassign across boundaries
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

  // Validate each entry structurally and drop malformed members. Learnings
  // are advisory — a single corrupt row (hand edit, partial write) must not
  // throw inside iterationPrompt or verify and abort the whole run.
  const rawEntries = (parsed as { readonly entries: readonly unknown[] }).entries;
  const valid: LearningsEntry[] = [];
  // Use let — justified: track whether any entries were dropped to log once.
  let droppedCount = 0;
  for (const item of rawEntries) {
    const entry = validateLearningsEntry(item);
    if (entry === undefined) {
      droppedCount += 1;
    } else {
      valid.push(entry);
    }
  }
  if (droppedCount > 0) {
    console.warn(
      `[verified-loop] Dropped ${droppedCount} malformed learnings entry(s) from ${path}`,
    );
  }
  return valid;
}

/**
 * Validate one learnings entry. Returns the entry (typed) on success, or
 * undefined if the row is malformed. Strings inside arrays are filtered to
 * tolerate a partially corrupt `discovered`/`failed` list.
 */
function validateLearningsEntry(item: unknown): LearningsEntry | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const obj = item as Record<string, unknown>;
  if (typeof obj.iteration !== "number") return undefined;
  if (typeof obj.timestamp !== "string") return undefined;
  if (obj.itemId !== undefined && typeof obj.itemId !== "string") return undefined;
  if (typeof obj.context !== "string") return undefined;
  if (!Array.isArray(obj.discovered)) return undefined;
  if (!Array.isArray(obj.failed)) return undefined;
  const discovered = obj.discovered.filter((s): s is string => typeof s === "string");
  const failed = obj.failed.filter((s): s is string => typeof s === "string");
  return {
    iteration: obj.iteration,
    timestamp: obj.timestamp,
    itemId: obj.itemId as string | undefined,
    discovered,
    failed,
    context: obj.context,
  };
}

/** Append a learning entry, enforcing the rolling-window cap. */
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
