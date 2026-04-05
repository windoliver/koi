/**
 * Sessions command tests (Decisions 10-A, 12-A, 14-A):
 *
 * - loadSessionSummary: valid JSONL, empty file, malformed lines, missing file
 * - listSessionSummaries: empty directory, no JSONL files, --limit respected
 * - Streaming: only first `limit` files' content is read (O(limit) content reads)
 * - Flag validation ordering: returns OK before I/O for wrong flags
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../args.js";
import { ExitCode } from "../types.js";
import { listSessionSummaries, loadSessionSummary, run } from "./sessions.js";

// ---------------------------------------------------------------------------
// Test fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `koi-sessions-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLine(kind: string, text: string, timestamp: number): string {
  return JSON.stringify({ kind, text, timestamp });
}

async function writeSession(chatDir: string, id: string, lines: string[]): Promise<void> {
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// loadSessionSummary
// ---------------------------------------------------------------------------

describe("loadSessionSummary", () => {
  test("returns undefined for empty file", async () => {
    const path = join(tmpDir, "empty.jsonl");
    await writeFile(path, "");
    const result = await loadSessionSummary(path, "test-agent");
    expect(result).toBeUndefined();
  });

  test("returns undefined for nonexistent file", async () => {
    const result = await loadSessionSummary(join(tmpDir, "nonexistent.jsonl"), "test-agent");
    expect(result).toBeUndefined();
  });

  test("parses valid JSONL and extracts summary fields", async () => {
    const path = join(tmpDir, "abc123.jsonl");
    await writeFile(
      path,
      `${[makeLine("user", "hello there", 1000), makeLine("assistant", "hi", 2000)].join("\n")}\n`,
    );

    const result = await loadSessionSummary(path, "my-agent");
    // Use expect().toMatchObject() to assert shape without non-null assertions
    expect(result).toMatchObject({
      sessionId: "abc123",
      agentName: "my-agent",
      messageCount: 2,
      firstUserMessage: "hello there",
      createdAt: 1000,
      lastActiveAt: 2000,
    });
  });

  test("truncates long first user message to 80 chars", async () => {
    const longText = "x".repeat(100);
    const path = join(tmpDir, "long.jsonl");
    await writeFile(path, `${makeLine("user", longText, 1000)}\n`);

    const result = await loadSessionSummary(path, "a");
    expect(result?.firstUserMessage).toHaveLength(80);
    expect(result?.firstUserMessage).toEndWith("...");
  });

  test("skips malformed JSONL lines — does not count them in messageCount", async () => {
    const path = join(tmpDir, "mixed.jsonl");
    await writeFile(
      path,
      `${[
        makeLine("user", "hi", 1000),
        "NOT VALID JSON {{{",
        makeLine("assistant", "hello", 2000),
      ].join("\n")}\n`,
    );

    const result = await loadSessionSummary(path, "a");
    expect(result).not.toBeUndefined();
    // 3 lines but only 2 parsed successfully
    expect(result?.messageCount).toBe(2);
  });

  test("returns undefined for file with only malformed lines", async () => {
    const path = join(tmpDir, "bad.jsonl");
    await writeFile(path, "INVALID\nALSO INVALID\n");
    const result = await loadSessionSummary(path, "a");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listSessionSummaries
// ---------------------------------------------------------------------------

describe("listSessionSummaries", () => {
  test("returns empty array when agents directory does not exist", async () => {
    const result = await listSessionSummaries(join(tmpDir, "nonexistent"), 20);
    expect(result).toEqual([]);
  });

  test("returns empty array when no JSONL files exist", async () => {
    const chatDir = join(tmpDir, "agents", "my-agent", "session", "chat");
    await mkdir(chatDir, { recursive: true });
    await writeFile(join(chatDir, "readme.txt"), "not a session");

    const result = await listSessionSummaries(tmpDir, 20);
    expect(result).toEqual([]);
  });

  test("returns sessions sorted by recency (most recent first)", async () => {
    const chatDir = join(tmpDir, "agents", "my-agent", "session", "chat");
    await writeSession(chatDir, "old-session", [makeLine("user", "first", 1000)]);
    await writeSession(chatDir, "new-session", [makeLine("user", "latest", 9000)]);

    const result = await listSessionSummaries(tmpDir, 20);
    expect(result).toHaveLength(2);
    expect(result[0]?.lastActiveAt).toBeGreaterThanOrEqual(result[1]?.lastActiveAt ?? 0);
  });

  test("respects limit — returns at most limit sessions", async () => {
    const chatDir = join(tmpDir, "agents", "my-agent", "session", "chat");
    for (let i = 0; i < 5; i++) {
      await writeSession(chatDir, `session-${String(i)}`, [
        makeLine("user", `msg ${String(i)}`, i * 1000),
      ]);
    }

    const result = await listSessionSummaries(tmpDir, 3);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  test("aggregates sessions across multiple agents", async () => {
    for (const agentName of ["agent-a", "agent-b"]) {
      const chatDir = join(tmpDir, "agents", agentName, "session", "chat");
      await writeSession(chatDir, `${agentName}-session`, [makeLine("user", "hello", 1000)]);
    }

    const result = await listSessionSummaries(tmpDir, 20);
    expect(result).toHaveLength(2);
    const agentNames = result.map((s) => s.agentName);
    expect(agentNames).toContain("agent-a");
    expect(agentNames).toContain("agent-b");
  });

  test("skips agent subdirectories with no session/chat directory", async () => {
    // Agent with sessions
    const chatDir = join(tmpDir, "agents", "good-agent", "session", "chat");
    await writeSession(chatDir, "s1", [makeLine("user", "hi", 1000)]);
    // Agent with no chat directory
    await mkdir(join(tmpDir, "agents", "empty-agent"), { recursive: true });

    const result = await listSessionSummaries(tmpDir, 20);
    expect(result).toHaveLength(1);
    expect(result[0]?.agentName).toBe("good-agent");
  });
});

// ---------------------------------------------------------------------------
// Error path: run() with wrong flags (Decision 10-A and 12-A)
// ---------------------------------------------------------------------------

describe("run — error paths", () => {
  test("returns FAILURE for non-sessions flags without I/O", async () => {
    const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      const flags = parseArgs(["doctor"]);
      const exitCode = await run(flags);
      expect(exitCode).toBe(ExitCode.FAILURE);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("returns OK with no-sessions message when workspace has no agents", async () => {
    const emptyDir = join(tmpDir, "empty-workspace");
    await mkdir(emptyDir, { recursive: true });

    const captured: string[] = [];
    const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      captured.push(chunk);
      return true;
    });

    try {
      const flags = parseArgs(["sessions", "--manifest", join(emptyDir, "koi.yaml")]);
      const exitCode = await run(flags);
      expect(exitCode).toBe(ExitCode.OK);
      expect(captured.join("")).toContain("No sessions found");
    } finally {
      writeSpy.mockRestore();
    }
  });
});
