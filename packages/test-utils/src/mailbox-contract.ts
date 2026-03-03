/**
 * Reusable contract test suite for MailboxComponent implementations.
 *
 * Accepts a factory that returns a MailboxComponent (sync or async).
 * Each test creates a fresh instance for isolation.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentMessage, MailboxComponent } from "@koi/core";
import { agentId } from "@koi/core";

/** Create a minimal AgentMessageInput for testing. */
function createInput(
  overrides?: Partial<{
    readonly from: ReturnType<typeof agentId>;
    readonly to: ReturnType<typeof agentId>;
    readonly kind: "request" | "response" | "event" | "cancel";
    readonly type: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }>,
): {
  readonly from: ReturnType<typeof agentId>;
  readonly to: ReturnType<typeof agentId>;
  readonly kind: "request" | "response" | "event" | "cancel";
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
} {
  return {
    from: agentId("agent-1"),
    to: agentId("agent-2"),
    kind: "request",
    type: "test-message",
    payload: { data: "hello" },
    ...overrides,
  };
}

/**
 * Run the MailboxComponent contract test suite against any implementation.
 *
 * The factory should return a mailbox configured for a specific agent.
 */
export function runMailboxContractTests(
  createMailbox: () => MailboxComponent | Promise<MailboxComponent>,
): void {
  describe("MailboxComponent contract", () => {
    let mailbox: MailboxComponent;

    beforeEach(async () => {
      mailbox = await createMailbox();
    });

    // -----------------------------------------------------------------------
    // send + list round-trip
    // -----------------------------------------------------------------------

    test("send + list round-trip stores and retrieves message", async () => {
      const input = createInput();
      const sendResult = await mailbox.send(input);
      expect(sendResult.ok).toBe(true);
      if (!sendResult.ok) return;

      const msg = sendResult.value;
      expect(msg.id).toBeTruthy();
      expect(msg.from).toBe(agentId("agent-1"));
      expect(msg.to).toBe(agentId("agent-2"));
      expect(msg.kind).toBe("request");
      expect(msg.type).toBe("test-message");
      expect(msg.payload).toEqual({ data: "hello" });
      expect(msg.createdAt).toBeTruthy();

      const messages = await mailbox.list();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.id).toBe(msg.id);
    });

    // -----------------------------------------------------------------------
    // onMessage
    // -----------------------------------------------------------------------

    test("onMessage handler fires when message is sent", async () => {
      const received: AgentMessage[] = [];
      const unsub = mailbox.onMessage((msg) => {
        received.push(msg);
      });

      await mailbox.send(createInput());
      // Allow microtask delivery
      await Bun.sleep(10);

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("test-message");

      unsub();
    });

    test("multiple subscribers all receive messages", async () => {
      const received1: AgentMessage[] = [];
      const received2: AgentMessage[] = [];

      const unsub1 = mailbox.onMessage((msg) => {
        received1.push(msg);
      });
      const unsub2 = mailbox.onMessage((msg) => {
        received2.push(msg);
      });

      await mailbox.send(createInput());
      await Bun.sleep(10);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);

      unsub1();
      unsub2();
    });

    test("unsubscribe stops delivery", async () => {
      const received: AgentMessage[] = [];
      const unsub = mailbox.onMessage((msg) => {
        received.push(msg);
      });
      unsub();

      await mailbox.send(createInput());
      await Bun.sleep(10);

      expect(received).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // list filters
    // -----------------------------------------------------------------------

    test("list with kind filter returns matching messages", async () => {
      await mailbox.send(createInput({ kind: "request" }));
      await mailbox.send(createInput({ kind: "event" }));
      await mailbox.send(createInput({ kind: "response" }));

      const requests = await mailbox.list({ kind: "request" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.kind).toBe("request");
    });

    test("list with type filter returns matching messages", async () => {
      await mailbox.send(createInput({ type: "code-review" }));
      await mailbox.send(createInput({ type: "deploy" }));
      await mailbox.send(createInput({ type: "code-review" }));

      const reviews = await mailbox.list({ type: "code-review" });
      expect(reviews).toHaveLength(2);
    });

    test("list with from filter returns matching messages", async () => {
      await mailbox.send(createInput({ from: agentId("agent-a") }));
      await mailbox.send(createInput({ from: agentId("agent-b") }));
      await mailbox.send(createInput({ from: agentId("agent-a") }));

      const fromA = await mailbox.list({ from: agentId("agent-a") });
      expect(fromA).toHaveLength(2);
    });

    test("list with limit restricts result count", async () => {
      await mailbox.send(createInput());
      await mailbox.send(createInput());
      await mailbox.send(createInput());

      const limited = await mailbox.list({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    // -----------------------------------------------------------------------
    // message ordering
    // -----------------------------------------------------------------------

    test("messages are returned in insertion order", async () => {
      await mailbox.send(createInput({ type: "first" }));
      await mailbox.send(createInput({ type: "second" }));
      await mailbox.send(createInput({ type: "third" }));

      const messages = await mailbox.list();
      expect(messages).toHaveLength(3);
      expect(messages[0]?.type).toBe("first");
      expect(messages[1]?.type).toBe("second");
      expect(messages[2]?.type).toBe("third");
    });

    // -----------------------------------------------------------------------
    // unique IDs
    // -----------------------------------------------------------------------

    test("each message gets a unique ID", async () => {
      const r1 = await mailbox.send(createInput());
      const r2 = await mailbox.send(createInput());
      const r3 = await mailbox.send(createInput());

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r3.ok).toBe(true);
      if (!r1.ok || !r2.ok || !r3.ok) return;

      const ids = new Set([r1.value.id, r2.value.id, r3.value.id]);
      expect(ids.size).toBe(3);
    });

    // -----------------------------------------------------------------------
    // createdAt auto-generated
    // -----------------------------------------------------------------------

    test("createdAt is auto-generated as ISO-8601 string", async () => {
      const before = new Date().toISOString();
      const result = await mailbox.send(createInput());
      const after = new Date().toISOString();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.createdAt).toBeTruthy();
      // Verify it's a valid ISO date string
      const parsed = new Date(result.value.createdAt);
      expect(parsed.toISOString()).toBe(result.value.createdAt);
      expect(result.value.createdAt >= before).toBe(true);
      expect(result.value.createdAt <= after).toBe(true);
    });
  });
}
