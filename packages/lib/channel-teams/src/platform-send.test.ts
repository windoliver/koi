import { describe, expect, test } from "bun:test";
import type { ConversationAddress } from "@koi/channel-base";
import { type FetchFn, sendActivity } from "./platform-send.js";

const address: ConversationAddress = {
  serviceUrl: "https://smba.trafficmanager.net/",
  tenantId: "tenant-1",
  channelId: "msteams",
  conversationId: "conv-1",
  recipient: { id: "user-1", name: "Alice" },
  lastSeenAt: 1,
};

describe("sendActivity", () => {
  test("200 with id parses activityId", async () => {
    const fetchFn: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://smba.trafficmanager.net/v3/conversations/conv-1/activities");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tok");
      return new Response(JSON.stringify({ id: "act-out-1" }), { status: 200 });
    };
    const r = await sendActivity(fetchFn, address, "conv-1", "tok", { type: "message", text: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.value.activityId).toBe("act-out-1");
  });

  test("401 surfaces SEND_FAILED with status in context", async () => {
    const fetchFn: FetchFn = async () => new Response("nope", { status: 401 });
    const r = await sendActivity(fetchFn, address, "conv-1", "tok", { type: "message", text: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.code).toBe("SEND_FAILED");
    expect(r.error.context.status).toBe(401);
  });

  test("network error surfaces SEND_FAILED with status 0", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await sendActivity(fetchFn, address, "conv-1", "tok", { type: "message", text: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.context.status).toBe(0);
  });
});
