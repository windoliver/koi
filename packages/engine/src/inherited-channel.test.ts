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
});
