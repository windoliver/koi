import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createLocalMailbox } from "./mailbox.js";
import { createLocalMailboxRouter } from "./router.js";

describe("createLocalMailboxRouter", () => {
  test("register and get returns the mailbox", () => {
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1") });

    router.register(agentId("agent-1"), mailbox);
    const retrieved = router.get(agentId("agent-1"));
    expect(retrieved).toBe(mailbox);
  });

  test("get returns undefined for unregistered agent", () => {
    const router = createLocalMailboxRouter();
    expect(router.get(agentId("unknown"))).toBeUndefined();
  });

  test("unregister removes the mailbox", () => {
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1") });

    router.register(agentId("agent-1"), mailbox);
    router.unregister(agentId("agent-1"));

    expect(router.get(agentId("agent-1"))).toBeUndefined();
  });

  test("multi-agent routing — send to another agent's mailbox", async () => {
    const router = createLocalMailboxRouter();

    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a") });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b") });

    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    // Agent A sends a message to Agent B
    const targetMailbox = router.get(agentId("agent-b"));
    expect(targetMailbox).toBeDefined();
    if (targetMailbox === undefined) return;

    const result = await targetMailbox.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "code-review",
      payload: { file: "main.ts" },
    });
    expect(result.ok).toBe(true);

    // Agent B's mailbox should have the message
    const bMessages = await mailboxB.list();
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0]?.from).toBe(agentId("agent-a"));
    expect(bMessages[0]?.type).toBe("code-review");

    // Agent A's mailbox should be empty
    const aMessages = await mailboxA.list();
    expect(aMessages).toHaveLength(0);

    mailboxA.close();
    mailboxB.close();
  });
});
