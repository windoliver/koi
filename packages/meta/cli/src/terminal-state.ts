/**
 * Terminal state sentinel — crash recovery for raw-mode TUI sessions.
 *
 * SIGKILL is uncatchable, so when the OS OOM-kills `koi up` while the TUI
 * is in raw mode with mouse tracking, the terminal is left broken. This
 * module saves terminal state to a sentinel file before entering raw mode
 * and restores it on next startup if the previous process died unexpectedly.
 *
 * Flow:
 *   1. `saveTerminalState()` — called before TUI enters raw mode
 *   2. `clearTerminalState()` — called on clean exit
 *   3. `restoreCrashedTerminal()` — called at startup, auto-restores if needed
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_DIR = join(homedir(), ".koi");
const SENTINEL_FILE = join(SENTINEL_DIR, ".terminal-sentinel");

/** Escape sequences to undo raw-mode TUI artifacts. */
const TERMINAL_RESET_SEQUENCES = [
  "\x1b[?1000l", // disable mouse click tracking
  "\x1b[?1002l", // disable mouse button-event tracking
  "\x1b[?1003l", // disable mouse any-event tracking
  "\x1b[?1006l", // disable SGR mouse mode
  "\x1b[?1049l", // exit alternate screen buffer
  "\x1b[?25h", // show cursor
].join("");

// ---------------------------------------------------------------------------
// Sentinel file schema
// ---------------------------------------------------------------------------

interface TerminalSentinel {
  readonly sttyState: string;
  readonly pid: number;
}

function isValidSentinel(value: unknown): value is TerminalSentinel {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.sttyState === "string" && typeof obj.pid === "number";
}

// ---------------------------------------------------------------------------
// PID liveness (same pattern as nexus-embed/pid-manager.ts)
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Saves the current terminal state to a sentinel file.
 *
 * Call this just before the TUI enters raw mode. The sentinel records the
 * `stty -g` snapshot and the current PID so that `restoreCrashedTerminal()`
 * can detect a dead process and restore the terminal on next startup.
 */
export function saveTerminalState(): void {
  try {
    const result = spawnSync("stty", ["-g"], {
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 3000,
    });
    if (result.status !== 0 || result.stdout === null) return;

    const sttyState = result.stdout.toString().trim();
    if (sttyState === "") return;

    const sentinel: TerminalSentinel = { sttyState, pid: process.pid };

    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(SENTINEL_FILE, JSON.stringify(sentinel), "utf-8");
  } catch {
    // Best effort — never block TUI startup
  }
}

/**
 * Deletes the sentinel file. Call on clean exit.
 */
export function clearTerminalState(): void {
  try {
    if (existsSync(SENTINEL_FILE)) {
      unlinkSync(SENTINEL_FILE);
    }
  } catch {
    // Best effort
  }
}

/**
 * Detects a crashed terminal session from a previous run.
 *
 * Returns the saved sentinel if the file exists and the recorded PID is dead.
 * Returns `undefined` if no crash is detected (no sentinel, PID still alive,
 * or sentinel is malformed).
 */
export function detectCrashedTerminal(): TerminalSentinel | undefined {
  try {
    if (!existsSync(SENTINEL_FILE)) return undefined;

    const raw = readFileSync(SENTINEL_FILE, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidSentinel(parsed)) {
      // Malformed sentinel — clean it up
      unlinkSync(SENTINEL_FILE);
      return undefined;
    }

    // If the process is still alive, the sentinel is valid (TUI is running)
    if (isProcessAlive(parsed.pid)) return undefined;

    return parsed;
  } catch {
    // JSON parse or file read failed — clean up the corrupt sentinel
    try {
      if (existsSync(SENTINEL_FILE)) unlinkSync(SENTINEL_FILE);
    } catch {
      // Best effort
    }
    return undefined;
  }
}

/**
 * Restores the terminal from a crashed session if one is detected.
 *
 * Runs `stty <saved_state>` to restore terminal settings, writes escape
 * sequences to disable mouse tracking and exit alternate screen, then
 * deletes the sentinel file.
 *
 * Returns `true` if a crash was detected and recovery was attempted.
 */
export function restoreCrashedTerminal(): boolean {
  const sentinel = detectCrashedTerminal();
  if (sentinel === undefined) return false;

  try {
    // Restore terminal settings via stty
    spawnSync("stty", [sentinel.sttyState], {
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 3000,
    });

    // Write escape sequences to undo mouse tracking and alternate screen
    process.stdout.write(TERMINAL_RESET_SEQUENCES);

    process.stderr.write("Restored terminal state from previous crash.\n");
  } catch {
    // Best effort — even partial restore is better than nothing
  }

  // Always clean up the sentinel
  clearTerminalState();
  return true;
}
