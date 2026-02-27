/**
 * Integration tests for @koi/channel-chat-sdk.
 *
 * Tests the full webhook → normalize → onMessage → send → postMessage flow
 * using mock Chat SDK adapters (no real platform connections).
 */

import { describe, expect, mock, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import type { ChatSdkChannelConfig } from "../config.js";
import { createChatSdkChannels } from "../create-chat-sdk-channels.js";

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

function makeMockChat(): {
  readonly instance: Record<string, unknown>;
  readonly handlers: {
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

function makeFakeEvent(
  platform: string,
  text: string,
  overrides?: { readonly isMe?: boolean; readonly isMention?: boolean },
): { readonly thread: Record<string, unknown>; readonly message: Record<string, unknown> } {
  return {
    thread: {
      id: `${platform}:C123:ts456`,
      channelId: "C123",
      isDM: false,
      adapter: { name: platform },
      subscribe: mock(async () => {}),
    },
    message: {
      id: "msg-1",
      threadId: `${platform}:C123:ts456`,
      text,
      author: {
        userId: "U001",
        userName: "alice",
        fullName: "Alice",
        isBot: false,
        isMe: overrides?.isMe ?? false,
      },
      metadata: { dateSent: new Date("2024-01-15T12:00:00Z"), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: overrides?.isMention ?? true,
    },
  };
}

describe("integration — full webhook→normalize→send flow", () => {
  test("Slack: mention → normalize → handler → send → postMessage", async () => {
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

    const adapter = adapters[0];
    if (adapter === undefined) throw new Error("No adapter");

    await adapter.connect();

    // Wire handler that echoes back
    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
      await adapter.send({
        content: [
          {
            kind: "text",
            text: `Echo: ${msg.content[0]?.kind === "text" ? msg.content[0].text : ""}`,
          },
        ],
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
      });
    });

    // Simulate mention event
    const event = makeFakeEvent("slack", "hello bot");
    for (const handler of mockChat.handlers.mentions) {
      handler(event.thread, event.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify inbound was received
    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "hello bot" });

    // Verify outbound was sent via Chat SDK
    expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
    const [threadId, postable] = (mockSlackAdapter.postMessage as ReturnType<typeof mock>).mock
      .calls[0] as [string, { markdown: string }];
    expect(threadId).toBe("slack:C123:ts456");
    expect(postable.markdown).toBe("Echo: hello bot");
  });

  test("Discord: subscribed message flow", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "discord" }],
    };

    const mockDiscordAdapter = makeMockChatSdkAdapter("discord");
    const mockChat = makeMockChat();
    mockChat.instance.getAdapter = mock(() => mockDiscordAdapter);

    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { discord: mockDiscordAdapter },
    });

    await adapters[0]?.connect();

    const received: InboundMessage[] = [];
    adapters[0]?.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate subscribed message (not a mention)
    const event = makeFakeEvent("discord", "follow up message", { isMention: false });
    for (const handler of mockChat.handlers.subscribed) {
      handler(event.thread, event.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "follow up message" });
  });

  test("multi-platform: routes to correct adapter only", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }, { platform: "discord" }, { platform: "github" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: {
        slack: makeMockChatSdkAdapter("slack"),
        discord: makeMockChatSdkAdapter("discord"),
        github: makeMockChatSdkAdapter("github"),
      },
    });

    for (const adapter of adapters) {
      await adapter.connect();
    }

    const slackMsgs: InboundMessage[] = [];
    const discordMsgs: InboundMessage[] = [];
    const githubMsgs: InboundMessage[] = [];

    adapters[0]?.onMessage(async (msg) => {
      slackMsgs.push(msg);
    });
    adapters[1]?.onMessage(async (msg) => {
      discordMsgs.push(msg);
    });
    adapters[2]?.onMessage(async (msg) => {
      githubMsgs.push(msg);
    });

    // Send event for each platform
    const slackEvent = makeFakeEvent("slack", "slack msg");
    const discordEvent = makeFakeEvent("discord", "discord msg");
    const githubEvent = makeFakeEvent("github", "github msg");

    for (const handler of mockChat.handlers.mentions) {
      handler(slackEvent.thread, slackEvent.message);
      handler(discordEvent.thread, discordEvent.message);
      handler(githubEvent.thread, githubEvent.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(slackMsgs).toHaveLength(1);
    expect(slackMsgs[0]?.content[0]).toEqual({ kind: "text", text: "slack msg" });

    expect(discordMsgs).toHaveLength(1);
    expect(discordMsgs[0]?.content[0]).toEqual({ kind: "text", text: "discord msg" });

    expect(githubMsgs).toHaveLength(1);
    expect(githubMsgs[0]?.content[0]).toEqual({ kind: "text", text: "github msg" });
  });

  test("error isolation: one platform error does not affect others", async () => {
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

    for (const adapter of adapters) {
      await adapter.connect();
    }

    // Slack handler throws
    adapters[0]?.onMessage(async () => {
      throw new Error("Slack handler crashed");
    });

    const discordMsgs: InboundMessage[] = [];
    adapters[1]?.onMessage(async (msg) => {
      discordMsgs.push(msg);
    });

    // Send events to both platforms
    const slackEvent = makeFakeEvent("slack", "slack msg");
    const discordEvent = makeFakeEvent("discord", "discord msg");

    for (const handler of mockChat.handlers.mentions) {
      handler(slackEvent.thread, slackEvent.message);
      handler(discordEvent.thread, discordEvent.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Discord should still receive its message despite Slack handler error
    expect(discordMsgs).toHaveLength(1);
    expect(discordMsgs[0]?.content[0]).toEqual({ kind: "text", text: "discord msg" });
  });

  test("bot's own messages are filtered out", async () => {
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

    // Simulate bot's own message
    const event = makeFakeEvent("slack", "bot reply", { isMe: true });
    for (const handler of mockChat.handlers.mentions) {
      handler(event.thread, event.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(0);
  });
});
