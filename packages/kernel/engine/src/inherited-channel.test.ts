/**
 * Tests for inherited channel proxy — attribution, lifecycle, and policy modes.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelStatus,
  MessageHandler,
  OutboundMessage,
  ProcessId,
  SpawnChannelPolicy,
} from "@koi/core";
import { agentId } from "@koi/core";
import { createInheritedChannel } from "./inherited-channel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: false,
  files: false,
  buttons: false,
  audio: false,
  video: false,
  threads: false,
  supportsA2ui: false,
};

function createMockParentChannel(overrides?: Partial<ChannelAdapter>): ChannelAdapter {
  return {
    name: "test-parent",
    capabilities: CAPABILITIES,
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onMessage: mock((_handler: MessageHandler) => () => {}),
    sendStatus: mock(() => Promise.resolve()),
    ...overrides,
  };
}

const CHILD_PID: ProcessId = {
  id: agentId("child-1"),
  name: "child-agent",
  type: "worker",
  depth: 1,
  parent: agentId("parent-1"),
};

function textMessage(text: string): OutboundMessage {
  return { content: [{ kind: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createInheritedChannel", () => {
  test("send with default policy adds attribution metadata", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID);

    await proxy.send(textMessage("hello"));

    expect(parent.send).toHaveBeenCalledTimes(1);
    const sentMessage = (parent.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect(sentMessage.metadata?.sender).toBe(CHILD_PID.id);
    expect(sentMessage.metadata?.senderName).toBe("child-agent");
  });

  test("connect is a no-op", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID);

    await proxy.connect();
    expect(parent.connect).not.toHaveBeenCalled();
  });

  test("disconnect is a no-op, does NOT disconnect parent", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID);

    await proxy.disconnect();
    expect(parent.disconnect).not.toHaveBeenCalled();
  });

  test("sendStatus with propagateStatus=false is a no-op", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID, {
      mode: "output-only",
      propagateStatus: false,
    });

    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    await proxy.sendStatus?.(status);

    expect(parent.sendStatus).not.toHaveBeenCalled();
  });

  test("sendStatus with propagateStatus=true delegates to parent", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID, {
      mode: "output-only",
      propagateStatus: true,
    });

    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    await proxy.sendStatus?.(status);

    expect(parent.sendStatus).toHaveBeenCalledTimes(1);
  });

  test("onMessage in output-only mode returns no-op unsubscribe", () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID, { mode: "output-only" });

    const handler = mock(() => Promise.resolve());
    const unsub = proxy.onMessage(handler);

    expect(parent.onMessage).not.toHaveBeenCalled();
    expect(typeof unsub).toBe("function");
  });

  test("onMessage in all mode delegates to parent", () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID, { mode: "all" });

    const handler = mock(() => Promise.resolve());
    proxy.onMessage(handler);

    expect(parent.onMessage).toHaveBeenCalledTimes(1);
  });

  test("none mode — send is a no-op", async () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID, { mode: "none" });

    await proxy.send(textMessage("hello"));
    expect(parent.send).not.toHaveBeenCalled();
  });

  test("prefix attribution prepends child name to text blocks", async () => {
    const parent = createMockParentChannel();
    const policy: SpawnChannelPolicy = {
      mode: "output-only",
      attribution: "prefix",
    };
    const proxy = createInheritedChannel(parent, CHILD_PID, policy);

    await proxy.send(textMessage("hello"));

    const sentMessage = (parent.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    const textBlock = sentMessage.content[0];
    expect(textBlock).toBeDefined();
    if (textBlock !== undefined && textBlock.kind === "text") {
      expect(textBlock.text).toBe("[child-agent] hello");
    }
  });

  test("none attribution passes message through unchanged", async () => {
    const parent = createMockParentChannel();
    const policy: SpawnChannelPolicy = {
      mode: "output-only",
      attribution: "none",
    };
    const proxy = createInheritedChannel(parent, CHILD_PID, policy);

    const msg = textMessage("hello");
    await proxy.send(msg);

    const sentMessage = (parent.send as ReturnType<typeof mock>).mock
      .calls[0]?.[0] as OutboundMessage;
    expect(sentMessage).toEqual(msg);
  });

  test("proxy name includes child name", () => {
    const parent = createMockParentChannel();
    const proxy = createInheritedChannel(parent, CHILD_PID);
    expect(proxy.name).toBe("inherited:child-agent");
  });

  test("multiple children share same parent — messages interleaved correctly", async () => {
    const parent = createMockParentChannel();
    const child1Pid: ProcessId = { ...CHILD_PID, id: agentId("child-1"), name: "child-1" };
    const child2Pid: ProcessId = { ...CHILD_PID, id: agentId("child-2"), name: "child-2" };

    const proxy1 = createInheritedChannel(parent, child1Pid);
    const proxy2 = createInheritedChannel(parent, child2Pid);

    await proxy1.send(textMessage("from child 1"));
    await proxy2.send(textMessage("from child 2"));

    expect(parent.send).toHaveBeenCalledTimes(2);
    const msg1 = (parent.send as ReturnType<typeof mock>).mock.calls[0]?.[0] as OutboundMessage;
    const msg2 = (parent.send as ReturnType<typeof mock>).mock.calls[1]?.[0] as OutboundMessage;
    expect(msg1.metadata?.senderName).toBe("child-1");
    expect(msg2.metadata?.senderName).toBe("child-2");
  });

  test("sendStatus when parent has no sendStatus is a no-op", async () => {
    const { sendStatus: _, ...parentWithoutSendStatus } = createMockParentChannel();
    const parent: ChannelAdapter = parentWithoutSendStatus;
    const proxy = createInheritedChannel(parent, CHILD_PID, {
      mode: "output-only",
      propagateStatus: true,
    });

    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    // Should not throw
    await proxy.sendStatus?.(status);
  });

  test("forwards parent's sendUnsolicited extension method with attribution (round-40 medium)", async () => {
    // Round-40 medium: prior version returned a plain ChannelAdapter that
    // forwarded only send/onMessage/sendStatus, silently stripping
    // adapter-specific extensions like MobileChannelAdapter.sendUnsolicited
    // — child agents spawned onto a mobile parent lost every proactive
    // live-delivery path. The proxy now forwards documented outbound
    // extensions and applies the same attribution as send().
    const captured: OutboundMessage[] = [];
    const parent: ChannelAdapter & {
      sendUnsolicited: (m: OutboundMessage) => Promise<void>;
    } = {
      name: "mobile-parent",
      capabilities: CAPABILITIES,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      send: () => Promise.resolve(),
      onMessage: () => () => {},
      sendUnsolicited: (m: OutboundMessage) => {
        captured.push(m);
        return Promise.resolve();
      },
    };
    const childPid: ProcessId = {
      id: agentId("child-id"),
      name: "child",
      type: "worker",
      depth: 1,
      parent: agentId("parent-1"),
    };
    const proxy = createInheritedChannel(parent, childPid) as ChannelAdapter & {
      sendUnsolicited?: (m: OutboundMessage) => Promise<void>;
    };
    expect(typeof proxy.sendUnsolicited).toBe("function");
    await proxy.sendUnsolicited?.({ content: [{ kind: "text", text: "welcome" }] });
    expect(captured).toHaveLength(1);
    // Default attribution mode is "metadata" — child sender stamped.
    expect(captured[0]?.metadata?.["sender"]).toBe(childPid.id);
    expect(captured[0]?.metadata?.["senderName"]).toBe("child");
  });

  test("forwards sendUnsolicited's optional opts (e.g. {recipient}) to parent (round-42 high)", async () => {
    // Round-42 high: prior proxy forwarded sendUnsolicited as
    // (message) => Promise<void>, silently dropping the {recipient} opt
    // mobile adapters use to safely route offline / mismatched-live sends.
    const seenOpts: Array<unknown> = [];
    const parent: ChannelAdapter & {
      sendUnsolicited: (m: OutboundMessage, opts?: unknown) => Promise<void>;
    } = {
      name: "mobile-parent",
      capabilities: CAPABILITIES,
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      send: () => Promise.resolve(),
      onMessage: () => () => {},
      sendUnsolicited: (_m: OutboundMessage, opts?: unknown) => {
        seenOpts.push(opts);
        return Promise.resolve();
      },
    };
    const childPid: ProcessId = {
      id: agentId("child-id"),
      name: "child",
      type: "worker",
      depth: 1,
      parent: agentId("parent-1"),
    };
    const proxy = createInheritedChannel(parent, childPid) as ChannelAdapter & {
      sendUnsolicited?: (m: OutboundMessage, opts?: unknown) => Promise<void>;
    };
    await proxy.sendUnsolicited?.(
      { content: [{ kind: "text", text: "welcome" }] },
      { recipient: "device-alice" },
    );
    expect(seenOpts).toEqual([{ recipient: "device-alice" }]);
  });

  test("does not synthesize sendUnsolicited when parent does not provide it (round-40 medium)", async () => {
    // Only forward extensions the parent actually provides — never invent
    // a method that would silently no-op.
    const parent = createMockParentChannel();
    const childPid: ProcessId = {
      id: agentId("child-id"),
      name: "child",
      type: "worker",
      depth: 1,
      parent: agentId("parent-1"),
    };
    const proxy = createInheritedChannel(parent, childPid) as ChannelAdapter & {
      sendUnsolicited?: unknown;
    };
    expect(proxy.sendUnsolicited).toBeUndefined();
  });
});
