import { describe, expect, test } from "bun:test";
import { parseSessionRecord, parseTuiChatLog, TUI_SESSION_PREFIX } from "./session-picker.js";

describe("TUI_SESSION_PREFIX", () => {
  test("has correct value", () => {
    expect(TUI_SESSION_PREFIX).toBe("/session/tui");
  });
});

describe("parseSessionRecord", () => {
  test("returns null for empty content", () => {
    expect(parseSessionRecord("")).toBeNull();
    expect(parseSessionRecord("   ")).toBeNull();
  });

  test("parses valid SessionRecord JSON", () => {
    const record = {
      sessionId: "sess-abc123",
      agentId: "agent-1",
      manifestSnapshot: { name: "my-agent", version: "1.0" },
      seq: 5,
      remoteSeq: 3,
      connectedAt: 1700000000000,
      lastPersistedAt: 1700001000000,
      metadata: {},
    };

    const info = parseSessionRecord(JSON.stringify(record));
    expect(info).not.toBeNull();
    expect(info?.sessionId).toBe("sess-abc123");
    expect(info?.connectedAt).toBe(1700000000000);
    expect(info?.agentName).toBe("my-agent");
  });

  test("returns null for missing sessionId", () => {
    const record = { agentId: "agent-1", seq: 0 };
    expect(parseSessionRecord(JSON.stringify(record))).toBeNull();
  });

  test("defaults agentName to unknown when manifest has no name", () => {
    const record = { sessionId: "sess-1", connectedAt: 1000, manifestSnapshot: {} };
    const info = parseSessionRecord(JSON.stringify(record));
    expect(info?.agentName).toBe("unknown");
  });

  test("defaults agentName when no manifestSnapshot", () => {
    const record = { sessionId: "sess-1", connectedAt: 1000 };
    const info = parseSessionRecord(JSON.stringify(record));
    expect(info?.agentName).toBe("unknown");
  });

  test("returns null for non-JSON content", () => {
    expect(parseSessionRecord("not json")).toBeNull();
  });

  test("returns null for non-object JSON", () => {
    expect(parseSessionRecord('"just a string"')).toBeNull();
    expect(parseSessionRecord("42")).toBeNull();
  });
});

describe("parseTuiChatLog", () => {
  test("returns empty array for empty content", () => {
    expect(parseTuiChatLog("")).toEqual([]);
    expect(parseTuiChatLog("   ")).toEqual([]);
  });

  test("parses JSON-lines with known message kinds", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hello", timestamp: 100 }),
      JSON.stringify({ kind: "assistant", text: "hi there", timestamp: 200 }),
      JSON.stringify({ kind: "lifecycle", event: "Run started", timestamp: 300 }),
    ].join("\n");

    const messages = parseTuiChatLog(content);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.kind).toBe("user");
    expect(messages[1]?.kind).toBe("assistant");
    expect(messages[2]?.kind).toBe("lifecycle");
  });

  test("parses tool_call messages", () => {
    const content = JSON.stringify({
      kind: "tool_call",
      name: "search",
      args: '{"q":"test"}',
      result: "found it",
      timestamp: 400,
    });

    const messages = parseTuiChatLog(content);
    expect(messages).toHaveLength(1);
    if (messages[0]?.kind === "tool_call") {
      expect(messages[0].name).toBe("search");
      expect(messages[0].result).toBe("found it");
    }
  });

  test("skips lines with unknown kind", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hi", timestamp: 1 }),
      JSON.stringify({ kind: "unknown_thing", data: "ignored" }),
      JSON.stringify({ kind: "assistant", text: "bye", timestamp: 2 }),
    ].join("\n");

    const messages = parseTuiChatLog(content);
    expect(messages).toHaveLength(2);
  });

  test("skips malformed JSON lines", () => {
    const content = [
      JSON.stringify({ kind: "user", text: "hi", timestamp: 1 }),
      "not-json-at-all",
      JSON.stringify({ kind: "assistant", text: "bye", timestamp: 2 }),
    ].join("\n");

    const messages = parseTuiChatLog(content);
    expect(messages).toHaveLength(2);
  });

  test("returns empty for all-invalid content (no fallback)", () => {
    const content = "Some plain text log output\nAnother line";
    const messages = parseTuiChatLog(content);
    expect(messages).toHaveLength(0);
  });
});
