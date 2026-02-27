import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendSessionLog } from "./session-log.js";

// let — needed for mutable test directory reference
let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `koi-session-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("appendSessionLog", () => {
  test("creates sessions directory and file", async () => {
    const ts = new Date("2025-06-15T14:30:00Z");
    await appendSessionLog(testDir, "stored fact about Alice", ts);

    const filePath = join(testDir, "sessions", "2025-06-15.md");
    expect(existsSync(filePath)).toBe(true);
  });

  test("writes correct timestamp format", async () => {
    const ts = new Date("2025-06-15T09:05:00Z");
    await appendSessionLog(testDir, "test content", ts);

    const filePath = join(testDir, "sessions", "2025-06-15.md");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("- [09:05] test content\n");
  });

  test("appends multiple entries", async () => {
    const ts1 = new Date("2025-06-15T10:00:00Z");
    const ts2 = new Date("2025-06-15T11:30:00Z");
    await appendSessionLog(testDir, "first entry", ts1);
    await appendSessionLog(testDir, "second entry", ts2);

    const filePath = join(testDir, "sessions", "2025-06-15.md");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("- [10:00] first entry\n- [11:30] second entry\n");
  });

  test("separates entries by date", async () => {
    const ts1 = new Date("2025-06-15T23:00:00Z");
    const ts2 = new Date("2025-06-16T01:00:00Z");
    await appendSessionLog(testDir, "day one", ts1);
    await appendSessionLog(testDir, "day two", ts2);

    expect(existsSync(join(testDir, "sessions", "2025-06-15.md"))).toBe(true);
    expect(existsSync(join(testDir, "sessions", "2025-06-16.md"))).toBe(true);
  });

  test("pads single-digit month and day", async () => {
    const ts = new Date("2025-01-05T03:07:00Z");
    await appendSessionLog(testDir, "padded", ts);

    const filePath = join(testDir, "sessions", "2025-01-05.md");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toBe("- [03:07] padded\n");
  });
});
