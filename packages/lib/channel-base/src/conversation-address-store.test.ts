import { describe, expect, test } from "bun:test";
import {
  type ConversationAddress,
  InMemoryConversationAddressStore,
} from "./conversation-address-store.js";

const addr = (id: string): ConversationAddress => ({
  serviceUrl: "https://smba.trafficmanager.net/teams/",
  tenantId: "t1",
  channelId: "msteams",
  conversationId: "raw-conv-id",
  recipient: { id, name: "x" },
  lastSeenAt: 0,
});

describe("InMemoryConversationAddressStore", () => {
  test("put then get round-trips", async () => {
    const s = new InMemoryConversationAddressStore();
    await s.put("c1", addr("u1"));
    const r = await s.get("c1");
    expect(r?.recipient.id).toBe("u1");
  });

  test("get returns null for unknown id", async () => {
    const s = new InMemoryConversationAddressStore();
    expect(await s.get("nope")).toBeNull();
  });

  test("subsequent put overwrites", async () => {
    const s = new InMemoryConversationAddressStore();
    await s.put("c1", addr("u1"));
    await s.put("c1", addr("u2"));
    expect((await s.get("c1"))?.recipient.id).toBe("u2");
  });
});
