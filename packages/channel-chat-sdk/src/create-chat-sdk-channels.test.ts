import { describe, expect, mock, test } from "bun:test";
import type { ChannelStatus, InboundMessage } from "@koi/core";
import type { ChatSdkChannelConfig } from "./config.js";
import { createChatSdkChannels } from "./create-chat-sdk-channels.js";

/**
 * Creates a mock Chat SDK adapter with spied methods.
 * The factory accepts these via _adapters for testing.
 */
function makeMockChatSdkAdapter(name: string): Record<string, unknown> {
  return {
    name,
    userName: "test-bot",
    botUserId: "BOT001",
    initialize: mock(async () => {}),
    handleWebhook: mock(async () => new Response("ok")),
    postMessage: mock(async (_threadId: string, _msg: unknown) => ({
      id: "sent-1",
      raw: {},
      threadId: `${name}:C1:T1`,
    })),
    editMessage: mock(async () => ({ id: "sent-1", raw: {}, threadId: `${name}:C1:T1` })),
    deleteMessage: mock(async () => {}),
    fetchMessages: mock(async () => ({ messages: [] })),
    fetchThread: mock(async () => ({ id: `${name}:C1:T1`, channelId: "C1", metadata: {} })),
    parseMessage: mock((raw: unknown) => raw),
    startTyping: mock(async () => {}),
    addReaction: mock(async () => {}),
    removeReaction: mock(async () => {}),
    encodeThreadId: mock((data: unknown) => String(data)),
    decodeThreadId: mock((id: string) => id),
    renderFormatted: mock(() => ""),
    channelIdFromThreadId: mock((id: string) => id.split(":")[1] ?? id),
    stream: mock(async () => ({ id: "sent-1", raw: {}, threadId: `${name}:C1:T1` })),
  };
}

/**
 * Creates a mock Chat instance that records handler registrations.
 */
function makeMockChat(): {
  readonly instance: Record<string, unknown>;
  readonly handlers: {
    // let justification: accumulates registered handlers during test setup
    mentions: Array<(thread: unknown, message: unknown) => void>;
    subscribed: Array<(thread: unknown, message: unknown) => void>;
  };
} {
  const handlers = {
    mentions: [] as Array<(thread: unknown, message: unknown) => void>,
    subscribed: [] as Array<(thread: unknown, message: unknown) => void>,
  };

  return {
    instance: {
      initialize: mock(async () => {}),
      shutdown: mock(async () => {}),
      onNewMention: mock((handler: (thread: unknown, message: unknown) => void) => {
        handlers.mentions.push(handler);
      }),
      onSubscribedMessage: mock((handler: (thread: unknown, message: unknown) => void) => {
        handlers.subscribed.push(handler);
      }),
      webhooks: {},
      getAdapter: mock((name: string) => makeMockChatSdkAdapter(name)),
    },
    handlers,
  };
}

