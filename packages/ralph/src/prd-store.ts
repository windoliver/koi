/**
 * File-based PRD (Product Requirements Document) store.
 *
 * Reads, queries, and updates PRD items with atomic write-temp-rename.
 *
 * IMPORTANT: This module assumes a single event loop per PRD file.
 * The read-modify-write pattern in markDone/markSkipped is NOT safe
 * for concurrent multi-process access — concurrent writes will
 * silently overwrite each other. If multi-process access is needed,
 * add external file locking or serialise through a single coordinator.
 */

import { rename } from "node:fs/promises";
import type { KoiError, Result } from "@koi/core";
import { notFound, validation } from "@koi/core";
import type { PRDFile, PRDItem } from "./types.js";

/** Read and parse a PRD JSON file. */
export async function readPRD(path: string): Promise<Result<PRDFile, KoiError>> {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    return { ok: false, error: notFound(path, `PRD file not found: ${path}`) };
  }

  let raw: string;
  try {
    raw = await file.text();
  } catch (_e: unknown) {
    return { ok: false, error: notFound(path, `Failed to read PRD file: ${path}`) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_e: unknown) {
    return {
      ok: false,
      error: validation(`PRD file contains invalid JSON: ${path}`),
    };
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("items" in parsed) ||
    !Array.isArray((parsed as { readonly items?: unknown }).items)
  ) {
    return {
      ok: false,
      error: validation(`PRD file missing required 'items' array: ${path}`),
    };
  }

  return { ok: true, value: parsed as PRDFile };
}

/** Return the highest-priority undone/unskipped PRD item, or undefined if none remain. */
export function nextItem(items: readonly PRDItem[]): PRDItem | undefined {
  const candidates = items.filter((item) => !item.done && !item.skipped);
  if (candidates.length === 0) return undefined;
  // Sort by priority (lower = higher priority), preserve document order for ties
  const sorted = [...candidates].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  return sorted[0];
}

/** Mark a PRD item as skipped with atomic write-temp-rename. */
export async function markSkipped(path: string, itemId: string): Promise<Result<void, KoiError>> {
  const readResult = await readPRD(path);
  if (!readResult.ok) {
    return readResult;
  }

  const { items } = readResult.value;
  const index = items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return {
      ok: false,
      error: notFound(itemId, `PRD item not found: ${itemId}`),
    };
  }

  const target = items[index];
  if (target === undefined) {
    return {
      ok: false,
      error: notFound(itemId, `PRD item not found: ${itemId}`),
    };
  }

  const updated: PRDItem = {
    ...target,
    skipped: true,
  };

  const newItems = items.map((item, i) => (i === index ? updated : item));
  const newPrd: PRDFile = { items: newItems };

  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify(newPrd, null, 2);
  await Bun.write(tmpPath, json);
  await rename(tmpPath, path);

  return { ok: true, value: undefined };
}

/** Mark a PRD item as done with atomic write-temp-rename. */
export async function markDone(path: string, itemId: string): Promise<Result<void, KoiError>> {
  const readResult = await readPRD(path);
  if (!readResult.ok) {
    return readResult;
  }

  const { items } = readResult.value;
  const index = items.findIndex((item) => item.id === itemId);
  if (index === -1) {
    return {
      ok: false,
      error: notFound(itemId, `PRD item not found: ${itemId}`),
    };
  }

  const target = items[index];
  if (target === undefined) {
    return {
      ok: false,
      error: notFound(itemId, `PRD item not found: ${itemId}`),
    };
  }

  const updated: PRDItem = {
    ...target,
    done: true,
    verifiedAt: new Date().toISOString(),
    iterationCount: (target.iterationCount ?? 0) + 1,
  };

  const newItems = items.map((item, i) => (i === index ? updated : item));
  const newPrd: PRDFile = { items: newItems };

  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify(newPrd, null, 2);
  await Bun.write(tmpPath, json);
  await rename(tmpPath, path);

  return { ok: true, value: undefined };
}
