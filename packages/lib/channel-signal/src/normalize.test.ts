import { describe, expect, test } from "bun:test";
import { createNormalizer, GROUP_THREAD_PREFIX } from "./normalize.js";
import type { SignalEvent } from "./signal-process.js";

describe("@koi/channel-signal normalize", () => {
  test("DM message: senderId and threadId are E.164-normalized source", () => {
    const n = createNormalizer();
    const ev: SignalEvent = {
      kind: "message",
      source: "1 (555) 123-4567",
      timestamp: 1700000000000,
      body: "hi",
    };
    const out = n(ev);
    expect(out?.senderId).toBe("+15551234567");
    expect(out?.threadId).toBe("+15551234567");
    expect(out?.content[0]).toEqual({ kind: "text", text: "hi" });
  });

  test("group message: threadId carries the group: prefix", () => {
    const n = createNormalizer();
    const ev: SignalEvent = {
      kind: "message",
      source: "+15551234567",
      timestamp: 1700000000000,
      body: "hi",
      groupId: "g==",
    };
    const out = n(ev);
    expect(out?.threadId).toBe(`${GROUP_THREAD_PREFIX}g==`);
    expect(out?.senderId).toBe("+15551234567");
  });

  test("empty body returns null", () => {
    const n = createNormalizer();
    expect(n({ kind: "message", source: "+15551234567", timestamp: 1, body: "" })).toBeNull();
  });

  test("receipt and typing events return null", () => {
    const n = createNormalizer();
    expect(n({ kind: "receipt", source: "+15551234567", timestamp: 1 })).toBeNull();
    expect(n({ kind: "typing", source: "+15551234567", started: true })).toBeNull();
  });

  test("source that cannot be normalized falls back to raw", () => {
    const n = createNormalizer();
    const out = n({
      kind: "message",
      source: "garbage",
      timestamp: 1,
      body: "hi",
    });
    expect(out?.senderId).toBe("garbage");
    expect(out?.threadId).toBe("garbage");
  });
});
