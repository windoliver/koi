import { describe, expect, it, mock } from "bun:test";
import type { AgentMessagePayload } from "./agent-inbox.js";
import { createAgentInbox, isAgentMessagePayload, MAX_INBOX_DEPTH } from "./agent-inbox.js";

function makePayload(text: string): AgentMessagePayload {
  return {
    content: [{ kind: "text", text }],
  };
}

describe("createAgentInbox", () => {
  it("drains messages in FIFO order", () => {
    const inbox = createAgentInbox();
    inbox.push("a1", makePayload("first"));
    inbox.push("a1", makePayload("second"));
    inbox.push("a1", makePayload("third"));

    const messages = inbox.drain("a1");

    expect(messages).toHaveLength(3);
    expect(messages[0]?.payload.content).toEqual([{ kind: "text", text: "first" }]);
    expect(messages[1]?.payload.content).toEqual([{ kind: "text", text: "second" }]);
    expect(messages[2]?.payload.content).toEqual([{ kind: "text", text: "third" }]);
  });

  it("drain returns empty array when no messages queued", () => {
    const inbox = createAgentInbox();
    const messages = inbox.drain("nonexistent");

    expect(messages).toEqual([]);
  });

  it("drain clears the queue after returning", () => {
    const inbox = createAgentInbox();
    inbox.push("a1", makePayload("msg"));

    const first = inbox.drain("a1");
    expect(first).toHaveLength(1);

    const second = inbox.drain("a1");
    expect(second).toEqual([]);
  });

  it("depth returns correct count", () => {
    const inbox = createAgentInbox();

    expect(inbox.depth("a1")).toBe(0);

    inbox.push("a1", makePayload("one"));
    inbox.push("a1", makePayload("two"));
    inbox.push("a1", makePayload("three"));

    expect(inbox.depth("a1")).toBe(3);
  });

  it("clear removes all messages for agent", () => {
    const inbox = createAgentInbox();
    inbox.push("a1", makePayload("one"));
    inbox.push("a1", makePayload("two"));

    inbox.clear("a1");

    expect(inbox.depth("a1")).toBe(0);
    expect(inbox.drain("a1")).toEqual([]);
  });

  it("no-op when clearing non-existent agent", () => {
    const inbox = createAgentInbox();

    // Should not throw
    expect(() => inbox.clear("unknown")).not.toThrow();
  });

  it("drops oldest message when inbox exceeds MAX_INBOX_DEPTH", () => {
    const inbox = createAgentInbox();

    for (let i = 0; i < MAX_INBOX_DEPTH + 1; i++) {
      inbox.push("a1", makePayload(`msg-${String(i)}`));
    }

    const messages = inbox.drain("a1");

    expect(messages).toHaveLength(MAX_INBOX_DEPTH);
    // The first message (msg-0) should have been dropped; first remaining is msg-1
    expect(messages[0]?.payload.content).toEqual([{ kind: "text", text: "msg-1" }]);
    // The last message should be the most recent
    expect(messages[MAX_INBOX_DEPTH - 1]?.payload.content).toEqual([
      { kind: "text", text: `msg-${String(MAX_INBOX_DEPTH)}` },
    ]);
  });

  it("calls onDrop when overflow drops a message", () => {
    const onDrop = mock(() => {});
    const inbox = createAgentInbox({ onDrop });

    for (let i = 0; i < MAX_INBOX_DEPTH; i++) {
      inbox.push("a1", makePayload(`msg-${String(i)}`));
    }
    expect(onDrop).not.toHaveBeenCalled();

    inbox.push("a1", makePayload("overflow"));
    expect(onDrop).toHaveBeenCalledTimes(1);

    const call = onDrop.mock.calls[0] as unknown as [
      { agentId: string; dropped: { payload: AgentMessagePayload } },
    ];
    expect(call[0].agentId).toBe("a1");
    expect(call[0].dropped.payload.content).toEqual([{ kind: "text", text: "msg-0" }]);
  });

  it("does not call onDrop within capacity", () => {
    const onDrop = mock(() => {});
    const inbox = createAgentInbox({ onDrop });

    inbox.push("a1", makePayload("within-capacity"));
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe("isAgentMessagePayload", () => {
  it("accepts valid payload with text content block", () => {
    expect(isAgentMessagePayload({ content: [{ kind: "text", text: "hi" }] })).toBe(true);
  });

  it("accepts empty content array (metadata-only message)", () => {
    expect(isAgentMessagePayload({ content: [] })).toBe(true);
  });

  it("rejects number element in content", () => {
    expect(isAgentMessagePayload({ content: [42] })).toBe(false);
  });

  it("rejects null element in content", () => {
    expect(isAgentMessagePayload({ content: [null] })).toBe(false);
  });

  it("rejects object missing kind field", () => {
    expect(isAgentMessagePayload({ content: [{ text: "no kind" }] })).toBe(false);
  });

  it("rejects non-object value (string)", () => {
    expect(isAgentMessagePayload("not an object")).toBe(false);
  });

  it("rejects null", () => {
    expect(isAgentMessagePayload(null)).toBe(false);
  });

  it("rejects object with missing content field", () => {
    expect(isAgentMessagePayload({ senderId: "abc" })).toBe(false);
  });

  it("rejects object with non-array content field", () => {
    expect(isAgentMessagePayload({ content: "not array" })).toBe(false);
  });
});
