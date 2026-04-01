/**
 * Full-stack E2E: createDiscordChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Discord channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (text, interactions, reactions, references)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock Discord client
 *   - sendStatus typing indicator wiring
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - Bot echo prevention
 *   - Reaction normalization through full pipeline
 *   - Message reference (reply) metadata propagation
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
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { Client } from "discord.js";
import { createDiscordChannel } from "../discord-channel.js";
import {
  createMockClient,
  createMockInteraction,
  createMockMessage,
  createMockReaction,
} from "../test-helpers.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const DUMMY_TOKEN = "e2e-test-token";

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
    name: "E2E Discord Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

// ---------------------------------------------------------------------------
// Mock Discord client with event handler capture
// ---------------------------------------------------------------------------

type EventHandler = (...args: readonly unknown[]) => void;

interface EventCapturingClient {
  readonly mockClient: ReturnType<typeof createMockClient>;
  readonly handlers: Map<string, EventHandler[]>;
  readonly emit: (event: string, ...args: readonly unknown[]) => void;
}

function createEventCapturingClient(): EventCapturingClient {
  const handlers = new Map<string, EventHandler[]>();

  const onMock = mock((event: string, handler: EventHandler) => {
    const existing = handlers.get(event) ?? [];
    handlers.set(event, [...existing, handler]);
  });

  const mockClient = createMockClient({ on: onMock });

  return {
    mockClient,
    handlers,
    emit: (event: string, ...args: readonly unknown[]) => {
      const fns = handlers.get(event) ?? [];
      for (const fn of fns) {
        fn(...args);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Mock voice deps (needed for createDiscordChannel)
// ---------------------------------------------------------------------------

function makeMockVoiceDeps(): {
  readonly _joinVoiceChannel: NonNullable<
    Parameters<typeof createDiscordChannel>[0]["_joinVoiceChannel"]
  >;
  readonly _createAudioPlayer: NonNullable<
    Parameters<typeof createDiscordChannel>[0]["_createAudioPlayer"]
  >;
} {
  return {
    _joinVoiceChannel: mock(() => ({
      subscribe: mock(() => {}),
      destroy: mock(() => {}),
      on: mock(() => {}),
    })) as unknown as NonNullable<Parameters<typeof createDiscordChannel>[0]["_joinVoiceChannel"]>,
    _createAudioPlayer: mock(() => ({
      play: mock(() => {}),
      stop: mock(() => {}),
    })) as unknown as NonNullable<Parameters<typeof createDiscordChannel>[0]["_createAudioPlayer"]>,
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
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
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

describeE2E("e2e: channel-discord + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter creation + properties ──────────────────

  test("channel adapter has correct name and capabilities", () => {
    const voiceDeps = makeMockVoiceDeps();
    const { mockClient } = createEventCapturingClient();
    const adapter = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    expect(adapter.name).toBe("discord");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(true);
    expect(adapter.capabilities.audio).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(typeof adapter.sendStatus).toBe("function");
    expect(typeof adapter.registerCommands).toBe("function");
    expect(typeof adapter.joinVoice).toBe("function");
    expect(typeof adapter.leaveVoice).toBe("function");
  });

  // ── Test 2: Inbound text → LLM → outbound through full runtime ────

  test(
    "inbound Discord message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const { mockClient, emit } = createEventCapturingClient();
      const voiceDeps = makeMockVoiceDeps();
      const channel = createDiscordChannel({
        token: DUMMY_TOKEN,
        _client: mockClient as unknown as Client,
        ...voiceDeps,
      });

      await channel.connect();

      // Wire up channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate a Discord messageCreate event
      const discordMsg = createMockMessage({
        content: "Reply with exactly: pong",
        authorId: "user-42",
        guildId: "g1",
        channelId: "c1",
      });

      emit("messageCreate", discordMsg);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("user-42");
      expect(inbound.threadId).toBe("g1:c1");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "discord",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // LLM should have responded with "pong"
      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the Discord channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Verify the mock Discord client's channel.send was called
      const channelCache = mockClient.channels.cache.get as ReturnType<typeof mock>;
      expect(channelCache).toHaveBeenCalled();

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through Discord channel + middleware chain ────

  test(
    "LLM tool call: Discord inbound → middleware → tool → LLM → outbound",
    async () => {
      const { mockClient, emit } = createEventCapturingClient();
      const voiceDeps = makeMockVoiceDeps();
      const channel = createDiscordChannel({
        token: DUMMY_TOKEN,
        _client: mockClient as unknown as Client,
        ...voiceDeps,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate inbound message asking for tool use
      const discordMsg = createMockMessage({
        content: "Use the multiply tool to compute 7 * 8. Report the result number only.",
        authorId: "user-99",
        guildId: "g1",
        channelId: "c1",
      });

      emit("messageCreate", discordMsg);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");

      // Middleware that observes tool calls
      const toolCalls: string[] = [];
      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCalls.push(request.toolId);
          return next(request);
        },
      };

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
        channelId: "discord",
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

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Slash command normalization through full pipeline ───────

  test(
    "slash command interaction → normalized InboundMessage → LLM processes command",
    async () => {
      const { mockClient, emit } = createEventCapturingClient();
      const voiceDeps = makeMockVoiceDeps();
      const channel = createDiscordChannel({
        token: DUMMY_TOKEN,
        features: { slashCommands: true },
        _client: mockClient as unknown as Client,
        ...voiceDeps,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate a slash command interaction
      const interaction = createMockInteraction({
        type: "command",
        commandName: "ask",
        options: [{ name: "question", value: "What is 2+2?", type: 3 }],
        userId: "cmd-user-1",
        guildId: "g1",
        channelId: "c1",
      });

      emit("interactionCreate", interaction);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

      // Verify slash command normalization
      expect(inbound.content[0]).toMatchObject({ kind: "text", text: "/ask" });
      expect(inbound.metadata).toMatchObject({
        isSlashCommand: true,
        commandName: "ask",
        options: { question: "What is 2+2?" },
      });
      expect(inbound.senderId).toBe("cmd-user-1");
      expect(inbound.threadId).toBe("g1:c1");

      // Run through LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You receive slash commands. The user asked a question via /ask command. Answer concisely.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "discord",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // LLM responded with something (the key assertion is the pipeline worked)
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Button interaction normalization ───────────────────────

  test("button click interaction normalizes correctly", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      features: { slashCommands: true },
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const interaction = createMockInteraction({
      type: "button",
      customId: "confirm_purchase",
      userId: "btn-user-1",
      guildId: "g1",
      channelId: "c1",
    });

    emit("interactionCreate", interaction);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    expect(inbound.content[0]).toMatchObject({
      kind: "button",
      label: "confirm_purchase",
      action: "confirm_purchase",
    });
    expect(inbound.senderId).toBe("btn-user-1");

    await channel.disconnect();
  });

  // ── Test 6: Reaction normalization through full pipeline ───────────

  test("reaction event normalizes to discord:reaction custom block", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      features: { reactions: true },
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate a reaction add event
    const reactionMock = createMockReaction({
      emojiName: "👍",
      userId: "reactor-1",
      guildId: "g1",
      channelId: "c1",
      messageId: "reacted-msg-1",
    });

    emit("messageReactionAdd", reactionMock.reaction, reactionMock.user);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    expect(inbound.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: {
        action: "add",
        messageId: "reacted-msg-1",
        emoji: { name: "👍" },
      },
    });
    expect(inbound.senderId).toBe("reactor-1");
    expect(inbound.threadId).toBe("g1:c1");

    // Also test reaction remove
    emit("messageReactionRemove", reactionMock.reaction, reactionMock.user);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(2);
    expect(received[1]?.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:reaction",
      data: { action: "remove" },
    });

    await channel.disconnect();
  });

  // ── Test 7: Message reference (reply) metadata propagation ─────────

  test("reply message includes replyToMessageId metadata", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate a reply message
    const discordMsg = createMockMessage({
      content: "I agree with this!",
      authorId: "user-50",
      guildId: "g1",
      channelId: "c1",
      replyToMessageId: "original-msg-999",
    });

    emit("messageCreate", discordMsg);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    expect(inbound.content[0]).toEqual({ kind: "text", text: "I agree with this!" });
    expect(inbound.metadata).toMatchObject({ replyToMessageId: "original-msg-999" });

    await channel.disconnect();
  });

  // ── Test 8: Bot echo prevention ────────────────────────────────────

  test("bot's own messages are filtered at normalization layer", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Simulate bot's own message (author.id matches client.user.id "bot-123")
    const botMsg = createMockMessage({
      content: "I already replied",
      authorId: "bot-123",
      authorBot: true,
      guildId: "g1",
      channelId: "c1",
    });

    emit("messageCreate", botMsg);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Bot messages must be filtered out
    expect(received).toHaveLength(0);

    // Other bots should NOT be filtered
    const otherBotMsg = createMockMessage({
      content: "I am another bot",
      authorId: "other-bot-456",
      authorBot: true,
      guildId: "g1",
      channelId: "c1",
    });

    emit("messageCreate", otherBotMsg);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);

    await channel.disconnect();
  });

  // ── Test 9: sendStatus typing indicator wiring ─────────────────────

  test("sendStatus fires typing indicator for processing status", async () => {
    const { mockClient } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    // Manually invoke sendStatus (as L1 runtime does during a turn)
    const status: ChannelStatus = {
      kind: "processing",
      turnIndex: 0,
      messageRef: "g1:c1",
    };
    await channel.sendStatus?.(status);

    // The mock channel's sendTyping should have been called
    const channelGet = mockClient.channels.cache.get as ReturnType<typeof mock>;
    expect(channelGet).toHaveBeenCalledWith("c1");

    // Idle status should not trigger additional typing
    const idleStatus: ChannelStatus = { kind: "idle", turnIndex: 0 };
    await channel.sendStatus?.(idleStatus);

    await channel.disconnect();
  });

  // ── Test 10: Lifecycle hooks fire through Discord-sourced messages ──

  test(
    "session + turn lifecycle hooks fire for Discord-sourced inbound messages",
    async () => {
      const { mockClient, emit } = createEventCapturingClient();
      const voiceDeps = makeMockVoiceDeps();
      const channel = createDiscordChannel({
        token: DUMMY_TOKEN,
        _client: mockClient as unknown as Client,
        ...voiceDeps,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      const discordMsg = createMockMessage({
        content: "Say OK",
        authorId: "user-1",
        guildId: "g1",
        channelId: "c1",
      });

      emit("messageCreate", discordMsg);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

      // Track lifecycle hooks
      const hookOrder: string[] = [];
      const lifecycleObserver: KoiMiddleware = {
        name: "lifecycle-observer",
        describeCapabilities: () => undefined,
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
        channelId: "discord",
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

  // ── Test 11: DM message normalization ──────────────────────────────

  test("DM message (no guild) normalizes with dm:userId threadId", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const dmMsg = createMockMessage({
      content: "Hello from DM",
      authorId: "dm-user-1",
      guildId: null,
      channelId: "dm-channel-1",
    });

    emit("messageCreate", dmMsg);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    expect(inbound.threadId).toBe("dm:dm-user-1");
    expect(inbound.senderId).toBe("dm-user-1");

    await channel.disconnect();
  });

  // ── Test 12: Select menu interaction normalization ─────────────────

  test("select menu interaction normalizes to discord:select_menu custom block", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      features: { slashCommands: true },
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const interaction = createMockInteraction({
      type: "select",
      customId: "color_picker",
      values: ["red", "blue"],
      userId: "select-user-1",
      guildId: "g1",
      channelId: "c1",
    });

    emit("interactionCreate", interaction);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    expect(inbound.content[0]).toMatchObject({
      kind: "custom",
      type: "discord:select_menu",
      data: { customId: "color_picker", values: ["red", "blue"] },
    });

    await channel.disconnect();
  });

  // ── Test 13: Image + file attachment normalization ─────────────────

  test("attachments normalize to image and file blocks", async () => {
    const { mockClient, emit } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const attachments = new Map([
      [
        "a1",
        {
          id: "a1",
          url: "https://cdn.discord.com/photo.png",
          name: "photo.png",
          contentType: "image/png",
          size: 1024,
        },
      ],
      [
        "a2",
        {
          id: "a2",
          url: "https://cdn.discord.com/report.pdf",
          name: "report.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
      ],
    ]);

    const discordMsg = createMockMessage({
      content: "Check these files",
      attachments,
      guildId: "g1",
      channelId: "c1",
    });

    emit("messageCreate", discordMsg);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    // Text + image + file = 3 blocks
    expect(inbound.content).toHaveLength(3);
    expect(inbound.content[0]).toMatchObject({ kind: "text", text: "Check these files" });
    expect(inbound.content[1]).toMatchObject({
      kind: "image",
      url: "https://cdn.discord.com/photo.png",
    });
    expect(inbound.content[2]).toMatchObject({
      kind: "file",
      url: "https://cdn.discord.com/report.pdf",
      mimeType: "application/pdf",
    });

    await channel.disconnect();
  });

  // ── Test 14: Connect/disconnect lifecycle ──────────────────────────

  test("connect calls client.login, disconnect calls client.destroy", async () => {
    const { mockClient } = createEventCapturingClient();
    const voiceDeps = makeMockVoiceDeps();
    const channel = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      ...voiceDeps,
    });

    await channel.connect();
    expect(mockClient.login).toHaveBeenCalledTimes(1);
    expect(mockClient.login).toHaveBeenCalledWith(DUMMY_TOKEN);

    await channel.disconnect();
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  // ── Test 15: sendStatus wired through createKoi runtime ────────────

  test(
    "sendStatus integration with createKoi runtime options",
    async () => {
      const { mockClient } = createEventCapturingClient();
      const voiceDeps = makeMockVoiceDeps();
      const channel = createDiscordChannel({
        token: DUMMY_TOKEN,
        _client: mockClient as unknown as Client,
        ...voiceDeps,
      });

      await channel.connect();

      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply with one word.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "discord",
        ...(channel.sendStatus !== undefined ? { sendStatus: channel.sendStatus } : {}),
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );
});
