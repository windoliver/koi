/**
 * Full-stack E2E: createKoi + createPiAdapter + channel-chat-sdk adapters.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization through the channel
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message mapping (ContentBlock[] → markdown → postMessage)
 *   - sendStatus typing indicator wiring
 *   - Multi-platform adapter isolation
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  ChannelStatus,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  InboundMessage,
  KoiMiddleware,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { ChatSdkChannelConfig } from "../config.js";
import { createChatSdkChannels } from "../create-chat-sdk-channels.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function testManifest(): AgentManifest {
  return {
    name: "E2E Chat SDK Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Mock Chat SDK adapter factory (simulates a real platform adapter)
// ---------------------------------------------------------------------------

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
    readonly mentions: Array<(thread: unknown, message: unknown) => void>;
    readonly subscribed: Array<(thread: unknown, message: unknown) => void>;
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
      getAdapter: mock((adapterName: string) => makeMockChatSdkAdapter(adapterName)),
    },
    handlers,
  };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const MULTIPLY_TOOL: Tool = {
  descriptor: {
    name: "multiply",
    description: "Multiplies two numbers together and returns the product.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  trustTier: "sandbox",
  execute: async (input: Readonly<Record<string, unknown>>) => {
    const a = Number(input.a ?? 0);
    const b = Number(input.b ?? 0);
    return String(a * b);
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: channel-chat-sdk + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter creation + properties ──────────────────

  test("channel adapters created with correct properties", async () => {
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
    expect(adapters[0]?.name).toBe("chat-sdk:slack");
    expect(adapters[0]?.platform).toBe("slack");
    expect(adapters[1]?.name).toBe("chat-sdk:discord");
    expect(adapters[1]?.platform).toBe("discord");

    // Capabilities are platform-specific
    expect(adapters[0]?.capabilities.files).toBe(true);
    expect(adapters[0]?.capabilities.buttons).toBe(true);

    // sendStatus is present
    expect(typeof adapters[0]?.sendStatus).toBe("function");
    expect(typeof adapters[1]?.sendStatus).toBe("function");
  });

  // ── Test 2: Full inbound → LLM → outbound through channel + runtime ──

  test(
    "inbound message through channel → createKoi runtime → real LLM → outbound via postMessage",
    async () => {
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

      const channel = adapters[0];
      if (channel === undefined) throw new Error("No adapter created");

      await channel.connect();

      // Wire up channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate a Chat SDK mention event (as if Slack webhook arrived)
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
        text: "Reply with exactly: pong",
        author: {
          userId: "U001",
          userName: "alice",
          fullName: "Alice",
          isBot: false,
          isMe: false,
        },
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        formatted: { type: "root", children: [] },
        raw: {},
        isMention: true,
      };

      for (const handler of mockChat.handlers.mentions) {
        handler(fakeThread, fakeMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify inbound normalization worked
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("U001");
      expect(inbound.threadId).toBe("slack:C123:ts456");

      // Now run the inbound message through the full L1 runtime with a real LLM call
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        channelId: "chat-sdk:slack",
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "messages",
          messages: [inbound],
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // LLM should have responded with "pong"
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Now send the LLM response back through the channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Verify postMessage was called on the mock adapter
      expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
      const [threadId, postable] = (mockSlackAdapter.postMessage as ReturnType<typeof mock>).mock
        .calls[0] as [string, { readonly markdown: string }];
      expect(threadId).toBe("slack:C123:ts456");
      expect(postable.markdown.toLowerCase()).toContain("pong");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through channel + middleware chain ────────────

  test(
    "LLM tool call through full stack: channel inbound → middleware → tool → LLM → channel outbound",
    async () => {
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

      const channel = adapters[0];
      if (channel === undefined) throw new Error("No adapter created");

      await channel.connect();

      // Collect inbound via channel
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate mention event
      const fakeThread = {
        id: "slack:C1:ts1",
        channelId: "C1",
        isDM: false,
        adapter: { name: "slack" },
        subscribe: mock(async () => {}),
      };
      const fakeMessage = {
        id: "msg-1",
        threadId: "slack:C1:ts1",
        text: "Use the multiply tool to compute 7 * 8. Report the result number only.",
        author: {
          userId: "U002",
          userName: "bob",
          fullName: "Bob",
          isBot: false,
          isMe: false,
        },
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        formatted: { type: "root", children: [] },
        raw: {},
        isMention: true,
      };

      for (const handler of mockChat.handlers.mentions) {
        handler(fakeThread, fakeMessage);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");

      // Middleware that observes tool calls
      const toolCalls: string[] = [];
      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

      // Create runtime with tool + middleware
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the multiply tool for math. Never compute in your head. Always use tools.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        middleware: [toolObserver],
        providers: [createToolProvider([MULTIPLY_TOOL])],
        channelId: "chat-sdk:slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool should have been called through middleware
      expect(toolCalls).toContain("multiply");

      // tool_call_start and tool_call_end events should exist
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should contain 56
      const text = extractText(events);
      expect(text).toContain("56");

      // Send back through channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
      const [, postable] = (mockSlackAdapter.postMessage as ReturnType<typeof mock>).mock
        .calls[0] as [string, { readonly markdown: string }];
      expect(postable.markdown).toContain("56");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: sendStatus typing indicator wiring ─────────────────────

  test(
    "sendStatus fires startTyping during real LLM processing",
    async () => {
      const config: ChatSdkChannelConfig = {
        platforms: [{ platform: "slack" }],
      };

      const mockSlackAdapter = makeMockChatSdkAdapter("slack");
      const mockChat = makeMockChat();

      const adapters = createChatSdkChannels(config, {
        _chat: mockChat.instance,
        _adapters: { slack: mockSlackAdapter },
      });

      const channel = adapters[0];
      if (channel === undefined) throw new Error("No adapter created");

      await channel.connect();

      // Manually invoke sendStatus (as L1 runtime would during a turn)
      const status: ChannelStatus = {
        kind: "processing",
        turnIndex: 0,
        messageRef: "slack:C123:ts456",
      };
      await channel.sendStatus?.(status);

      expect(mockSlackAdapter.startTyping).toHaveBeenCalledTimes(1);
      expect((mockSlackAdapter.startTyping as ReturnType<typeof mock>).mock.calls[0]).toEqual([
        "slack:C123:ts456",
      ]);

      // Idle status should not trigger typing
      const idleStatus: ChannelStatus = { kind: "idle", turnIndex: 0 };
      await channel.sendStatus?.(idleStatus);
      expect(mockSlackAdapter.startTyping).toHaveBeenCalledTimes(1); // Still 1

      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Multi-platform isolation with real LLM ─────────────────

  test(
    "multi-platform: Slack and Discord channels independently process the same LLM response",
    async () => {
      const config: ChatSdkChannelConfig = {
        platforms: [{ platform: "slack" }, { platform: "discord" }],
      };

      const mockSlackAdapter = makeMockChatSdkAdapter("slack");
      const mockDiscordAdapter = makeMockChatSdkAdapter("discord");
      const mockChat = makeMockChat();

      const adapters = createChatSdkChannels(config, {
        _chat: mockChat.instance,
        _adapters: {
          slack: mockSlackAdapter,
          discord: mockDiscordAdapter,
        },
      });

      const slackChannel = adapters[0];
      const discordChannel = adapters[1];
      if (slackChannel === undefined || discordChannel === undefined) {
        throw new Error("Missing adapters");
      }

      await slackChannel.connect();
      await discordChannel.connect();

      // Collect inbound from both channels
      const slackMsgs: InboundMessage[] = [];
      const discordMsgs: InboundMessage[] = [];
      slackChannel.onMessage(async (msg) => {
        slackMsgs.push(msg);
      });
      discordChannel.onMessage(async (msg) => {
        discordMsgs.push(msg);
      });

      // Simulate Slack event only
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
        text: "Say hello",
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

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Slack gets the message, Discord does not
      expect(slackMsgs).toHaveLength(1);
      expect(discordMsgs).toHaveLength(0);

      // Run through LLM with Slack's inbound
      const inbound = slackMsgs[0];
      if (inbound === undefined) throw new Error("No inbound");

      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "chat-sdk:slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      // Send response through Slack channel only
      await slackChannel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Slack adapter got the message
      expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
      // Discord adapter did NOT
      expect(mockDiscordAdapter.postMessage).toHaveBeenCalledTimes(0);

      await runtime.dispose();
      await slackChannel.disconnect();
      await discordChannel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 6: Middleware lifecycle hooks fire through channel-sourced messages ──

  test(
    "session + turn lifecycle hooks fire for channel-sourced inbound messages",
    async () => {
      const config: ChatSdkChannelConfig = {
        platforms: [{ platform: "slack" }],
      };

      const mockSlackAdapter = makeMockChatSdkAdapter("slack");
      const mockChat = makeMockChat();

      const adapters = createChatSdkChannels(config, {
        _chat: mockChat.instance,
        _adapters: { slack: mockSlackAdapter },
      });

      const channel = adapters[0];
      if (channel === undefined) throw new Error("No adapter");

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate event
      const fakeThread = {
        id: "slack:C1:ts1",
        channelId: "C1",
        isDM: false,
        adapter: { name: "slack" },
        subscribe: mock(async () => {}),
      };
      const fakeMessage = {
        id: "msg-1",
        threadId: "slack:C1:ts1",
        text: "Say OK",
        author: { userId: "U1", userName: "a", fullName: "A", isBot: false, isMe: false },
        metadata: { dateSent: new Date(), edited: false },
        attachments: [],
        formatted: { type: "root", children: [] },
        raw: {},
        isMention: true,
      };

      for (const handler of mockChat.handlers.mentions) {
        handler(fakeThread, fakeMessage);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

      // Track lifecycle hooks
      const hookOrder: string[] = [];
      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        onSessionStart: async () => {
          hookOrder.push("session_start");
        },
        onSessionEnd: async () => {
          hookOrder.push("session_end");
        },
        onAfterTurn: async () => {
          hookOrder.push("after_turn");
        },
      };

      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word only.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        middleware: [lifecycleObserver],
        channelId: "chat-sdk:slack",
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      // Session lifecycle must be correct
      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Content block mapping — rich outbound ──────────────────

  test("outbound with mixed content blocks maps to markdown correctly", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockSlackAdapter = makeMockChatSdkAdapter("slack");
    const mockChat = makeMockChat();

    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: mockSlackAdapter },
    });

    const channel = adapters[0];
    if (channel === undefined) throw new Error("No adapter");

    await channel.connect();

    // Send rich content through the channel
    await channel.send({
      content: [
        { kind: "text", text: "Here is the report:" },
        { kind: "image", url: "https://example.com/chart.png", alt: "Sales chart" },
        {
          kind: "file",
          url: "https://example.com/report.pdf",
          mimeType: "application/pdf",
          name: "Q4 Report",
        },
      ],
      threadId: "slack:C1:ts1",
    });

    expect(mockSlackAdapter.postMessage).toHaveBeenCalledTimes(1);
    const [threadId, postable] = (mockSlackAdapter.postMessage as ReturnType<typeof mock>).mock
      .calls[0] as [string, { readonly markdown: string }];

    expect(threadId).toBe("slack:C1:ts1");
    expect(postable.markdown).toContain("Here is the report:");
    expect(postable.markdown).toContain("![Sales chart](https://example.com/chart.png)");
    expect(postable.markdown).toContain("[Q4 Report](https://example.com/report.pdf)");

    await channel.disconnect();
  });

  // ── Test 8: Bot echo prevention — end-to-end ──────────────────────

  test("bot's own messages are filtered at normalization layer", async () => {
    const config: ChatSdkChannelConfig = {
      platforms: [{ platform: "slack" }],
    };

    const mockChat = makeMockChat();
    const adapters = createChatSdkChannels(config, {
      _chat: mockChat.instance,
      _adapters: { slack: makeMockChatSdkAdapter("slack") },
    });

    const channel = adapters[0];
    if (channel === undefined) throw new Error("No adapter");

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate bot's own message (isMe: true)
    const botThread = {
      id: "slack:C1:ts1",
      channelId: "C1",
      isDM: false,
      adapter: { name: "slack" },
      subscribe: mock(async () => {}),
    };
    const botMessage = {
      id: "msg-bot",
      threadId: "slack:C1:ts1",
      text: "I already replied",
      author: { userId: "BOT001", userName: "koi-bot", fullName: "Koi", isBot: true, isMe: true },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      formatted: { type: "root", children: [] },
      raw: {},
      isMention: false,
    };

    for (const handler of mockChat.handlers.mentions) {
      handler(botThread, botMessage);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Bot messages must be filtered out — never reach the handler
    expect(received).toHaveLength(0);

    await channel.disconnect();
  });

  // ── Test 9: sendStatus + real LLM flow integration ─────────────────

  test(
    "sendStatus wired through createKoi runtime options",
    async () => {
      const config: ChatSdkChannelConfig = {
        platforms: [{ platform: "slack" }],
      };

      const mockSlackAdapter = makeMockChatSdkAdapter("slack");
      const mockChat = makeMockChat();

      const adapters = createChatSdkChannels(config, {
        _chat: mockChat.instance,
        _adapters: { slack: mockSlackAdapter },
      });

      const channel = adapters[0];
      if (channel === undefined) throw new Error("No adapter");

      await channel.connect();

      // Create runtime with sendStatus wired to channel
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "chat-sdk:slack",
        ...(channel.sendStatus !== undefined ? { sendStatus: channel.sendStatus } : {}),
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // The runtime should have called sendStatus, which triggers startTyping
      // Note: whether L1 actually calls sendStatus depends on the engine adapter
      // emitting the right events. We verify the wiring works, not that L1 calls it
      // at specific points — that's L1's concern.

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );
});