describe("createChatSdkChannels", () => {
  test("returns one adapter per configured platform", () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }, { platform: "discord" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: {
        slack: makeMockChatSdkAdapter("slack"),
        discord: makeMockChatSdkAdapter("discord"),
      },
    });

    expect(adapters).toHaveLength(2);
  });

  test("each adapter has correct name with chat-sdk prefix", () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }, { platform: "github" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: {
        slack: makeMockChatSdkAdapter("slack"),
        github: makeMockChatSdkAdapter("github"),
      },
    });

    const names = adapters.map((a) => a.name);
    expect(names).toContain("chat-sdk:slack");
    expect(names).toContain("chat-sdk:github");
  });

  test("each adapter has correct capabilities per platform", () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }, { platform: "github" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: {
        slack: makeMockChatSdkAdapter("slack"),
        github: makeMockChatSdkAdapter("github"),
      },
    });

    const slack = adapters.find((a) => a.name === "chat-sdk:slack");
    expect(slack?.capabilities.files).toBe(true);
    expect(slack?.capabilities.buttons).toBe(true);

    const github = adapters.find((a) => a.name === "chat-sdk:github");
    expect(github?.capabilities.files).toBe(false);
    expect(github?.capabilities.buttons).toBe(false);
  });

  test("each adapter exposes platform property", () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "linear" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { linear: makeMockChatSdkAdapter("linear") },
    });

    expect(adapters[0]?.platform).toBe("linear");
  });

  test("connect() initializes the Chat instance", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();
    expect(mockChat.instance.initialize).toHaveBeenCalledTimes(1);
  });

  test("disconnect() shuts down the Chat instance", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();
    await adapters[0]?.disconnect();
    expect(mockChat.instance.shutdown).toHaveBeenCalledTimes(1);
  });

  test("handleWebhook delegates to Chat SDK webhook handler", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();
    mockChat.instance.webhooks = {
      slack: mock(async () => new Response("ack")),
    };

    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    await adapters[0]?.connect();
    const req = new Request("https://example.com/webhook", { method: "POST" });
    const resp = await adapters[0]?.handleWebhook(req);

    expect(resp?.status).toBe(200);
  });

  test("onMessage receives normalized messages", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();

    const received: InboundMessage[] = [];
    adapters[0]?.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate a Chat SDK event via the registered mention handler
    const fakeThread = {
      id: "slack:C123:ts456",
      channelId: "C123",
      isDM: false,
      adapter: { name: "slack" },
      subscribe: mock(async () => {}),
    };
    const fakeMessage = {
      id: "msg-1",
      threadId: "slack:C123:ts456",
      text: "hello bot",
      author: {
        userId: "U001",
        userName: "alice",
        fullName: "Alice",
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date("2024-01-15T12:00:00Z"), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: true,
    };

    // Trigger the mention handler
    for (const handler of mockChat.handlers.mentions) {
      handler(fakeThread, fakeMessage);
    }

    // Wait for async dispatch
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "hello bot" });
    expect(received[0]?.senderId).toBe("U001");
  });

  test("auto-subscribes threads on new mention", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();
    adapters[0]?.onMessage(async () => {});

    const subscribeMock = mock(async () => {});
    const fakeThread = {
      id: "slack:C123:ts456",
      channelId: "C123",
      isDM: false,
      adapter: { name: "slack" },
      subscribe: subscribeMock,
    };
    const fakeMessage = {
      id: "msg-1",
      threadId: "slack:C123:ts456",
      text: "hey",
      author: { userId: "U001", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: true,
    };

    for (const handler of mockChat.handlers.mentions) {
      handler(fakeThread, fakeMessage);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscribeMock).toHaveBeenCalledTimes(1);
  });

  test("send() maps content and calls Chat SDK adapter postMessage", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();
    mockChat.instance.getAdapter = mock(() => mockSlackAdapter);

    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    await adapters[0]?.connect();
    await adapters[0]?.send({
      content: [{ kind: "text", text: "hello from koi" }],
      threadId: "slack:C123:ts456",
    });

    expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = (mockSlackAdapter.postMessage as ReturnType<typeof mock>).mock
      .calls[0] as [string, { markdown: string }];
    expect(threadId).toBe("slack:C123:ts456");
    expect(message.markdown).toBe("hello from koi");
  });

  test("routes events to correct platform adapter only", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }, { platform: "discord" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: {
        slack: makeMockChatSdkAdapter("slack"),
        discord: makeMockChatSdkAdapter("discord"),
      },
    });

    await adapters[0]?.connect();
    await adapters[1]?.connect();

    const slackMessages: InboundMessage[] = [];
    const discordMessages: InboundMessage[] = [];
    adapters[0]?.onMessage(async (msg) => {
      slackMessages.push(msg);
    });
    adapters[1]?.onMessage(async (msg) => {
      discordMessages.push(msg);
    });

    // Send Slack event
    const slackThread = {
      id: "slack:C1:ts1",
      channelId: "C1",
      isDM: false,
      adapter: { name: "slack" },
      subscribe: mock(async () => {}),
    };
    const slackMsg = {
      id: "msg-1",
      threadId: "slack:C1:ts1",
      text: "slack msg",
      author: { userId: "U1", userName: "a", fullName: "A", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: true,
    };

    for (const handler of mockChat.handlers.mentions) {
      handler(slackThread, slackMsg);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(slackMessages).toHaveLength(1);
    expect(discordMessages).toHaveLength(0);
  });

  test("event from unconfigured adapter is silently ignored", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();

    const received: InboundMessage[] = [];
    adapters[0]?.onMessage(async (msg) => {
      received.push(msg);
    });

    // Send event from a platform that wasn't configured
    const unknownThread = {
      id: "teams:C1:T1",
      channelId: "C1",
      isDM: false,
      adapter: { name: "teams" },
      subscribe: mock(async () => {}),
    };
    const unknownMsg = {
      id: "msg-1",
      threadId: "teams:C1:T1",
      text: "teams msg",
      author: { userId: "U1", userName: "a", fullName: "A", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: true,
    };

    for (const handler of mockChat.handlers.mentions) {
      handler(unknownThread, unknownMsg);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Slack adapter should not receive the teams event
    expect(received).toHaveLength(0);
  });

  test("handleWebhook returns 404 when no handler for platform", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    // webhooks map doesn't include "slack"
    mockChat.instance.webhooks = {};

    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();
    const req = new Request("https://example.com/webhook", { method: "POST" });
    const resp = await adapters[0]?.handleWebhook(req);

    expect(resp?.status).toBe(404);
  });

  test("send throws when threadId is missing", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    await adapters[0]?.connect();

    await expect(adapters[0]?.send({ content: [{ kind: "text", text: "hello" }] })).rejects.toThrow(
      "threadId",
    );
  });

  test("sendStatus is present on adapters", () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    expect(typeof adapters[0]?.sendStatus).toBe("function");
  });

  test("sendStatus 'processing' calls startTyping on adapter", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    await adapters[0]?.connect();

    const status: ChannelStatus = { kind: "processing", turnIndex: 0, messageRef: "slack:C1:ts1" };
    await adapters[0]?.sendStatus?.(status);

    expect(mockSlackAdapter.startTyping).toHaveBeenCalledTimes(1);
    expect((mockSlackAdapter.startTyping as ReturnType<typeof mock>).mock.calls[0]).toEqual([
      "slack:C1:ts1",
    ]);
  });

  test("sendStatus 'idle' does not call startTyping", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    await adapters[0]?.connect();

    const status: ChannelStatus = { kind: "idle", turnIndex: 0 };
    await adapters[0]?.sendStatus?.(status);

    expect(mockSlackAdapter.startTyping).toHaveBeenCalledTimes(0);
  });

  test("sendStatus without messageRef is silently ignored", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    await adapters[0]?.connect();

    const status: ChannelStatus = { kind: "processing", turnIndex: 0 };
    await adapters[0]?.sendStatus?.(status);

    expect(mockSlackAdapter.startTyping).toHaveBeenCalledTimes(0);
  });
});
