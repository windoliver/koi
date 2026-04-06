/**
 * Tests for resumeFromTranscript().
 *
 * Written BEFORE the implementation (red phase). All tests must fail until
 * packages/lib/session/src/resume.ts is implemented.
 *
 * Coverage:
 *   Case 1 — empty transcript → empty array (not a single empty user message)
 *   Case 2 — compaction-only transcript → single synthetic user summary
 *   Case 3 — user/assistant turns → InboundMessage[] with correct senderIds
 *   Case 4 — tool_call + tool_result pair → matched by callId in metadata
 *   Case 5 — dangling tool_use at end → synthetic error tool_result injected
 *   Case 6 — orphan tool_result (no preceding tool_call) → repaired
 *   Case 7 — determinism: same input → identical output on two calls
 *   Case 8 — missing/invalid transcript → typed NOT_FOUND or VALIDATION error
 */

import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "@koi/core";
import { sessionId, transcriptEntryId } from "@koi/core";
import { resumeFromTranscript } from "../resume.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function entry(
  role: TranscriptEntry["role"],
  content: string,
  overrides?: Partial<TranscriptEntry>,
): TranscriptEntry {
  return {
    id: transcriptEntryId(`test-${++_seq}`),
    role,
    content,
    timestamp: 1000 * _seq,
    ...overrides,
  };
}

function toolCallEntry(
  calls: Array<{ id: string; toolName: string; args: string }>,
): TranscriptEntry {
  return entry("tool_call", JSON.stringify(calls));
}

function toolResultEntry(toolId: string, output: unknown): TranscriptEntry {
  return entry("tool_result", JSON.stringify({ toolId, output }));
}

// ---------------------------------------------------------------------------
// Case 1: empty transcript → empty array
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 1: empty input", () => {
  test("empty entries returns empty array (not a synthetic message)", () => {
    const result = resumeFromTranscript([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages.length).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: compaction-only transcript → single synthetic user summary
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 2: compaction-only", () => {
  test("compaction entry becomes a synthetic user message with [Summary] prefix", () => {
    const entries = [entry("compaction", "The agent fixed three bugs.")];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages.length).toBe(1);
      const msg = result.value.messages[0];
      expect(msg?.senderId).toBe("user");
      expect(msg?.content[0]?.kind).toBe("text");
      if (msg?.content[0]?.kind === "text") {
        expect(msg.content[0].text).toContain("The agent fixed three bugs.");
      }
    }
  });

  test("multiple compaction entries are each folded to a separate user summary", () => {
    const entries = [entry("compaction", "First summary."), entry("compaction", "Second summary.")];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Each compaction → one user message
      expect(result.value.messages.length).toBe(2);
      for (const msg of result.value.messages) {
        expect(msg?.senderId).toBe("user");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3: user / assistant turns
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 3: user/assistant turns", () => {
  test("user and assistant entries become InboundMessages with correct senderIds", () => {
    const entries = [
      entry("user", "Hello"),
      entry("assistant", "Hi there!"),
      entry("user", "How are you?"),
      entry("assistant", "I am well."),
    ];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { messages } = result.value;
      expect(messages.length).toBe(4);
      expect(messages[0]?.senderId).toBe("user");
      expect(messages[1]?.senderId).toBe("assistant");
      expect(messages[2]?.senderId).toBe("user");
      expect(messages[3]?.senderId).toBe("assistant");
    }
  });

  test("text content round-trips correctly", () => {
    const entries = [entry("user", "Test message with special chars: <>&\"'")];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const msg = result.value.messages[0];
      expect(msg?.content[0]?.kind).toBe("text");
      if (msg?.content[0]?.kind === "text") {
        expect(msg.content[0].text).toBe("Test message with special chars: <>&\"'");
      }
    }
  });

  test("system entries use senderId='system'", () => {
    const entries = [entry("system", "You are a helpful assistant.")];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages[0]?.senderId).toBe("system");
    }
  });
});

