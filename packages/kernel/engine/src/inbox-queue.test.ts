import { describe, expect, test } from "bun:test";
import type { InboxItem } from "@koi/core";
import { agentId } from "@koi/core";
import { createInboxQueue } from "./inbox-queue.js";

function createItem(mode: InboxItem["mode"], id: string): InboxItem {
  return {
    id,
    from: agentId("sender"),
    mode,
    content: `item-${id}`,
    priority: 0,
    createdAt: Date.now(),
  };
}

describe("createInboxQueue", () => {
  test("push and drain returns items in insertion order", () => {
    const inbox = createInboxQueue();
    inbox.push(createItem("collect", "1"));
    inbox.push(createItem("collect", "2"));

    const items = inbox.drain();
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("1");
    expect(items[1]?.id).toBe("2");
  });

  test("drain clears the queue", () => {
    const inbox = createInboxQueue();
    inbox.push(createItem("collect", "1"));
    inbox.drain();

    expect(inbox.depth()).toBe(0);
    expect(inbox.drain()).toHaveLength(0);
  });

  test("peek returns items without removing", () => {
    const inbox = createInboxQueue();
    inbox.push(createItem("followup", "1"));

    const peeked = inbox.peek();
    expect(peeked).toHaveLength(1);
    expect(inbox.depth()).toBe(1);
  });

  test("depth counts items across all modes", () => {
    const inbox = createInboxQueue();
    inbox.push(createItem("collect", "1"));
    inbox.push(createItem("followup", "2"));
    inbox.push(createItem("steer", "3"));

    expect(inbox.depth()).toBe(3);
  });

  test("respects collect cap (default 20)", () => {
    const inbox = createInboxQueue();
    for (let i = 0; i < 20; i++) {
      expect(inbox.push(createItem("collect", `c-${i}`))).toBe(true);
    }
    expect(inbox.push(createItem("collect", "c-overflow"))).toBe(false);
    expect(inbox.depth()).toBe(20);
  });

  test("respects followup cap (default 50)", () => {
    const inbox = createInboxQueue();
    for (let i = 0; i < 50; i++) {
      expect(inbox.push(createItem("followup", `f-${i}`))).toBe(true);
    }
    expect(inbox.push(createItem("followup", "f-overflow"))).toBe(false);
  });

  test("respects steer cap (default 1)", () => {
    const inbox = createInboxQueue();
    expect(inbox.push(createItem("steer", "s-1"))).toBe(true);
    expect(inbox.push(createItem("steer", "s-2"))).toBe(false);
    expect(inbox.depth()).toBe(1);
  });

  test("custom policy overrides defaults", () => {
    const inbox = createInboxQueue({
      policy: { collectCap: 2, followupCap: 3, steerCap: 2 },
    });

    expect(inbox.push(createItem("collect", "1"))).toBe(true);
    expect(inbox.push(createItem("collect", "2"))).toBe(true);
    expect(inbox.push(createItem("collect", "3"))).toBe(false);

    expect(inbox.push(createItem("steer", "s1"))).toBe(true);
    expect(inbox.push(createItem("steer", "s2"))).toBe(true);
    expect(inbox.push(createItem("steer", "s3"))).toBe(false);
  });

  test("drain returns items grouped by mode: collect, followup, steer", () => {
    const inbox = createInboxQueue();
    inbox.push(createItem("steer", "s1"));
    inbox.push(createItem("collect", "c1"));
    inbox.push(createItem("followup", "f1"));

    const items = inbox.drain();
    expect(items).toHaveLength(3);
    // collect first, then followup, then steer (per implementation order)
    expect(items[0]?.mode).toBe("collect");
    expect(items[1]?.mode).toBe("followup");
    expect(items[2]?.mode).toBe("steer");
  });
});
