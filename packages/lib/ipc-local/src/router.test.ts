import { describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import { createLocalMailbox } from "./mailbox.js";
import { createLocalMailboxRouter } from "./router.js";

describe("createLocalMailboxRouter", () => {
  test("register and get returns a defined view for the mailbox", () => {
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1"), router });
    router.register(agentId("agent-1"), mailbox);
    const view = router.getView(agentId("agent-1"));
    expect(view).toBeDefined();
    // View is a read-only wrapper — not the same object as the mailbox.
    expect(view).not.toBe(mailbox);
    // list and revoked are present; onMessage/send/drain/close are absent at runtime.
    expect(typeof view?.list).toBe("function");
    expect(view?.revoked).toBe(false);
    expect((view as unknown as Record<string, unknown>).onMessage).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).send).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).drain).toBeUndefined();
    expect((view as unknown as Record<string, unknown>).close).toBeUndefined();
    mailbox.close();
  });

  test("get returns undefined for unregistered agent", () => {
    const router = createLocalMailboxRouter();
    expect(router.getView(agentId("unknown"))).toBeUndefined();
  });

  test("unregister removes the mailbox and revokes the cached view", () => {
    const router = createLocalMailboxRouter();
    const mailbox = createLocalMailbox({ agentId: agentId("agent-1"), router });
    router.register(agentId("agent-1"), mailbox);
    const view = router.getView(agentId("agent-1"))!;
    expect(view.revoked).toBe(false);
    router.unregister(agentId("agent-1"));
    expect(router.getView(agentId("agent-1"))).toBeUndefined();
    // Cached view is revoked — check view.revoked to distinguish from a genuinely empty inbox.
    expect(view.revoked).toBe(true);
    expect(view.list()).toHaveLength(0);
    mailbox.close();
  });

  test("multiple agents registered independently", () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("b"), router });
    router.register(agentId("a"), mailboxA);
    router.register(agentId("b"), mailboxB);
    expect(router.getView(agentId("a"))).toBeDefined();
    expect(router.getView(agentId("b"))).toBeDefined();
    mailboxA.close();
    mailboxB.close();
  });

  test("unregister one does not affect others", () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("b"), router });
    router.register(agentId("a"), mailboxA);
    router.register(agentId("b"), mailboxB);
    router.unregister(agentId("a"));
    expect(router.getView(agentId("a"))).toBeUndefined();
    expect(router.getView(agentId("b"))).toBeDefined();
    mailboxA.close();
    mailboxB.close();
  });

  test("multi-agent routing — send through router to target mailbox", async () => {
    const router = createLocalMailboxRouter();
    // Both mailboxes must share the same router so cross-agent sends are authenticated.
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    // Send via the OUTBOUND path of mailboxA — routes through the internal delivery function.
    const result = await mailboxA.send({
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

  test("re-registering agent replaces existing mailbox", async () => {
    const router = createLocalMailboxRouter();
    const mailboxOld = createLocalMailbox({ agentId: agentId("agent-1"), router });
    const mailboxNew = createLocalMailbox({ agentId: agentId("agent-1"), router });
    router.register(agentId("agent-1"), mailboxOld);
    router.register(agentId("agent-1"), mailboxNew);
    // View is defined after re-registration.
    expect(router.getView(agentId("agent-1"))).toBeDefined();
    // The view reflects the new mailbox: a message sent to agent-1 should land in mailboxNew.
    const sender = createLocalMailbox({ agentId: agentId("sender"), router });
    router.register(agentId("sender"), sender);
    await sender.send({
      from: agentId("sender"),
      to: agentId("agent-1"),
      kind: "event",
      type: "ping",
      payload: {},
    });
    expect(await mailboxNew.list()).toHaveLength(1);
    expect(await mailboxOld.list()).toHaveLength(0);
    sender.close();
    mailboxOld.close();
    mailboxNew.close();
  });

  test("cached router.getView() view is revoked on re-registration — old handles cannot read new mailbox", async () => {
    const router = createLocalMailboxRouter();
    const mailboxOld = createLocalMailbox({ agentId: agentId("agent-x"), router });
    const mailboxNew = createLocalMailbox({ agentId: agentId("agent-x"), router });
    const sender = createLocalMailbox({ agentId: agentId("sender"), router });
    router.register(agentId("agent-x"), mailboxOld);
    router.register(agentId("sender"), sender);

    // Caller caches the view before re-registration.
    const oldView = router.getView(agentId("agent-x"));
    expect(oldView).toBeDefined();

    // Re-register under the same key — revokes the old view and creates a new one.
    router.register(agentId("agent-x"), mailboxNew);

    // Send a message to agent-x via sender; it lands in mailboxNew.
    await sender.send({
      from: agentId("sender"),
      to: agentId("agent-x"),
      kind: "event",
      type: "after-rereg",
      payload: {},
    });

    // The OLD view is revoked — check revoked to distinguish from a genuinely empty inbox.
    expect(oldView?.revoked).toBe(true);
    expect(await oldView?.list()).toHaveLength(0);

    // A FRESH router.getView() returns the new view which reflects mailboxNew.
    const newView = router.getView(agentId("agent-x"));
    const msgs = (await newView?.list()) ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe("after-rereg");
    expect(await mailboxOld.list()).toHaveLength(0);

    sender.close();
    mailboxOld.close();
    mailboxNew.close();
  });

  test("router.getView() view delegates list() to the underlying mailbox", async () => {
    const router = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    const mailboxB = createLocalMailbox({ agentId: agentId("agent-b"), router });
    router.register(agentId("agent-a"), mailboxA);
    router.register(agentId("agent-b"), mailboxB);

    await mailboxA.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "event",
      type: "hello",
      payload: {},
    });

    // The view's list() should reflect the mailbox's actual messages.
    const view = router.getView(agentId("agent-b"));
    const msgs = (await view?.list()) ?? [];
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.type).toBe("hello");
    mailboxA.close();
    mailboxB.close();
  });

  test("register() throws when mailbox agentId does not match the key", () => {
    const router = createLocalMailboxRouter();
    // mailboxA is bound to agent-a but we try to register it under agent-b.
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router });
    expect(() => router.register(agentId("agent-b"), mailboxA)).toThrow(
      /cannot register mailbox bound to agent-a under agent-b/,
    );
  });

  test("register() rejects a mailbox created with a different router (cross-router guard)", () => {
    // Mailboxes bound to routerA must not be registered in routerB — they were created
    // without routerB's inbound-auth context, so registration would silently disable
    // the forgery guard for all messages delivered through routerB to that mailbox.
    const routerA = createLocalMailboxRouter();
    const routerB = createLocalMailboxRouter();
    const mailboxA = createLocalMailbox({ agentId: agentId("agent-a"), router: routerA });
    expect(() => routerB.register(agentId("agent-a"), mailboxA)).toThrow(
      /was not created with this router/,
    );
    mailboxA.close();
  });

  test("register() rejects a mailbox created without any router (routerless guard)", () => {
    // A routerless mailbox has no inbound-auth guard at all: config.router is undefined,
    // so send() skips the routing-token check entirely. Registering such a mailbox would
    // allow any caller who obtains a mailbox reference to inject forged-sender messages.
    const router = createLocalMailboxRouter();
    const routerless = createLocalMailbox({ agentId: agentId("agent-a") });
    expect(() => router.register(agentId("agent-a"), routerless)).toThrow(
      /was not created with this router/,
    );
    routerless.close();
  });

  test("register() rejects a non-LocalMailbox at runtime (impersonation guard)", () => {
    const router = createLocalMailboxRouter();
    // register() requires LocalMailboxInstance at compile time; at runtime the WeakMap
    // identity check also catches JS-only callers and wrong-package instances.
    const plain = {
      send: async () => ({ ok: true as const, value: {} as import("@koi/core").AgentMessage }),
      onMessage: () => () => {},
      list: () => [],
      drain: () => [],
    };
    expect(() =>
      router.register(
        agentId("any"),
        plain as unknown as import("./types.js").LocalMailboxInstance,
      ),
    ).toThrow(/only LocalMailbox instances/);
  });

  test("register() rejects a custom object that is not a LocalMailbox (impersonation guard)", () => {
    const router = createLocalMailboxRouter();
    // An attacker's custom object can satisfy any structural type check,
    // but without a deliveryFunctions WeakMap entry it still cannot authenticate messages.
    const custom = {
      send: async () => ({ ok: true as const, value: {} as import("@koi/core").AgentMessage }),
      onMessage: () => () => {},
      list: () => [],
      drain: () => [],
    };
    expect(() =>
      router.register(
        agentId("any"),
        custom as unknown as import("./types.js").LocalMailboxInstance,
      ),
    ).toThrow(/only LocalMailbox instances/);
  });
});
