/**
 * PID file management for the Nexus embed daemon.
 *
 * Handles read/write/check of PID files with stale detection.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PID_FILE } from "./constants.js";

/** Read PID from file. Returns undefined if file doesn't exist or is corrupt. */
export function readPid(dataDir: string): number | undefined {
  const pidPath = join(dataDir, PID_FILE);
  try {
    if (!existsSync(pidPath)) return undefined;
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = Number.parseInt(content, 10);
    if (Number.isNaN(pid) || pid <= 0) return undefined;
    return pid;
  } catch {
    return undefined;
  }
}

/** Write PID to file. Creates directory if needed. */
export function writePid(dataDir: string, pid: number): void {
  mkdirSync(dataDir, { recursive: true });
  const pidPath = join(dataDir, PID_FILE);
  writeFileSync(pidPath, String(pid), { mode: 0o644 });
}

/** Remove PID file. */
export function removePid(dataDir: string): void {
  const pidPath = join(dataDir, PID_FILE);
  try {
    unlinkSync(pidPath);
  } catch {
    // File may not exist — that's fine
  }
}

/** Check if a process with the given PID is alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Clean up stale PID file if the process is dead. Returns true if cleaned. */
export function cleanStalePid(dataDir: string): boolean {
  const pid = readPid(dataDir);
  if (pid === undefined) return false;
  if (isProcessAlive(pid)) return false;
  removePid(dataDir);
  return true;
}
