import { describe, expect, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { createDebouncer } from "./debounce.js";

function msg(text: string, senderId = "user1", threadId = "thread1"): InboundMessage {
  return {
    content: [{ kind: "text", text }],
    senderId,
    threadId,
    timestamp: Date.now(),
  };
}

describe("createDebouncer", () => {
  test("single message passes through after window", async () => {
    const debouncer = createDebouncer({ windowMs: 50 });
    const result = await debouncer.submit(msg("hello"));
    expect(result.content).toEqual([{ kind: "text", text: "hello" }]);
    debouncer.dispose();
  });

  test("rapid messages from same sender are merged", async () => {
    const debouncer = createDebouncer({ windowMs: 100 });
    const p1 = debouncer.submit(msg("line 1"));
    const p2 = debouncer.submit(msg("line 2"));
    const p3 = debouncer.submit(msg("line 3"));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // All resolve to the same merged message
    expect(r1.content).toHaveLength(3);
    expect(r1.content[0]).toEqual({ kind: "text", text: "line 1" });
    expect(r1.content[1]).toEqual({ kind: "text", text: "line 2" });
    expect(r1.content[2]).toEqual({ kind: "text", text: "line 3" });
    expect(r2.content).toHaveLength(3);
    expect(r3.content).toHaveLength(3);
    debouncer.dispose();
  });

  test("different senders are not merged", async () => {
    const debouncer = createDebouncer({ windowMs: 100 });
    const p1 = debouncer.submit(msg("from A", "userA"));
    const p2 = debouncer.submit(msg("from B", "userB"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toHaveLength(1);
    expect(r2.content).toHaveLength(1);
    debouncer.dispose();
  });

  test("different threads are not merged", async () => {
    const debouncer = createDebouncer({ windowMs: 100 });
    const p1 = debouncer.submit(msg("thread A", "user1", "threadA"));
    const p2 = debouncer.submit(msg("thread B", "user1", "threadB"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toHaveLength(1);
    expect(r2.content).toHaveLength(1);
    debouncer.dispose();
  });

  test("dispose flushes pending messages immediately", async () => {
    const debouncer = createDebouncer({ windowMs: 10_000 });
    const p1 = debouncer.submit(msg("pending 1"));
    const p2 = debouncer.submit(msg("pending 2"));

    // Dispose should resolve immediately
    debouncer.dispose();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toHaveLength(2);
    expect(r2.content).toHaveLength(2);
  });

  test("custom keyFn controls grouping", async () => {
    const debouncer = createDebouncer({
      windowMs: 100,
      keyFn: (m) => m.threadId ?? "unknown",
    });
    // Same thread, different sender — should merge because keyFn only uses threadId
    const p1 = debouncer.submit(msg("from A", "userA", "shared"));
    const p2 = debouncer.submit(msg("from B", "userB", "shared"));

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content).toHaveLength(2);
    expect(r2.content).toHaveLength(2);
    debouncer.dispose();
  });

  test("preserves first message metadata", async () => {
    const debouncer = createDebouncer({ windowMs: 100 });
    const m1 = msg("first");
    const p1 = debouncer.submit(m1);
    const p2 = debouncer.submit(msg("second"));

    const [r1] = await Promise.all([p1, p2]);
    expect(r1.senderId).toBe(m1.senderId);
    expect(r1.threadId).toBe(m1.threadId);
    debouncer.dispose();
  });

  test("messages after window expires start a new batch", async () => {
    const debouncer = createDebouncer({ windowMs: 30 });
    const r1 = await debouncer.submit(msg("batch1"));
    expect(r1.content).toHaveLength(1);

    // After the window, this should be a new batch
    const r2 = await debouncer.submit(msg("batch2"));
    expect(r2.content).toHaveLength(1);
    debouncer.dispose();
  });
});
