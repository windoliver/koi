/**
 * Gate state persistence for the dream middleware.
 *
 * Stores { lastDreamAt, sessionsSinceDream } in a JSON file at
 * `<memoryDir>/.dream-gate.json`. Missing or corrupted files
 * return a default zero state rather than throwing.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamGateState } from "@koi/dream";

const GATE_FILE = ".dream-gate.json";

const DEFAULT_STATE: DreamGateState = {
  lastDreamAt: 0,
  sessionsSinceDream: 0,
} as const;

function gateFilePath(memoryDir: string): string {
  return join(memoryDir, GATE_FILE);
}

function isValidGateState(value: unknown): value is DreamGateState {
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.lastDreamAt === "number" && typeof obj.sessionsSinceDream === "number";
}

/**
 * Loads gate state from disk.
 *
 * Returns default state `{ lastDreamAt: 0, sessionsSinceDream: 0 }` if the
 * file is missing or contains invalid JSON.
 */
export async function loadGateState(memoryDir: string): Promise<DreamGateState> {
  try {
    const raw = await readFile(gateFilePath(memoryDir), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (isValidGateState(parsed)) {
      return parsed;
    }
    return DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

/**
 * Saves gate state to disk.
 *
 * Writes atomically (overwrites existing file). Throws on I/O errors —
 * callers should handle persistence failures appropriately.
 */
export async function saveGateState(memoryDir: string, state: DreamGateState): Promise<void> {
  const content = JSON.stringify(state);
  await writeFile(gateFilePath(memoryDir), content, "utf-8");
}
