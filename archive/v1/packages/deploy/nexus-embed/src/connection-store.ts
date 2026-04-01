/**
 * Persistent connection state for the Nexus embed daemon.
 *
 * Reads/writes ~/.koi/nexus/embed.json with port, PID, host, and profile.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTION_STATE_FILE } from "./constants.js";
import type { ConnectionState } from "./types.js";

/** Read connection state from embed.json. Returns undefined if missing or corrupt. */
export function readConnectionState(dataDir: string): ConnectionState | undefined {
  const statePath = join(dataDir, CONNECTION_STATE_FILE);
  try {
    if (!existsSync(statePath)) return undefined;
    const content = readFileSync(statePath, "utf-8");
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.port !== "number" || typeof obj.pid !== "number") return undefined;
    return parsed as ConnectionState;
  } catch {
    return undefined;
  }
}

/** Write connection state to embed.json. Creates directory if needed. */
export function writeConnectionState(dataDir: string, state: ConnectionState): void {
  mkdirSync(dataDir, { recursive: true });
  const statePath = join(dataDir, CONNECTION_STATE_FILE);
  writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o644 });
}

/** Remove connection state file. */
export function removeConnectionState(dataDir: string): void {
  const statePath = join(dataDir, CONNECTION_STATE_FILE);
  try {
    unlinkSync(statePath);
  } catch {
    // File may not exist — that's fine
  }
}
