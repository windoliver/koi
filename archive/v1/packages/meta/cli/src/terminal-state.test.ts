import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

import { clearTerminalState, restoreCrashedTerminal, saveTerminalState } from "./terminal-state.js";

const SENTINEL_DIR = join(homedir(), ".koi");
const SENTINEL_PREFIX = ".terminal-sentinel-";

/** Returns sentinel path for an arbitrary PID. */
function sentinelPathForPid(pid: number): string {
  return join(SENTINEL_DIR, `${SENTINEL_PREFIX}${String(pid)}`);
}

/** Returns the sentinel file path for the current process. */
function currentSentinelPath(): string {
  return sentinelPathForPid(process.pid);
}

/** Get the current TTY device path, or undefined if not a TTY. */
function getTty(): string | undefined {
  const result = spawnSync("tty", [], {
    stdio: ["inherit", "pipe", "pipe"],
    timeout: 3000,
  });
  if (result.status !== 0 || result.stdout === null) return undefined;
  const tty = result.stdout.toString().trim();
  if (tty === "" || tty === "not a tty") return undefined;
  return tty;
}

/** Clean up all test sentinel files. */
function cleanAllSentinels(): void {
  try {
    if (!existsSync(SENTINEL_DIR)) return;
    for (const name of readdirSync(SENTINEL_DIR)) {
      if (name.startsWith(SENTINEL_PREFIX)) {
        unlinkSync(join(SENTINEL_DIR, name));
      }
    }
  } catch {
    // Best effort
  }
}

// Save and restore any existing sentinel files around tests
let savedSentinels: Array<{ path: string; content: string }> = [];

beforeEach(() => {
  savedSentinels = [];
  try {
    if (existsSync(SENTINEL_DIR)) {
      for (const name of readdirSync(SENTINEL_DIR)) {
        if (name.startsWith(SENTINEL_PREFIX)) {
          const path = join(SENTINEL_DIR, name);
          savedSentinels.push({ path, content: readFileSync(path, "utf-8") });
          unlinkSync(path);
        }
      }
    }
  } catch {
    // Best effort
  }
});

afterEach(() => {
  cleanAllSentinels();
  for (const { path, content } of savedSentinels) {
    try {
      mkdirSync(SENTINEL_DIR, { recursive: true });
      writeFileSync(path, content, "utf-8");
    } catch {
      // Best effort
    }
  }
  savedSentinels = [];
});

describe("saveTerminalState", () => {
  test("creates PID-keyed sentinel with tty field when TTY is available", () => {
    saveTerminalState();

    if (!process.stdin.isTTY) return;

    const path = currentSentinelPath();
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { pid: number; sttyState: string; tty: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.sttyState).toBe("string");
    expect(parsed.sttyState.length).toBeGreaterThan(0);
    expect(typeof parsed.tty).toBe("string");
    expect(parsed.tty.startsWith("/dev/")).toBe(true);
  });

  test("does not throw in non-TTY environments", () => {
    expect(() => saveTerminalState()).not.toThrow();
  });
});

describe("clearTerminalState", () => {
  test("removes only this process's sentinel file", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const ownPath = currentSentinelPath();
    const otherPath = sentinelPathForPid(99999);
    const tty = getTty() ?? "/dev/test";
    writeFileSync(ownPath, JSON.stringify({ sttyState: "test", pid: process.pid, tty }), "utf-8");
    writeFileSync(otherPath, JSON.stringify({ sttyState: "other", pid: 99999, tty }), "utf-8");

    clearTerminalState();

    expect(existsSync(ownPath)).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
  });

  test("is a no-op when no sentinel exists", () => {
    expect(() => clearTerminalState()).not.toThrow();
  });
});

describe("restoreCrashedTerminal", () => {
  test("returns false when no sentinels exist", () => {
    expect(restoreCrashedTerminal()).toBe(false);
  });

  test("returns false in non-TTY environment", () => {
    if (process.stdin.isTTY) return; // skip on real TTY
    expect(restoreCrashedTerminal()).toBe(false);
  });

  test("skips sentinels from a different TTY", () => {
    if (!process.stdin.isTTY) return;

    const deadPid = 2147483647;
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(deadPid);
    writeFileSync(
      path,
      JSON.stringify({ sttyState: "test-state", pid: deadPid, tty: "/dev/ttys999" }),
      "utf-8",
    );

    // Sentinel is for a different TTY — should be skipped, not consumed
    expect(restoreCrashedTerminal()).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("restores sentinel matching current TTY with real stty state", () => {
    if (!process.stdin.isTTY) return;

    const tty = getTty();
    if (tty === undefined) return;

    const sttyResult = spawnSync("stty", ["-g"], {
      stdio: ["inherit", "pipe", "pipe"],
      timeout: 3000,
    });
    if (sttyResult.status !== 0) return;
    const realState = sttyResult.stdout.toString().trim();

    const deadPid = 2147483647;
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(deadPid);
    writeFileSync(path, JSON.stringify({ sttyState: realState, pid: deadPid, tty }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("skips sentinels whose PID is still alive", () => {
    if (!process.stdin.isTTY) return;
    const tty = getTty() ?? "/dev/test";

    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = currentSentinelPath();
    writeFileSync(path, JSON.stringify({ sttyState: "test", pid: process.pid, tty }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("cleans up malformed sentinel files", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(12345);
    writeFileSync(path, "not-json{{{", "utf-8");

    restoreCrashedTerminal();
    expect(existsSync(path)).toBe(false);
  });

  test("cleans up sentinel with missing fields (no tty)", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(12345);
    writeFileSync(path, JSON.stringify({ pid: 123, sttyState: "x" }), "utf-8");

    restoreCrashedTerminal();
    expect(existsSync(path)).toBe(false);
  });
});
