import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  clearTerminalState,
  detectCrashedTerminal,
  restoreCrashedTerminal,
  saveTerminalState,
} from "./terminal-state.js";

const SENTINEL_DIR = join(homedir(), ".koi");
const SENTINEL_FILE = join(SENTINEL_DIR, ".terminal-sentinel");

// Backup and restore any existing sentinel file around tests
let originalSentinel: string | undefined;

beforeEach(() => {
  try {
    if (existsSync(SENTINEL_FILE)) {
      originalSentinel = readFileSync(SENTINEL_FILE, "utf-8");
      unlinkSync(SENTINEL_FILE);
    }
  } catch {
    originalSentinel = undefined;
  }
});

afterEach(() => {
  try {
    if (existsSync(SENTINEL_FILE)) {
      unlinkSync(SENTINEL_FILE);
    }
    if (originalSentinel !== undefined) {
      mkdirSync(SENTINEL_DIR, { recursive: true });
      writeFileSync(SENTINEL_FILE, originalSentinel, "utf-8");
    }
  } catch {
    // Best effort cleanup
  }
  originalSentinel = undefined;
});

describe("saveTerminalState", () => {
  test("creates sentinel file with pid and stty state when TTY is available", () => {
    saveTerminalState();

    // In non-TTY environments (CI), stty -g may fail and no sentinel is written
    if (!process.stdin.isTTY) {
      // stty -g requires a TTY — sentinel may not be created
      return;
    }

    expect(existsSync(SENTINEL_FILE)).toBe(true);

    const raw = readFileSync(SENTINEL_FILE, "utf-8");
    const parsed = JSON.parse(raw) as { pid: number; sttyState: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.sttyState).toBe("string");
    expect(parsed.sttyState.length).toBeGreaterThan(0);
  });

  test("does not throw in non-TTY environments", () => {
    // Should be a no-op when stty is unavailable
    expect(() => saveTerminalState()).not.toThrow();
  });
});

describe("clearTerminalState", () => {
  test("removes sentinel file", () => {
    // Write sentinel directly to avoid TTY dependency
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(SENTINEL_FILE, JSON.stringify({ sttyState: "test", pid: process.pid }), "utf-8");
    expect(existsSync(SENTINEL_FILE)).toBe(true);

    clearTerminalState();
    expect(existsSync(SENTINEL_FILE)).toBe(false);
  });

  test("is a no-op when no sentinel exists", () => {
    // Should not throw
    clearTerminalState();
    expect(existsSync(SENTINEL_FILE)).toBe(false);
  });
});

describe("detectCrashedTerminal", () => {
  test("returns undefined when no sentinel exists", () => {
    expect(detectCrashedTerminal()).toBeUndefined();
  });

  test("returns undefined when sentinel PID is still alive (current process)", () => {
    saveTerminalState();
    // The sentinel was written by the current process, which is alive
    expect(detectCrashedTerminal()).toBeUndefined();
  });

  test("returns sentinel when PID is dead", () => {
    // Write a sentinel with a PID that definitely doesn't exist
    const deadPid = 2147483647; // max PID, almost certainly not in use
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(
      SENTINEL_FILE,
      JSON.stringify({ sttyState: "test-state", pid: deadPid }),
      "utf-8",
    );

    const result = detectCrashedTerminal();
    expect(result).toBeDefined();
    expect(result?.pid).toBe(deadPid);
    expect(result?.sttyState).toBe("test-state");
  });

  test("cleans up malformed sentinel file", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(SENTINEL_FILE, "not-json{{{", "utf-8");

    expect(detectCrashedTerminal()).toBeUndefined();
    expect(existsSync(SENTINEL_FILE)).toBe(false);
  });

  test("cleans up sentinel with missing fields", () => {
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(SENTINEL_FILE, JSON.stringify({ pid: 123 }), "utf-8");

    expect(detectCrashedTerminal()).toBeUndefined();
    expect(existsSync(SENTINEL_FILE)).toBe(false);
  });
});

describe("restoreCrashedTerminal", () => {
  test("returns false when no crash detected", () => {
    expect(restoreCrashedTerminal()).toBe(false);
  });

  test("returns true and cleans up sentinel when crash detected", () => {
    const deadPid = 2147483647;
    mkdirSync(SENTINEL_DIR, { recursive: true });
    writeFileSync(
      SENTINEL_FILE,
      JSON.stringify({ sttyState: "test-state", pid: deadPid }),
      "utf-8",
    );

    const result = restoreCrashedTerminal();
    expect(result).toBe(true);
    // Sentinel should be cleaned up after restore
    expect(existsSync(SENTINEL_FILE)).toBe(false);
  });
});
