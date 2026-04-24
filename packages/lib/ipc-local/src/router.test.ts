import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createLocalMailbox } from "./mailbox.js";
import { createLocalMailboxRouter } from "./router.js";

describe("createLocalMailboxRouter", () => {
  test("register and get returns the mailbox", () => {
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1") });
    router.register(agentId("agent-1"), mailbox);
    expect(router.get(agentId("agent-1"))).toBe(mailbox);
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

  test("multiple agents registered independently", () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("a") });
    const mailboxB = createLocalMailbox({ agentId: agentId("b") });
    router.register(agentId("a"), mailboxA);
    router.register(agentId("b"), mailboxB);
    expect(router.get(agentId("a"))).toBe(mailboxA);
    expect(router.get(agentId("b"))).toBe(mailboxB);
  });

  test("unregister one does not affect others", () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("a") });
    const mailboxB = createLocalMailbox({ agentId: agentId("b") });
    router.register(agentId("a"), mailboxA);
    router.register(agentId("b"), mailboxB);
    router.unregister(agentId("a"));
    expect(router.get(agentId("a"))).toBeUndefined();
    expect(router.get(agentId("b"))).toBe(mailboxB);
  });

  test("multi-agent routing — send through router to target mailbox", async () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a") });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b") });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

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

    const bMessages = await mailboxB.list();
    expect(bMessages).toHaveLength(1);
    expect(bMessages[0]?.from).toBe(agentId("agent-a"));
    expect(bMessages[0]?.type).toBe("code-review");

    const aMessages = await mailboxA.list();
    expect(aMessages).toHaveLength(0);

    mailboxA.close();
    mailboxB.close();
  });

  test("re-registering agent replaces existing mailbox", () => {
    const router = createLocalMailboxRouter();
    const mailboxOld = createLocalMailbox({ agentId: agentId("agent-1") });
    const mailboxNew = createLocalMailbox({ agentId: agentId("agent-1") });
    router.register(agentId("agent-1"), mailboxOld);
    router.register(agentId("agent-1"), mailboxNew);
    expect(router.get(agentId("agent-1"))).toBe(mailboxNew);
  });

  test("register() throws when mailbox agentId does not match the key", () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a") });
    expect(() => router.register(agentId("agent-b"), mailboxA)).toThrow(
      /cannot register mailbox bound to agent-a under agent-b/,
    );
  });

  test("register() accepts a generic MailboxComponent (no agentId to check)", () => {
    const router = createLocalMailboxRouter();
    // A plain MailboxComponent without an agentId property is valid
    const plain: import("@koi/core").MailboxComponent = {
      send: async () => ({ ok: true, value: {} as import("@koi/core").AgentMessage }),
      onMessage: () => () => {},
      list: () => [],
      drain: () => {},
    };
    expect(() => router.register(agentId("any"), plain)).not.toThrow();
  });
});
