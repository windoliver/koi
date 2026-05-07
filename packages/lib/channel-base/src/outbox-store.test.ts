import { describe, expect, test } from "bun:test";
import { InMemoryOutboxStore, type OutboxRecord, type OutboxStatus } from "./outbox-store.js";

const rec = (status: OutboxStatus): OutboxRecord => ({
  messageId: "<m1@a>",
  threadKey: "t1",
  threadVersion: 1,
  payloadHash: "h",
  status,
  createdAt: 0,
});

describe("InMemoryOutboxStore", () => {
  test("put then get round-trips", async () => {
    const s = new InMemoryOutboxStore();
    await s.put(rec("reserved"));
    const r = await s.get("<m1@a>");
    expect(r?.status).toBe("reserved");
  });

  test("get returns null for unknown id", async () => {
    const s = new InMemoryOutboxStore();
    expect(await s.get("nope")).toBeNull();
  });

  test("cas succeeds on matching status", async () => {
    const s = new InMemoryOutboxStore();
    await s.put(rec("reserved"));
    expect(await s.cas("<m1@a>", "reserved", "sending")).toBe(true);
    const r = await s.get("<m1@a>");
    expect(r?.status).toBe("sending");
  });

  test("cas fails on status mismatch", async () => {
    const s = new InMemoryOutboxStore();
    await s.put(rec("reserved"));
    expect(await s.cas("<m1@a>", "sending", "sent")).toBe(false);
  });

  test("cas fails on unknown id", async () => {
    const s = new InMemoryOutboxStore();
    expect(await s.cas("nope", "reserved", "sent")).toBe(false);
  });

  test("list filters by status", async () => {
    const s = new InMemoryOutboxStore();
    await s.put(rec("reserved"));
    await s.put({ ...rec("sending"), messageId: "<m2@a>" });
    await s.put({ ...rec("sent"), messageId: "<m3@a>" });
    const sending = await s.list({ status: "sending" });
    expect(sending).toHaveLength(1);
    expect(sending[0]?.messageId).toBe("<m2@a>");
  });
});