// ---------------------------------------------------------------------------
// Case 4: tool_call + tool_result pair → paired by callId in metadata
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 4: tool_call/tool_result pairs", () => {
  test("tool_call and tool_result are paired via callId in metadata", () => {
    const entries = [
      entry("user", "Please list files"),
      toolCallEntry([{ id: "call_abc", toolName: "bash", args: '{"command":"ls"}' }]),
      toolResultEntry("bash", "file1.txt\nfile2.txt"),
      entry("assistant", "The files are: file1.txt, file2.txt"),
    ];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { messages } = result.value;
      // Find the tool-call message (senderId="assistant" with callId) and tool-result (senderId="tool")
      const toolCallMsg = messages.find(
        (m) => m.senderId === "assistant" && m.metadata?.callId !== undefined,
      );
      const toolResultMsg = messages.find((m) => m.senderId === "tool");
      expect(toolCallMsg).toBeDefined();
      expect(toolResultMsg).toBeDefined();
      // They must share the same callId
      expect(toolCallMsg?.metadata?.callId).toBe(toolResultMsg?.metadata?.callId);
    }
  });

  test("multiple tools in one tool_call entry are each paired with their result", () => {
    const entries = [
      toolCallEntry([
        { id: "call_1", toolName: "bash", args: '{"command":"ls"}' },
        { id: "call_2", toolName: "read_file", args: '{"path":"foo.ts"}' },
      ]),
      toolResultEntry("bash", "file1.txt"),
      toolResultEntry("read_file", "export const x = 1;"),
    ];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const toolMessages = result.value.messages.filter((m) => m.senderId === "tool");
      expect(toolMessages.length).toBe(2);
      // Both must have callIds
      expect(toolMessages[0]?.metadata?.callId).toBeDefined();
      expect(toolMessages[1]?.metadata?.callId).toBeDefined();
      // callIds must be distinct
      expect(toolMessages[0]?.metadata?.callId).not.toBe(toolMessages[1]?.metadata?.callId);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 5: dangling tool_use at end of transcript (crash before tool_result)
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 5: dangling tool_use at end", () => {
  test("transcript ending with tool_call but no tool_result gets synthetic error result", () => {
    const entries = [
      entry("user", "Run a command"),
      toolCallEntry([{ id: "call_crash", toolName: "bash", args: '{"command":"rm -rf /"}' }]),
      // No tool_result — process crashed here
    ];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const toolResultMsg = result.value.messages.find((m) => m.senderId === "tool");
      expect(toolResultMsg).toBeDefined();
      // Must be marked as synthetic error
      expect(toolResultMsg?.metadata?.synthetic).toBe(true);
      expect(toolResultMsg?.metadata?.isError).toBe(true);
      // Must share the callId of the dangling tool_call
      const toolCallMsg = result.value.messages.find(
        (m) => m.senderId === "assistant" && m.metadata?.callId !== undefined,
      );
      expect(toolResultMsg?.metadata?.callId).toBe(toolCallMsg?.metadata?.callId);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 6: orphan tool_result (no matching tool_call) — repairSession() handles
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 6: orphan tool_result repaired", () => {
  test("orphan tool_result with no preceding tool_call is repaired (synthetic assistant inserted)", () => {
    // This simulates a compaction that removed the tool_call but kept the tool_result
    const entries = [
      toolResultEntry("bash", "some output"), // orphan — no preceding tool_call
      entry("assistant", "The command produced output."),
    ];
    const result = resumeFromTranscript(entries);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { messages, issues } = result.value;
      // Result must be parseable by the API (no unmatched tool_result)
      // repairSession() inserts a synthetic assistant before the orphan
      expect(messages.length).toBeGreaterThan(0);
      // At least one repair issue should be recorded
      expect(issues.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 7: determinism — same input → identical output on two calls
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 7: determinism", () => {
  test("calling resumeFromTranscript twice with the same input produces identical output", () => {
    const entries = [
      entry("user", "Hello"),
      entry("assistant", "Hi"),
      toolCallEntry([{ id: "call_det", toolName: "bash", args: '{"command":"ls"}' }]),
      toolResultEntry("bash", "file.txt"),
      entry("assistant", "Done."),
    ];

    const result1 = resumeFromTranscript(entries);
    const result2 = resumeFromTranscript(entries);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    if (result1.ok && result2.ok) {
      // Deep equality: same structure, same content, same order
      expect(result1.value.messages.length).toBe(result2.value.messages.length);
      for (let i = 0; i < result1.value.messages.length; i++) {
        const m1 = result1.value.messages[i];
        const m2 = result2.value.messages[i];
        expect(m1?.senderId).toBe(m2?.senderId);
        expect(JSON.stringify(m1?.content)).toBe(JSON.stringify(m2?.content));
        expect(m1?.metadata?.callId).toBe(m2?.metadata?.callId);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Case 8: session ID validation — empty session ID returns VALIDATION error
// ---------------------------------------------------------------------------

describe("resumeFromTranscript - case 8: validation", () => {
  test("resumeForSession with empty sessionId returns VALIDATION error", async () => {
    // resumeFromTranscript is a pure function (takes entries directly),
    // so the session-level validation lives in the store-integrated resumeSession()
    // wrapper. Test that resumeForSession rejects empty sessionId.
    const { resumeForSession } = await import("../resume.js");
    const mockTranscript = {
      load: async () => ({ ok: true as const, value: { entries: [], skipped: [] } }),
      append: async () => ({ ok: true as const, value: undefined }),
      loadPage: async () => ({
        ok: true as const,
        value: { entries: [], total: 0, hasMore: false },
      }),
      compact: async () => ({ ok: true as const, value: { preserved: 0, extended: false } }),
      remove: async () => ({ ok: true as const, value: undefined }),
      close: () => undefined,
    };

    const result = await resumeForSession(sessionId(""), mockTranscript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("resumeForSession with valid sessionId but missing session returns empty messages", async () => {
    const { resumeForSession } = await import("../resume.js");
    const mockTranscript = {
      load: async () => ({ ok: true as const, value: { entries: [], skipped: [] } }),
      append: async () => ({ ok: true as const, value: undefined }),
      loadPage: async () => ({
        ok: true as const,
        value: { entries: [], total: 0, hasMore: false },
      }),
      compact: async () => ({ ok: true as const, value: { preserved: 0, extended: false } }),
      remove: async () => ({ ok: true as const, value: undefined }),
      close: () => undefined,
    };

    const result = await resumeForSession(sessionId("nonexistent"), mockTranscript);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages.length).toBe(0);
    }
  });
});
