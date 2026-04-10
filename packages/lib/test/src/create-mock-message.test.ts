import { describe, expect, test } from "bun:test";
import { createMockInboundMessage } from "./create-mock-message.js";

describe("createMockInboundMessage", () => {
  test("defaults produce empty content", () => {
    const msg = createMockInboundMessage();
    expect(msg.content).toEqual([]);
    expect(msg.senderId).toBe("test-user");
    expect(msg.timestamp).toBe(0);
  });

  test("text shortcut creates a text block", () => {
    const msg = createMockInboundMessage({ text: "hello" });
    expect(msg.content).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("explicit content wins over text shortcut", () => {
    const msg = createMockInboundMessage({
      text: "ignored",
      content: [{ kind: "text", text: "wins" }],
    });
    expect(msg.content).toEqual([{ kind: "text", text: "wins" }]);
  });

  test("senderId and metadata overrides", () => {
    const msg = createMockInboundMessage({
      senderId: "alice",
      timestamp: 42,
      metadata: { foo: "bar" },
    });
    expect(msg.senderId).toBe("alice");
    expect(msg.timestamp).toBe(42);
    expect(msg.metadata).toEqual({ foo: "bar" });
  });
});
