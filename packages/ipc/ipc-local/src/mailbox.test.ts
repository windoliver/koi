import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { runMailboxContractTests } from "@koi/test-utils";
import { createLocalMailbox } from "./mailbox.js";

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

runMailboxContractTests(() => createLocalMailbox({ agentId: agentId("agent-1") }));

// ---------------------------------------------------------------------------
// Local-specific unit tests
// ---------------------------------------------------------------------------

describe("createLocalMailbox — local specifics", () => {
  test("FIFO eviction when at capacity", async () => {
    const mailbox = createLocalMailbox({
      agentId: agentId("agent-1"),
      maxMessages: 3,
    });

    for (const i of [1, 2, 3, 4]) {
      await mailbox.send({
        from: agentId("sender"),
        to: agentId("agent-1"),
        kind: "event",
        type: `msg-${i}`,
        payload: {},
      });
    }

    const messages = await mailbox.list();
    expect(messages).toHaveLength(3);
    // First message should have been evicted
    expect(messages[0]?.type).toBe("msg-2");
    expect(messages[1]?.type).toBe("msg-3");
    expect(messages[2]?.type).toBe("msg-4");

    mailbox.close();
  });

  test("close clears messages and subscribers", async () => {
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1") });

    await mailbox.send({
      from: agentId("a"),
      to: agentId("agent-1"),
      kind: "event",
      type: "test",
      payload: {},
    });

    mailbox.close();

    const messages = await mailbox.list();
    expect(messages).toHaveLength(0);
  });

  test("microtask dispatch delivers after current task", async () => {
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1") });
    const received: string[] = [];

    mailbox.onMessage((msg) => {
      received.push(msg.type);
    });

    await mailbox.send({
      from: agentId("a"),
      to: agentId("agent-1"),
      kind: "event",
      type: "deferred",
      payload: {},
    });

    // Delivery is via microtask, so it should arrive after await
    await Bun.sleep(5);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("deferred");

    mailbox.close();
  });
});
