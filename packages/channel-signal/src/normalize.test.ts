import { describe, expect, test } from "bun:test";
import { createNormalizer } from "./normalize.js";
import type { SignalEvent } from "./signal-process.js";

const normalize = createNormalizer();

describe("createNormalizer", () => {
  test("returns InboundMessage for message event", () => {
    const event: SignalEvent = {
      kind: "message",
      source: "+1234567890",
      timestamp: 1700000000000,
      body: "hello signal",
    };
    const result = normalize(event);
    expect(result).not.toBeNull();
    expect(result?.content).toEqual([{ kind: "text", text: "hello signal" }]);
    expect(result?.senderId).toBe("+1234567890");
    expect(result?.threadId).toBe("+1234567890");
    expect(result?.timestamp).toBe(1700000000000);
  });

  test("uses groupId as threadId for group messages", () => {
    const event: SignalEvent = {
      kind: "message",
      source: "+1234567890",
      timestamp: 1700000000000,
      body: "group msg",
      groupId: "group.abc123",
    };
    const result = normalize(event);
    expect(result?.threadId).toBe("group.abc123");
  });

  test("returns null for receipt events", () => {
    const event: SignalEvent = {
      kind: "receipt",
      source: "+1234567890",
      timestamp: 1700000000000,
    };
    expect(normalize(event)).toBeNull();
  });

  test("returns null for typing events", () => {
    const event: SignalEvent = {
      kind: "typing",
      source: "+1234567890",
      started: true,
    };
    expect(normalize(event)).toBeNull();
  });

  test("returns null for message with empty body", () => {
    const event: SignalEvent = {
      kind: "message",
      source: "+1234567890",
      timestamp: 1700000000000,
      body: "",
    };
    expect(normalize(event)).toBeNull();
  });
});
