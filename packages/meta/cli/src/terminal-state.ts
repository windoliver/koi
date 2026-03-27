/**
 * Terminal state sentinel — crash recovery for raw-mode TUI sessions.
 *
 * SIGKILL is uncatchable, so when the OS OOM-kills `koi up` while the TUI
 * is in raw mode with mouse tracking, the terminal is left broken. This
 * module saves terminal state to a PID-keyed sentinel file before entering
 * raw mode and restores it on next startup if the previous process died.
 *
 * Sentinel files are keyed by PID (`.terminal-sentinel-{pid}`) so that
 * concurrent koi up / koi tui sessions don't clobber each other.
 *
 * Flow:
 *   1. `saveTerminalState()` — called before TUI enters raw mode
 *   2. `clearTerminalState()` — called on clean exit
 *   3. `restoreCrashedTerminal()` — called at startup, restores ALL dead sentinels
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_DIR = join(homedir(), ".koi");
const SENTINEL_PREFIX = ".terminal-sentinel-";

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
// Helpers
// ---------------------------------------------------------------------------

/** Returns the sentinel file path for the current process. */
function sentinelPath(): string {
  return join(SENTINEL_DIR, `${SENTINEL_PREFIX}${String(process.pid)}`);
}

/**
 * Lists all sentinel files in the sentinel directory.
 * Returns full paths.
 */
function listSentinelFiles(): readonly string[] {
  try {
    if (!existsSync(SENTINEL_DIR)) return [];
    return readdirSync(SENTINEL_DIR)
      .filter((name) => name.startsWith(SENTINEL_PREFIX))
      .map((name) => join(SENTINEL_DIR, name));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Saves the current terminal state to a PID-keyed sentinel file.
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
    writeFileSync(sentinelPath(), JSON.stringify(sentinel), "utf-8");
  } catch {
    // Best effort — never block TUI startup
  }
}

/**
 * Deletes this process's sentinel file. Call on clean exit.
 */
export function clearTerminalState(): void {
  try {
    const path = sentinelPath();
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Best effort
  }
}

/**
 * Scans all sentinel files and restores terminals from any crashed sessions.
 *
 * A sentinel is considered crashed if its recorded PID is no longer alive.
 * For each crashed sentinel, runs `stty <saved_state>` and writes escape
 * sequences to disable mouse tracking and exit alternate screen.
 *
 * Returns `true` if at least one crash was detected and recovery attempted.
 */
export function restoreCrashedTerminal(): boolean {
  let recovered = false;

  for (const filePath of listSentinelFiles()) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (!isValidSentinel(parsed)) {
        // Malformed sentinel — clean it up
        unlinkSync(filePath);
        continue;
      }

      // Skip sentinels whose process is still alive
      if (isProcessAlive(parsed.pid)) continue;

      // Dead process — restore terminal from this sentinel.
      // Only consume the sentinel if stty actually succeeds, so that a
      // non-TTY process (CI, background) doesn't discard the record
      // without repairing the terminal the user is sitting in.
      const sttyResult = spawnSync("stty", [parsed.sttyState], {
        stdio: ["inherit", "pipe", "pipe"],
        timeout: 3000,
      });

      if (sttyResult.status !== 0) {
        // stty failed (no TTY, wrong terminal) — leave sentinel for
        // the actual interactive session to pick up later.
        continue;
      }

      process.stdout.write(TERMINAL_RESET_SEQUENCES);
      recovered = true;

      // Clean up only after successful restore
      unlinkSync(filePath);
    } catch {
      // Best effort — try to clean up the file even on error
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        // Ignore
      }
    }
  }

  if (recovered) {
    process.stderr.write("Restored terminal state from previous crash.\n");
  }

  return recovered;
}
