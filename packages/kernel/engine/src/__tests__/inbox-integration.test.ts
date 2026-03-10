/**
 * Inbox integration tests — verifies inbox queue drains at turn boundaries (Decision 9B).
 *
 * Uses FakeEngineAdapter for controllable turn scripting and an InboxComponent
 * provider to attach the inbox queue to the agent entity.
 */

import { describe, expect, test } from "bun:test";
import type {
  Agent,
  AttachResult,
  ComponentProvider,
  EngineEvent,
  InboxComponent,
  InboxItem,
} from "@koi/core";
import { agentId, INBOX } from "@koi/core";
import { createFakeEngineAdapter } from "@koi/test-utils";
import { createInboxQueue } from "../inbox-queue.js";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest() {
  return {
    name: "inbox-integration-agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function createInboxProvider(inbox: InboxComponent): ComponentProvider {
  return {
    name: "test-inbox-provider",
    priority: 100,
    attach: async (_agent: Agent): Promise<AttachResult> => {
      const components = new Map<string, unknown>();
      components.set(INBOX as string, inbox);
      return { components, skipped: [] };
    },
  };
}

function makeInboxItem(overrides?: Partial<InboxItem>): InboxItem {
  return {
    id: `item-${Date.now()}`,
    from: agentId("sender"),
    mode: "followup",
    content: "Test message",
    priority: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("inbox integration", () => {
  test("inbox items are drained at turn boundary", async () => {
    const inbox = createInboxQueue();
    const { adapter } = createFakeEngineAdapter({
      turns: [[{ kind: "text_delta", delta: "response 1" }]],
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [createInboxProvider(inbox)],
    });

    // Push items before running
    inbox.push(makeInboxItem({ id: "i1", mode: "collect" }));
    inbox.push(makeInboxItem({ id: "i2", mode: "followup" }));
    expect(inbox.depth()).toBe(2);

    await collectEvents(runtime.run({ kind: "text", text: "go" }));

    // After the run, collect/followup items are retained for middleware
    // consumption in the next turn (not discarded). Only steer items
    // with a present adapter.inject are consumed immediately.
    expect(inbox.depth()).toBe(2);
  });

  test("steer items trigger adapter.inject()", async () => {
    const inbox = createInboxQueue();
    const { adapter, injectedMessages } = createFakeEngineAdapter({
      turns: [[{ kind: "text_delta", delta: "response" }]],
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [createInboxProvider(inbox)],
    });

    // Push a steer item
    inbox.push(makeInboxItem({ id: "steer-1", mode: "steer", content: "Redirect to topic X" }));

    await collectEvents(runtime.run({ kind: "text", text: "go" }));

    // Steer item should have been injected into the adapter
    expect(injectedMessages.length).toBeGreaterThanOrEqual(1);
    const injected = injectedMessages[0];
    expect(injected).toBeDefined();
    expect(injected?.senderId).toBeDefined();
    expect(injected?.content[0]).toEqual({ kind: "text", text: "Redirect to topic X" });
  });

  test("per-mode capacity limits are respected", async () => {
    const inbox = createInboxQueue({
      policy: { collectCap: 2, followupCap: 2, steerCap: 1 },
    });

    // Push beyond collect capacity
    expect(inbox.push(makeInboxItem({ id: "c1", mode: "collect" }))).toBe(true);
    expect(inbox.push(makeInboxItem({ id: "c2", mode: "collect" }))).toBe(true);
    expect(inbox.push(makeInboxItem({ id: "c3", mode: "collect" }))).toBe(false);

    // Push beyond steer capacity
    expect(inbox.push(makeInboxItem({ id: "s1", mode: "steer" }))).toBe(true);
    expect(inbox.push(makeInboxItem({ id: "s2", mode: "steer" }))).toBe(false);

    // Total in queue: 2 collect + 1 steer = 3
    expect(inbox.depth()).toBe(3);
  });

  test("multi-turn inbox survival — items pushed between turns", async () => {
    const inbox = createInboxQueue();
    const { adapter, injectedMessages } = createFakeEngineAdapter({
      turns: [[{ kind: "text_delta", delta: "turn 1" }], [{ kind: "text_delta", delta: "turn 2" }]],
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [createInboxProvider(inbox)],
    });

    // Push a steer item that should be processed during the run
    inbox.push(makeInboxItem({ id: "mid-run", mode: "steer", content: "mid-run injection" }));

    await collectEvents(runtime.run({ kind: "text", text: "go" }));

    // The steer item should have been injected
    expect(
      injectedMessages.some(
        (m) =>
          m.content[0]?.kind === "text" &&
          (m.content[0] as { text: string }).text === "mid-run injection",
      ),
    ).toBe(true);
    expect(inbox.depth()).toBe(0);
  });

  test("empty inbox does not affect normal execution", async () => {
    const inbox = createInboxQueue();
    const { adapter } = createFakeEngineAdapter({
      turns: [[{ kind: "text_delta", delta: "response" }]],
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      providers: [createInboxProvider(inbox)],
    });

    // No items in inbox
    const events = await collectEvents(runtime.run({ kind: "text", text: "go" }));

    // Should complete normally
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("done");
    expect(inbox.depth()).toBe(0);
  });

  test("drain returns all items and empties the queue", () => {
    const inbox = createInboxQueue();

    inbox.push(makeInboxItem({ id: "a", mode: "collect" }));
    inbox.push(makeInboxItem({ id: "b", mode: "followup" }));
    inbox.push(makeInboxItem({ id: "c", mode: "steer" }));

    expect(inbox.depth()).toBe(3);

    const drained = inbox.drain();
    expect(drained).toHaveLength(3);
    expect(inbox.depth()).toBe(0);

    // Drain again should be empty
    const drainedAgain = inbox.drain();
    expect(drainedAgain).toHaveLength(0);
  });

  test("peek does not modify the queue", () => {
    const inbox = createInboxQueue();

    inbox.push(makeInboxItem({ id: "x", mode: "collect" }));

    const peeked = inbox.peek();
    expect(peeked).toHaveLength(1);
    expect(inbox.depth()).toBe(1);

    // Peek again — same result
    const peekedAgain = inbox.peek();
    expect(peekedAgain).toHaveLength(1);
  });
});
