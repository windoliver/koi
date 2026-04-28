import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";

import { reorderForCache } from "./reorder.js";

function msg(senderId: string, text: string): InboundMessage {
  return {
    senderId,
    timestamp: 0,
    content: [{ kind: "text", text }],
  };
}

describe("reorderForCache", () => {
  test("empty array returns empty result", () => {
    const r = reorderForCache([]);
    expect(r.messages).toEqual([]);
    expect(r.lastStableIndex).toBe(-1);
    expect(r.staticCount).toBe(0);
  });

  test("places system messages before user messages", () => {
    const r = reorderForCache([msg("user:1", "u"), msg("system", "s")]);
    expect(r.messages.map((m) => m.senderId)).toEqual(["system", "user:1"]);
    expect(r.lastStableIndex).toBe(0);
    expect(r.staticCount).toBe(1);
  });

  test("assistant messages stay in dynamic group, never moved before user", () => {
    const r = reorderForCache([msg("user:1", "u1"), msg("assistant", "a1"), msg("user:1", "u2")]);
    expect(r.messages.map((m) => m.senderId)).toEqual(["user:1", "assistant", "user:1"]);
    expect(r.lastStableIndex).toBe(-1);
    expect(r.staticCount).toBe(0);
  });

  test("preserves relative order within static and dynamic groups", () => {
    const r = reorderForCache([
      msg("user:1", "u1"),
      msg("system", "s1"),
      msg("assistant", "a1"),
      msg("system:tool-defs", "s2"),
      msg("user:1", "u2"),
    ]);
    const texts = r.messages.map((m) => {
      const first = m.content[0];
      return first !== undefined && first.kind === "text" ? first.text : "";
    });
    expect(texts).toEqual(["s1", "s2", "u1", "a1", "u2"]);
    expect(r.lastStableIndex).toBe(1);
    expect(r.staticCount).toBe(2);
  });

  test("all static — lastStableIndex is last index", () => {
    const r = reorderForCache([msg("system", "s1"), msg("system:other", "s2")]);
    expect(r.staticCount).toBe(2);
    expect(r.lastStableIndex).toBe(1);
  });

  test("all dynamic — lastStableIndex is -1", () => {
    const r = reorderForCache([msg("user:1", "u"), msg("assistant", "a")]);
    expect(r.staticCount).toBe(0);
    expect(r.lastStableIndex).toBe(-1);
  });

  test("tool senders are dynamic, not static", () => {
    const r = reorderForCache([msg("tool:search", "t"), msg("system", "s")]);
    expect(r.messages.map((m) => m.senderId)).toEqual(["system", "tool:search"]);
    expect(r.staticCount).toBe(1);
  });
});
