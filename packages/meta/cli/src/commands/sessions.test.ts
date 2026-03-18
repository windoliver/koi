import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionSummaries, loadSessionSummary } from "./sessions.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `koi-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeChatFile(agentName: string, sessionId: string, lines: readonly string[]): string {
  const chatDir = join(tempDir, "agents", agentName, "session", "chat");
  mkdirSync(chatDir, { recursive: true });
  const filePath = join(chatDir, `${sessionId}.jsonl`);
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

// ---------------------------------------------------------------------------
// loadSessionSummary
// ---------------------------------------------------------------------------

describe("loadSessionSummary", () => {
  test("parses valid JSONL file", async () => {
    const filePath = writeChatFile("test-agent", "up:test-agent:0", [
      JSON.stringify({ kind: "user", text: "Hello world", timestamp: 1000 }),
      JSON.stringify({ kind: "assistant", text: "Hi there", timestamp: 2000 }),
    ]);

    const summary = await loadSessionSummary(filePath);
    expect(summary).toBeDefined();
    expect(summary?.sessionId).toBe("up:test-agent:0");
    expect(summary?.createdAt).toBe(1000);
    expect(summary?.lastActiveAt).toBe(2000);
    expect(summary?.messageCount).toBe(2);
    expect(summary?.firstUserMessage).toBe("Hello world");
  });

  test("returns undefined for empty file", async () => {
    const chatDir = join(tempDir, "agents", "test-agent", "session", "chat");
    mkdirSync(chatDir, { recursive: true });
    const filePath = join(chatDir, "empty.jsonl");
    writeFileSync(filePath, "");

    const summary = await loadSessionSummary(filePath);
    expect(summary).toBeUndefined();
  });

  test("skips malformed lines", async () => {
    const filePath = writeChatFile("test-agent", "up:test-agent:1", [
      JSON.stringify({ kind: "user", text: "Valid", timestamp: 1000 }),
      "this is not json",
      JSON.stringify({ kind: "assistant", text: "Also valid", timestamp: 3000 }),
    ]);

    const summary = await loadSessionSummary(filePath);
    expect(summary).toBeDefined();
    expect(summary?.messageCount).toBe(2);
    expect(summary?.lastActiveAt).toBe(3000);
  });

  test("truncates long first user message", async () => {
    const longMessage = "A".repeat(100);
    const filePath = writeChatFile("test-agent", "up:test-agent:2", [
      JSON.stringify({ kind: "user", text: longMessage, timestamp: 1000 }),
    ]);

    const summary = await loadSessionSummary(filePath);
    expect(summary?.firstUserMessage?.length).toBe(80);
    expect(summary?.firstUserMessage?.endsWith("...")).toBe(true);
  });

  test("returns undefined for non-existent file", async () => {
    const summary = await loadSessionSummary("/nonexistent/path.jsonl");
    expect(summary).toBeUndefined();
  });

  test("extracts session ID from filename", async () => {
    const filePath = writeChatFile("test-agent", "custom-session-id", [
      JSON.stringify({ kind: "user", text: "test", timestamp: 1000 }),
    ]);

    const summary = await loadSessionSummary(filePath);
    expect(summary?.sessionId).toBe("custom-session-id");
  });
});

// ---------------------------------------------------------------------------
// listSessionSummaries
// ---------------------------------------------------------------------------

describe("listSessionSummaries", () => {
  test("returns empty array when no chat directory exists", async () => {
    const summaries = await listSessionSummaries(tempDir, "nonexistent-agent", 20);
    expect(summaries).toEqual([]);
  });

  test("lists sessions sorted by lastActiveAt descending", async () => {
    writeChatFile("test-agent", "up:test-agent:0", [
      JSON.stringify({ kind: "user", text: "First session", timestamp: 1000 }),
      JSON.stringify({ kind: "assistant", text: "Reply", timestamp: 1500 }),
    ]);
    writeChatFile("test-agent", "up:test-agent:1", [
      JSON.stringify({ kind: "user", text: "Second session", timestamp: 3000 }),
      JSON.stringify({ kind: "assistant", text: "Reply", timestamp: 4000 }),
    ]);
    writeChatFile("test-agent", "up:test-agent:2", [
      JSON.stringify({ kind: "user", text: "Third session", timestamp: 2000 }),
      JSON.stringify({ kind: "assistant", text: "Reply", timestamp: 2500 }),
    ]);

    const summaries = await listSessionSummaries(tempDir, "test-agent", 20);
    expect(summaries.length).toBe(3);
    // Most recent first
    expect(summaries[0]?.sessionId).toBe("up:test-agent:1");
    expect(summaries[1]?.sessionId).toBe("up:test-agent:2");
    expect(summaries[2]?.sessionId).toBe("up:test-agent:0");
  });

  test("respects limit", async () => {
    writeChatFile("test-agent", "up:test-agent:0", [
      JSON.stringify({ kind: "user", text: "Session 0", timestamp: 1000 }),
    ]);
    writeChatFile("test-agent", "up:test-agent:1", [
      JSON.stringify({ kind: "user", text: "Session 1", timestamp: 2000 }),
    ]);
    writeChatFile("test-agent", "up:test-agent:2", [
      JSON.stringify({ kind: "user", text: "Session 2", timestamp: 3000 }),
    ]);

    const summaries = await listSessionSummaries(tempDir, "test-agent", 2);
    expect(summaries.length).toBe(2);
    // Should be the 2 most recent
    expect(summaries[0]?.sessionId).toBe("up:test-agent:2");
    expect(summaries[1]?.sessionId).toBe("up:test-agent:1");
  });

  test("skips non-jsonl files", async () => {
    writeChatFile("test-agent", "up:test-agent:0", [
      JSON.stringify({ kind: "user", text: "Valid", timestamp: 1000 }),
    ]);
    // Write a non-jsonl file
    const chatDir = join(tempDir, "agents", "test-agent", "session", "chat");
    writeFileSync(join(chatDir, "notes.txt"), "not a session");

    const summaries = await listSessionSummaries(tempDir, "test-agent", 20);
    expect(summaries.length).toBe(1);
  });
});
