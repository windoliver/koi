import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core/message";
import { needsRepair } from "./needs-repair.js";
import { repairSession } from "./repair-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(
  senderId: string,
  text: string,
  opts?: {
    readonly callId?: string;
    readonly pinned?: boolean;
    readonly synthetic?: boolean;
    readonly ts?: number;
  },
): InboundMessage {
  const metadata: Record<string, unknown> = {};
  if (opts?.callId !== undefined) metadata.callId = opts.callId;
  if (opts?.synthetic !== undefined) metadata.synthetic = opts.synthetic;
  return {
    senderId,
    content: [{ kind: "text", text }],
    timestamp: opts?.ts ?? 0,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(opts?.pinned !== undefined ? { pinned: opts.pinned } : {}),
  };
}

// ---------------------------------------------------------------------------
// Boundary tests
// ---------------------------------------------------------------------------

describe("repairSession — boundary cases", () => {
  test("returns original reference for empty array", () => {
    const messages: readonly InboundMessage[] = [];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
    expect(result.issues).toEqual([]);
  });

  test("returns original reference for single message", () => {
    const messages = [msg("user", "hello")];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
    expect(result.issues).toEqual([]);
  });

  test("returns original reference for clean history", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "hi", { callId: "c1" }),
      msg("tool", "result", { callId: "c1" }),
      msg("assistant", "done"),
    ];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
    expect(result.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 1: Orphan repair
// ---------------------------------------------------------------------------

describe("repairSession — orphan repair", () => {
  test("inserts synthetic assistant before orphan tool", () => {
    const messages = [msg("user", "hello"), msg("tool", "result", { callId: "c1" })];
    const result = repairSession(messages);

    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    const orphanIssue = result.issues.find(
      (i) => i.phase === "orphan-tool" && i.action === "inserted",
    );
    expect(orphanIssue).toBeDefined();

    // Synthetic assistant should appear before the tool message
    const syntheticIdx = result.messages.findIndex(
      (m) => m.senderId === "assistant" && m.metadata?.synthetic === true,
    );
    expect(syntheticIdx).toBeGreaterThanOrEqual(0);
    expect(result.messages[syntheticIdx + 1]?.senderId).toBe("tool");
  });

  test("inserts synthetic tool after dangling assistant", () => {
    const messages = [msg("assistant", "calling tool", { callId: "c1" }), msg("user", "next")];
    const result = repairSession(messages);

    const orphanIssue = result.issues.find(
      (i) => i.phase === "orphan-tool" && i.description.includes("dangling"),
    );
    expect(orphanIssue).toBeDefined();

    // Synthetic tool should appear after the assistant
    const syntheticIdx = result.messages.findIndex(
      (m) => m.senderId === "tool" && m.metadata?.synthetic === true,
    );
    expect(syntheticIdx).toBeGreaterThanOrEqual(0);
    expect(result.messages[syntheticIdx - 1]?.senderId).toBe("assistant");
  });

  test("synthetic messages have correct metadata", () => {
    const messages = [msg("user", "hello"), msg("tool", "result", { callId: "c1" })];
    const result = repairSession(messages);

    const synthetic = result.messages.find((m) => m.metadata?.synthetic === true);
    expect(synthetic).toBeDefined();
    expect(synthetic?.metadata?.callId).toBe("c1");
    expect(synthetic?.metadata?.repairPhase).toBe("orphan-tool");
  });

  test("handles multiple orphans", () => {
    const messages = [msg("tool", "r1", { callId: "c1" }), msg("tool", "r2", { callId: "c2" })];
    const result = repairSession(messages);

    const inserted = result.issues.filter(
      (i) => i.phase === "orphan-tool" && i.action === "inserted",
    );
    expect(inserted.length).toBe(2);
  });

  test("preserves matched pairs", () => {
    const messages = [
      msg("assistant", "call", { callId: "c1" }),
      msg("tool", "result", { callId: "c1" }),
      msg("tool", "orphan", { callId: "c2" }),
    ];
    const result = repairSession(messages);

    // Original pair should be preserved
    expect(result.messages[0]?.senderId).toBe("assistant");
    expect(result.messages[0]?.metadata?.callId).toBe("c1");
    expect(result.messages[1]?.senderId).toBe("tool");
    expect(result.messages[1]?.metadata?.callId).toBe("c1");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Dedup
// ---------------------------------------------------------------------------

describe("repairSession — dedup", () => {
  test("removes consecutive duplicate messages", () => {
    const messages = [msg("user", "hello"), msg("user", "hello"), msg("assistant", "hi")];
    const result = repairSession(messages);

    const dedupIssues = result.issues.filter((i) => i.phase === "dedup");
    expect(dedupIssues.length).toBe(1);
    expect(dedupIssues[0]?.action).toBe("removed");
  });

  test("keeps first of consecutive duplicates", () => {
    const messages = [
      msg("user", "hello", { ts: 1 }),
      msg("user", "hello", { ts: 2 }),
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);
    expect(result.messages[0]?.timestamp).toBe(1);
  });

  test("does not dedup different content with same senderId", () => {
    const messages = [msg("user", "hello"), msg("user", "world"), msg("assistant", "hi")];
    const result = repairSession(messages);

    // Different content should trigger merge, not dedup
    const dedupIssues = result.issues.filter((i) => i.phase === "dedup");
    expect(dedupIssues.length).toBe(0);
  });

  test("does not dedup different senderIds with same content", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hello")];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
  });

  test("removes multiple consecutive duplicates", () => {
    const messages = [
      msg("user", "hello"),
      msg("user", "hello"),
      msg("user", "hello"),
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);

    const dedupIssues = result.issues.filter((i) => i.phase === "dedup");
    expect(dedupIssues.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Merge
// ---------------------------------------------------------------------------

describe("repairSession — merge", () => {
  test("merges consecutive same-sender assistant messages without callId", () => {
    // Use assistant, not user — user messages are never merged (they come
    // from distinct submits; merging silently joins two turns).
    const messages = [
      msg("user", "q"),
      msg("assistant", "hello"),
      msg("assistant", "world"),
      msg("user", "next"),
    ];
    const result = repairSession(messages);

    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(1);

    // The two assistants merged: their content concatenated
    const merged = result.messages.find((m) => m.senderId === "assistant");
    expect(merged?.content.length).toBe(2);
  });

  test("never merges consecutive user messages (interrupt repair inserts synthetic assistant)", () => {
    const messages = [msg("user", "hello"), msg("user", "continue"), msg("assistant", "hi")];
    const result = repairSession(messages);

    // No merge for user pair — interrupt repair inserts synthetic assistant instead
    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(0);

    // Original user messages intact, not concatenated
    expect(result.messages[0]?.senderId).toBe("user");
    expect(result.messages[0]?.content.length).toBe(1);
    // Synthetic assistant injected between them
    expect(result.messages[1]?.senderId).toBe("assistant");
    expect(result.messages[1]?.metadata?.synthetic).toBe(true);
    expect(result.messages[2]?.senderId).toBe("user");
  });

  test("does not merge messages with callId", () => {
    const messages = [
      msg("assistant", "call1", { callId: "c1" }),
      msg("assistant", "call2", { callId: "c2" }),
    ];
    // These are dangling — phase 1 inserts synthetic tools, preventing merge
    const result = repairSession(messages);
    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(0);
  });

  test("does not merge pinned messages", () => {
    const messages = [
      msg("user", "hello", { pinned: true }),
      msg("user", "world"),
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);

    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(0);
  });

  test("does not merge synthetic messages", () => {
    const messages = [
      msg("user", "hello", { synthetic: true }),
      msg("user", "world"),
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);

    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(0);
  });

  test("preserves first message metadata on merge", () => {
    const messages = [
      msg("user", "hello", { ts: 100 }),
      msg("user", "world", { ts: 200 }),
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);
    expect(result.messages[0]?.timestamp).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Interrupt repair tests
// ---------------------------------------------------------------------------

describe("repairSession — interrupt repair", () => {
  test("inserts synthetic assistant between consecutive user messages (aborted turn)", () => {
    // User submitted "hello", ESC interrupted the stream, then typed "continue".
    // Without repair, Anthropic rejects (alternation) and OpenAI merges to "hellocontinue".
    const messages = [msg("user", "hello"), msg("user", "continue"), msg("assistant", "ok")];
    const result = repairSession(messages);
    expect(result.messages.length).toBe(4);
    expect(result.messages[0]?.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(result.messages[1]?.senderId).toBe("assistant");
    expect(result.messages[1]?.metadata?.synthetic).toBe(true);
    expect(result.messages[1]?.metadata?.repairPhase).toBe("interrupt");
    expect(result.messages[2]?.content).toEqual([{ kind: "text", text: "continue" }]);
    expect(result.messages[3]?.senderId).toBe("assistant");
  });

  test("handles 3+ consecutive user messages with one synthetic per gap", () => {
    const messages = [msg("user", "a"), msg("user", "b"), msg("user", "c")];
    const result = repairSession(messages);
    expect(result.messages.length).toBe(5);
    expect(result.messages.map((m) => m.senderId)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
  });

  test("leaves pinned user messages alone (system-injected context stacking is by design)", () => {
    const messages = [
      msg("user", "goal: ship it", { pinned: true }),
      msg("user", "context snippet", { pinned: true }),
      msg("assistant", "ok"),
    ];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
    expect(result.issues.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase interaction tests
// ---------------------------------------------------------------------------

describe("repairSession — phase interactions", () => {
  test("orphan repair + dedup: synthetic does not get deduped", () => {
    const messages = [
      msg("tool", "result", { callId: "c1" }),
      msg("tool", "result", { callId: "c1" }),
    ];
    const result = repairSession(messages);

    // Each orphan gets its own synthetic assistant
    const synthetics = result.messages.filter((m) => m.metadata?.synthetic === true);
    expect(synthetics.length).toBeGreaterThanOrEqual(1);
  });

  test("orphan repair + merge: synthetics are not merged", () => {
    const messages = [msg("tool", "r1", { callId: "c1" }), msg("tool", "r2", { callId: "c2" })];
    const result = repairSession(messages);

    // Synthetic messages have synthetic flag, so they should not merge
    const mergeIssues = result.issues.filter((i) => i.phase === "merge");
    expect(mergeIssues.length).toBe(0);
  });

  test("all phases clean returns original reference", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "hi", { callId: "c1" }),
      msg("tool", "result", { callId: "c1" }),
      msg("assistant", "done"),
    ];
    const result = repairSession(messages);
    expect(result.messages).toBe(messages);
    expect(result.issues).toEqual([]);
  });

  test("dedup before interrupt-repair: duplicates removed before sender-pair check", () => {
    const messages = [
      msg("user", "hello"),
      msg("user", "hello"), // duplicate — removed in dedup
      msg("user", "world"), // different — interrupt-repair inserts synthetic assistant before it
      msg("assistant", "hi"),
    ];
    const result = repairSession(messages);

    const dedupIssues = result.issues.filter((i) => i.phase === "dedup");
    const orphanIssues = result.issues.filter((i) => i.phase === "orphan-tool");
    expect(dedupIssues.length).toBe(1);
    // Interrupt-repair is tagged with phase="orphan-tool" and adds 1 synthetic
    // assistant between the remaining user→user pair.
    expect(orphanIssues.length).toBe(1);
    // User messages stay distinct (no merge); synthetic assistant between
    expect(result.messages[0]?.senderId).toBe("user");
    expect(result.messages[1]?.senderId).toBe("assistant");
    expect(result.messages[1]?.metadata?.synthetic).toBe(true);
    expect(result.messages[2]?.senderId).toBe("user");
  });
});

// ---------------------------------------------------------------------------
// Fast-path mirror tests
// ---------------------------------------------------------------------------

describe("needsRepair mirrors repairSession", () => {
  test("needsRepair returns false for clean history", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", "hi", { callId: "c1" }),
      msg("tool", "result", { callId: "c1" }),
      msg("assistant", "done"),
    ];
    expect(needsRepair(messages)).toBe(false);
    expect(repairSession(messages).issues.length).toBe(0);
  });

  test("needsRepair returns true for orphan tools", () => {
    const messages = [msg("user", "hello"), msg("tool", "result", { callId: "c1" })];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });

  test("needsRepair returns true for duplicates", () => {
    const messages = [msg("user", "hello"), msg("user", "hello"), msg("assistant", "hi")];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });

  test("needsRepair returns true for mergeable adjacent messages", () => {
    const messages = [msg("user", "hello"), msg("user", "world"), msg("assistant", "hi")];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });

  test("needsRepair returns false for single message", () => {
    expect(needsRepair([msg("user", "hello")])).toBe(false);
  });

  test("needsRepair returns false for empty array", () => {
    expect(needsRepair([])).toBe(false);
  });

  test("needsRepair returns false for pinned adjacent same-sender", () => {
    const messages = [
      msg("user", "hello", { pinned: true }),
      msg("user", "world", { pinned: true }),
      msg("assistant", "hi"),
    ];
    // Pinned messages can't merge, but they have different content so no dedup either
    // However, the second is not pinned in the original plan... Let me check:
    // Both pinned = no merge. Different content = no dedup. No orphans.
    expect(needsRepair(messages)).toBe(false);
  });

  test("needsRepair returns true for dangling tool_use", () => {
    const messages = [msg("assistant", "call", { callId: "c1" }), msg("user", "next")];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });

  test("needsRepair returns false for all-pinned adjacent same-sender different content", () => {
    const messages = [msg("user", "a", { pinned: true }), msg("user", "b", { pinned: true })];
    expect(needsRepair(messages)).toBe(false);
  });

  test("needsRepair returns true for single orphan tool message", () => {
    const messages = [msg("tool", "result", { callId: "c1" })];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });

  test("needsRepair returns true for single dangling assistant message", () => {
    const messages = [msg("assistant", "call", { callId: "c1" })];
    expect(needsRepair(messages)).toBe(true);
    expect(repairSession(messages).issues.length).toBeGreaterThan(0);
  });
});
