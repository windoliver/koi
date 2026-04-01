/**
 * E2E tests for Change 1: Agent inbox.
 *
 * Validates:
 * - Inbox push/drain/clear cycle with realistic payloads
 * - isAgentMessagePayload type guard validates correctly
 *
 * These tests have NO LLM dependency and run unconditionally.
 */

import { describe, expect, test } from "bun:test";
import { createAgentInbox, isAgentMessagePayload } from "@koi/node";

describe("Change 1: Agent inbox integration", () => {
  test("inbox push/drain/clear cycle with realistic payloads", () => {
    const inbox = createAgentInbox();

    const payload1 = {
      content: [{ kind: "text" as const, text: "Hello from sender A" }],
      senderId: "sender-a",
    };
    const payload2 = {
      content: [{ kind: "text" as const, text: "Hello from sender B" }],
      senderId: "sender-b",
      metadata: { priority: "high" },
    };

    inbox.push("agent-001", payload1);
    inbox.push("agent-001", payload2);
    expect(inbox.depth("agent-001")).toBe(2);

    const drained = inbox.drain("agent-001");
    expect(drained).toHaveLength(2);
    expect(drained[0]?.payload.senderId).toBe("sender-a");
    expect(drained[1]?.payload.senderId).toBe("sender-b");
    expect(inbox.depth("agent-001")).toBe(0);

    inbox.clear("agent-001");
    expect(inbox.depth("agent-001")).toBe(0);
  });

  test("isAgentMessagePayload validates payloads correctly", () => {
    expect(isAgentMessagePayload({ content: [] })).toBe(true);
    expect(
      isAgentMessagePayload({
        content: [{ kind: "text", text: "hi" }],
        senderId: "x",
      }),
    ).toBe(true);
    expect(isAgentMessagePayload(null)).toBe(false);
    expect(isAgentMessagePayload(undefined)).toBe(false);
    expect(isAgentMessagePayload({})).toBe(false);
    expect(isAgentMessagePayload({ content: "not-array" })).toBe(false);
  });
});
