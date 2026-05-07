import { describe, expect, test } from "bun:test";
import { InMemoryIngressQueue, type QueueItem } from "./ingress-queue.js";

const item = (key: string): QueueItem => ({ key, payload: { hello: key }, normalized: null });

describe("InMemoryIngressQueue", () => {
  test("enqueue returns ok for new key", async () => {
    const q = new InMemoryIngressQueue();
    const r = await q.enqueue("k1", item("k1"));
    expect(r).toEqual({ ok: true });
  });

  test("enqueue rejects duplicate", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const r = await q.enqueue("k1", item("k1"));
    expect(r).toEqual({ ok: false, reason: "duplicate" });
  });

  test("claim returns enqueued item", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    expect(c?.key).toBe("k1");
  });

  test("claim returns null when empty", async () => {
    const q = new InMemoryIngressQueue();
    expect(await q.claim("w1", 1000)).toBeNull();
  });

  test("ack removes item", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    if (!c) throw new Error();
    await q.ack("w1", "k1");
    expect(await q.claim("w1", 1000)).toBeNull();
  });

  test("nack increments attempts and re-claimable", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c1 = await q.claim("w1", 1);
    if (!c1) throw new Error();
    await q.nack("w1", "k1");
    const c2 = await q.claim("w1", 1000);
    expect(c2?.attempts).toBe(1);
  });

  test("deadLetter moves out of main queue", async () => {
    const q = new InMemoryIngressQueue();
    await q.enqueue("k1", item("k1"));
    const c = await q.claim("w1", 1000);
    if (!c) throw new Error();
    await q.deadLetter("w1", "k1", "max-retries");
    expect(await q.claim("w1", 1000)).toBeNull();
    const dl = await q.getDeadLetters();
    expect(dl).toHaveLength(1);
    expect(dl[0]?.reason).toBe("max-retries");
  });

  test("expired claim re-claimable by another worker", async () => {
    let now = 0;
    const q = new InMemoryIngressQueue({ now: () => now });
    await q.enqueue("k1", item("k1"));
    const c1 = await q.claim("w1", 10);
    if (!c1) throw new Error();
    now = 11; // claim has expired
    const c2 = await q.claim("w2", 1000);
    expect(c2?.key).toBe("k1");
  });
});
