import { describe, expect, test } from "bun:test";
import { type Activity, normalizeActivity } from "./normalize.js";

const baseActivity: Activity = {
  type: "message",
  id: "act-1",
  conversation: { id: "conv-1", tenantId: "tenant-1" },
  from: { id: "user-1", name: "Alice" },
  serviceUrl: "https://smba.trafficmanager.net/",
  channelId: "msteams",
  text: "hello",
  timestamp: "2026-05-05T12:00:00.000Z",
};

const clock = (): number => 9_999_999;

describe("normalizeActivity", () => {
  test("text-only happy path", () => {
    const r = normalizeActivity(baseActivity, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([{ kind: "text", text: "hello" }]);
    expect(r.value.senderId).toBe("user-1");
    expect(r.value.threadId).toBe("conv-1");
    expect(r.value.timestamp).toBe(Date.parse("2026-05-05T12:00:00.000Z"));
  });

  test("non-message type rejected", () => {
    const r = normalizeActivity({ ...baseActivity, type: "conversationUpdate" }, clock);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("INVALID_ACTIVITY");
  });

  test("attachments stored in metadata, not content blocks", () => {
    const r = normalizeActivity(
      {
        ...baseActivity,
        attachments: [{ contentType: "image/png", contentUrl: "https://x/y.png", name: "y.png" }],
      },
      clock,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content.length).toBe(1); // only text block
    const meta = r.value.metadata ?? {};
    expect(Array.isArray(meta.attachments)).toBe(true);
  });

  test("missing timestamp falls back to clock()", () => {
    const { timestamp: _ts, ...rest } = baseActivity;
    const r = normalizeActivity(rest, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.timestamp).toBe(9_999_999);
  });

  test("@mention is stripped from text", () => {
    const r = normalizeActivity({ ...baseActivity, text: "<at>Bot</at> hi there" }, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([{ kind: "text", text: "hi there" }]);
  });

  test("empty text yields zero content blocks", () => {
    const r = normalizeActivity({ ...baseActivity, text: "" }, clock);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.content).toEqual([]);
  });
});
