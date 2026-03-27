import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  test("creates PID-keyed sentinel file when TTY is available", () => {
    saveTerminalState();

    if (!process.stdin.isTTY) return;

    const path = currentSentinelPath();
    expect(existsSync(path)).toBe(true);

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as { pid: number; sttyState: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.sttyState).toBe("string");
    expect(parsed.sttyState.length).toBeGreaterThan(0);
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
    writeFileSync(ownPath, JSON.stringify({ sttyState: "test", pid: process.pid }), "utf-8");
    writeFileSync(otherPath, JSON.stringify({ sttyState: "other", pid: 99999 }), "utf-8");

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

  test("skips sentinels whose PID is still alive", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = currentSentinelPath();
    writeFileSync(path, JSON.stringify({ sttyState: "test", pid: process.pid }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(false);
    expect(existsSync(path)).toBe(true);
  });

  test("restores and cleans up sentinel for a dead PID", () => {
    const deadPid = 2147483647;
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(deadPid);
    writeFileSync(path, JSON.stringify({ sttyState: "test-state", pid: deadPid }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("handles multiple crashed sentinels", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const dead1 = sentinelPathForPid(2147483646);
    const dead2 = sentinelPathForPid(2147483647);
    writeFileSync(dead1, JSON.stringify({ sttyState: "s1", pid: 2147483646 }), "utf-8");
    writeFileSync(dead2, JSON.stringify({ sttyState: "s2", pid: 2147483647 }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(true);
    expect(existsSync(dead1)).toBe(false);
    expect(existsSync(dead2)).toBe(false);
  });

  test("cleans up malformed sentinel files", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(12345);
    writeFileSync(path, "not-json{{{", "utf-8");

    restoreCrashedTerminal();
    expect(existsSync(path)).toBe(false);
  });

  test("cleans up sentinel with missing fields", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const path = sentinelPathForPid(12345);
    writeFileSync(path, JSON.stringify({ pid: 123 }), "utf-8");

    restoreCrashedTerminal();
    expect(existsSync(path)).toBe(false);
  });

  test("leaves alive sentinels while cleaning dead ones", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    const alivePath = currentSentinelPath();
    const deadPath = sentinelPathForPid(2147483647);
    writeFileSync(alivePath, JSON.stringify({ sttyState: "alive", pid: process.pid }), "utf-8");
    writeFileSync(deadPath, JSON.stringify({ sttyState: "dead", pid: 2147483647 }), "utf-8");

    expect(restoreCrashedTerminal()).toBe(true);
    expect(existsSync(deadPath)).toBe(false);
    expect(existsSync(alivePath)).toBe(true);
  });
});
