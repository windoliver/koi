import { describe, expect, test } from "bun:test";
import type { ChannelAdapter, OutboundMessage } from "@koi/core";
import { createProactiveDelivery } from "./proactive-delivery.js";

function stubAdapter(name: string, send?: (m: OutboundMessage) => Promise<void>): ChannelAdapter {
  return {
    name,
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: true,
      supportsA2ui: false,
    },
    connect: async () => {},
    disconnect: async () => {},
    send: send ?? (async () => {}),
    onMessage: () => () => {},
  };
}

describe("createProactiveDelivery", () => {
  test("returns no_channels when channel map is empty", async () => {
    const delivery = createProactiveDelivery({ channels: new Map() });
    const result = await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
    });
    expect(result).toEqual({ ok: false, reason: "no_channels" });
  });

  test("high priority routes to preferredChannel", async () => {
    const sent: { channel: string; msg: OutboundMessage }[] = [];
    const slack = stubAdapter("slack", async (m) => {
      sent.push({ channel: "slack", msg: m });
    });
    const email = stubAdapter("email", async (m) => {
      sent.push({ channel: "email", msg: m });
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["email"] });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channel).toBe("email");
    expect(sent[0]?.msg.content).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("high priority falls back to first channel when no preferred", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const email = stubAdapter("email", async () => {
      sent.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
    });

    const result = await delivery.send({
      priority: "high",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack"]);
  });

  test("normal and low priority behave identically to high in Phase 3", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    const r1 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    const r2 = await delivery.send({ priority: "low", content: [{ kind: "text", text: "l" }] });

    expect(r1).toEqual({ ok: true, delivered: ["slack"] });
    expect(r2).toEqual({ ok: true, delivered: ["slack"] });
    expect(sent).toEqual(["slack", "slack"]);
  });

  test("threadId and metadata forwarded verbatim to OutboundMessage", async () => {
    const captured: OutboundMessage[] = [];
    const slack = stubAdapter("slack", async (m) => {
      captured.push(m);
    });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      content: [{ kind: "text", text: "hi" }],
      threadId: "T1",
      metadata: { source: "composition" },
    });
  });

  test("urgent priority fans out to all channels", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const email = stubAdapter("email", async () => {
      sent.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack", "email"] });
    expect(sent.sort()).toEqual(["email", "slack"]);
  });

  test("urgent partial failure — one channel succeeds, one fails", async () => {
    const slack = stubAdapter("slack", async () => {});
    const email = stubAdapter("email", async () => {
      throw new Error("smtp down");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("urgent total failure — every channel fails → all_failed with all in failures", async () => {
    const slack = stubAdapter("slack", async () => {
      throw new Error("boom");
    });
    const email = stubAdapter("email", async () => {
      throw new Error("smtp down");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
    });

    const result = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("all_failed");
    const failures = [...(result.failures ?? [])].sort((a, b) =>
      a.channel.localeCompare(b.channel),
    );
    expect(failures).toEqual([
      { channel: "email", error: "smtp down" },
      { channel: "slack", error: "boom" },
    ]);
  });

  test("rate limit blocks normal priority after cap", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 2 },
      now: () => t,
    });

    const a = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const b = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    const c = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c).toEqual({ ok: false, reason: "rate_limited" });
  });

  test("rate-limit window slides — old entries drop, new send goes through", async () => {
    let t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    const a = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    expect(a.ok).toBe(true);

    // Same instant → still at cap.
    const b = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    expect(b).toEqual({ ok: false, reason: "rate_limited" });

    // Advance just past 1 hour → previous entry slides out.
    t += 3_600_001;
    const c = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });
    expect(c.ok).toBe(true);
  });

  test("urgent bypasses rate limit even at cap", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 0 },
      now: () => t,
    });

    const r = await delivery.send({
      priority: "urgent",
      content: [{ kind: "text", text: "alert" }],
    });
    expect(r.ok).toBe(true);
  });

  test("urgent does not consume rate-limit window capacity", async () => {
    const t = 1_700_000_000_000;
    const slack = stubAdapter("slack", async () => {});
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    // Two urgent sends do NOT fill the bucket.
    await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u1" }] });
    await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u2" }] });

    // A normal send still passes — cap is not reached.
    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r.ok).toBe(true);
  });

  test("adapter throw on single channel → all_failed without propagation", async () => {
    const slack = stubAdapter("slack", async () => {
      throw new Error("network");
    });
    const delivery = createProactiveDelivery({ channels: new Map([["slack", slack]]) });

    const result = await delivery.send({
      priority: "normal",
      content: [{ kind: "text", text: "hi" }],
    });

    expect(result).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [{ channel: "slack", error: "network" }],
    });
  });

  test("normal during quiet window → quiet_hours, adapter NOT called", async () => {
    let sendCount = 0;
    const slack = stubAdapter("slack", async () => {
      sendCount += 1;
    });
    // 2026-05-10 03:00:00 UTC — within 22-6 quiet window
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r).toEqual({ ok: false, reason: "quiet_hours" });
    expect(sendCount).toBe(0);
  });

  test("normal outside quiet window → delivered", async () => {
    const slack = stubAdapter("slack", async () => {});
    // 14:00 UTC, outside 22-6
    const t = Date.UTC(2026, 4, 10, 14, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "n" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("high during quiet window → delivered (bypasses quiet)", async () => {
    const slack = stubAdapter("slack", async () => {});
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("urgent during quiet window → fan-out as Phase 3", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const email = stubAdapter("email", async () => {
      sent.push("email");
    });
    const t = Date.UTC(2026, 4, 10, 3, 0, 0);
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
      now: () => t,
    });

    const r = await delivery.send({ priority: "urgent", content: [{ kind: "text", text: "u" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack", "email"] });
    expect(sent.sort()).toEqual(["email", "slack"]);
  });

  test("throws when only quietHoursStart is set", () => {
    const slack = stubAdapter("slack", async () => {});
    expect(() =>
      createProactiveDelivery({
        channels: new Map([["slack", slack]]),
        preferences: { quietHoursStart: 22 },
      }),
    ).toThrow(/quietHoursStart and quietHoursEnd must both be set/);
  });

  test("two concurrent sends at cap=1 — exactly one passes", async () => {
    const t = 1_700_000_000_000;
    let releaseA: (() => void) | undefined;
    const blocker = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let inFlight = 0;
    const slack = stubAdapter("slack", async () => {
      inFlight += 1;
      try {
        await blocker;
      } finally {
        inFlight -= 1;
      }
    });
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: { maxNotificationsPerHour: 1 },
      now: () => t,
    });

    const p1 = delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const p2 = delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });

    // Wait one microtask so both reservations are evaluated synchronously.
    await Promise.resolve();
    expect(inFlight).toBe(1);

    releaseA?.();
    const [r1, r2] = await Promise.all([p1, p2]);
    const ok = [r1, r2].filter((r) => r.ok);
    const blocked = [r1, r2].filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual({ ok: false, reason: "rate_limited" });
  });

  test("cross-midnight window (22, 6): hours 23, 0, 5 quiet; 6, 21 not", async () => {
    const slack = stubAdapter("slack", async () => {});
    const make = (t: number) =>
      createProactiveDelivery({
        channels: new Map([["slack", slack]]),
        preferences: { quietHoursStart: 22, quietHoursEnd: 6, timezone: "UTC" },
        now: () => t,
      });
    const at = (h: number) => Date.UTC(2026, 4, 10, h, 0, 0);
    const send = (t: number) =>
      make(t).send({ priority: "normal", content: [{ kind: "text", text: "x" }] });

    expect((await send(at(23))).ok).toBe(false);
    expect((await send(at(0))).ok).toBe(false);
    expect((await send(at(5))).ok).toBe(false);
    expect((await send(at(6))).ok).toBe(true);
    expect((await send(at(21))).ok).toBe(true);
  });

  test("quiet-suppressed normal does not consume rate-limit slot", async () => {
    const slack = stubAdapter("slack", async () => {});
    let t = Date.UTC(2026, 4, 10, 3, 0, 0); // quiet
    const delivery = createProactiveDelivery({
      channels: new Map([["slack", slack]]),
      preferences: {
        quietHoursStart: 22,
        quietHoursEnd: 6,
        timezone: "UTC",
        maxNotificationsPerHour: 1,
      },
      now: () => t,
    });

    // Two suppressed sends inside quiet window — should not fill bucket.
    const r1 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "1" }] });
    const r2 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "2" }] });
    expect(r1).toEqual({ ok: false, reason: "quiet_hours" });
    expect(r2).toEqual({ ok: false, reason: "quiet_hours" });

    // Move outside quiet window; cap=1 should still permit one delivery.
    t = Date.UTC(2026, 4, 10, 14, 0, 0);
    const r3 = await delivery.send({ priority: "normal", content: [{ kind: "text", text: "3" }] });
    expect(r3).toEqual({ ok: true, delivered: ["slack"] });
  });

  test("high: preferred succeeds → only preferred called", async () => {
    const sent: string[] = [];
    const slack = stubAdapter("slack", async () => {
      sent.push("slack");
    });
    const email = stubAdapter("email", async () => {
      sent.push("email");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["email"] });
    expect(sent).toEqual(["email"]);
  });

  test("high: preferred fails, second succeeds → walks fallback in order", async () => {
    const calls: string[] = [];
    const slack = stubAdapter("slack", async () => {
      calls.push("slack");
    });
    const email = stubAdapter("email", async () => {
      calls.push("email");
      throw new Error("smtp down");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({ ok: true, delivered: ["slack"] });
    expect(calls).toEqual(["email", "slack"]);
  });

  test("high: every channel fails → all_failed with failures in attempt order", async () => {
    const slack = stubAdapter("slack", async () => {
      throw new Error("net");
    });
    const email = stubAdapter("email", async () => {
      throw new Error("smtp");
    });
    const delivery = createProactiveDelivery({
      channels: new Map([
        ["slack", slack],
        ["email", email],
      ]),
      preferences: { preferredChannel: "email" },
    });

    const r = await delivery.send({ priority: "high", content: [{ kind: "text", text: "h" }] });
    expect(r).toEqual({
      ok: false,
      reason: "all_failed",
      failures: [
        { channel: "email", error: "smtp" },
        { channel: "slack", error: "net" },
      ],
    });
  });
});
