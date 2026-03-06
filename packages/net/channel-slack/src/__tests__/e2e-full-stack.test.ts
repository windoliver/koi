/**
 * Full-stack E2E: createSlackChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Slack channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (text, slash commands, reactions, mentions)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock Slack WebClient
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - Bot echo prevention
 *   - Threading (channel:thread_ts format)
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
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
import { createSlackChannel } from "../slack-channel.js";
import { createMockSocketClient, createMockWebClient } from "../test-helpers.js";

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
    name: "E2E Slack Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
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

describeE2E("e2e: channel-slack + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", () => {
    const adapter = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: createMockWebClient(),
      _socketClient: createMockSocketClient(),
    });

    expect(adapter.name).toBe("slack");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.capabilities.audio).toBe(false);
  });

  // ── Test 2: Inbound text → LLM → outbound through full runtime ────

  test(
    "inbound Slack message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const webClient = createMockWebClient();
      const socketClient = createMockSocketClient();
      const channel = createSlackChannel({
        botToken: "xoxb-test",
        deployment: { mode: "socket", appToken: "xapp-test" },
        _webClient: webClient,
        _socketClient: socketClient,
      });

      await channel.connect();

      // Wire up channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate a Slack message event
      socketClient._emit("message", {
        event: {
          type: "message",
          text: "Reply with exactly: pong",
          user: "U42",
          channel: "C100",
          ts: "1234567890.000001",
        },
        ack: mock(() => {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("U42");
      expect(inbound.threadId).toBe("C100");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the Slack channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Verify the mock Slack WebClient's postMessage was called
      expect(webClient.chat.postMessage).toHaveBeenCalled();

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through Slack channel + middleware chain ──────

  test(
    "LLM tool call: Slack inbound → middleware → tool → LLM → outbound",
    async () => {
      const webClient = createMockWebClient();
      const socketClient = createMockSocketClient();
      const channel = createSlackChannel({
        botToken: "xoxb-test",
        deployment: { mode: "socket", appToken: "xapp-test" },
        _webClient: webClient,
        _socketClient: socketClient,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      socketClient._emit("message", {
        event: {
          type: "message",
          text: "Use the multiply tool to compute 7 * 8. Report the result number only.",
          user: "U99",
          channel: "C200",
          ts: "1234567890.000001",
        },
        ack: mock(() => {}),
      });
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
        channelId: "slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Tool should have been called through middleware
      expect(toolCalls).toContain("multiply");

      // tool_call events should exist
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

  // ── Test 4: Slash command through full pipeline ────────────────────

  test(
    "slash command → normalized InboundMessage → LLM processes command",
    async () => {
      const webClient = createMockWebClient();
      const socketClient = createMockSocketClient();
      const channel = createSlackChannel({
        botToken: "xoxb-test",
        deployment: { mode: "socket", appToken: "xapp-test" },
        _webClient: webClient,
        _socketClient: socketClient,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      socketClient._emit("slash_commands", {
        command: "/ask",
        text: "What is 2+2?",
        user_id: "U42",
        channel_id: "C100",
        trigger_id: "T789",
        response_url: "https://hooks.slack.com/response/xxx",
        ack: mock(() => {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

      // Verify slash command normalization
      expect(inbound.metadata?.isSlashCommand).toBe(true);
      expect(inbound.metadata?.commandName).toBe("/ask");
      expect(inbound.senderId).toBe("U42");

      // Run through LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You receive slash commands. Answer the user's question concisely.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Threaded message threadId format ──────────────────────

  test("threaded message includes channel:thread_ts threadId", async () => {
    const socketClient = createMockSocketClient();
    const channel = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: createMockWebClient(),
      _socketClient: socketClient,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    socketClient._emit("message", {
      event: {
        type: "message",
        text: "reply in thread",
        user: "U42",
        channel: "C100",
        ts: "1234567890.000002",
        thread_ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    expect(received[0]?.threadId).toBe("C100:1234567890.000001");

    await channel.disconnect();
  });

  // ── Test 6: Bot echo prevention ────────────────────────────────────

  test("bot's own messages are filtered at normalization", async () => {
    const webClient = createMockWebClient();
    webClient.chat.postMessage.mockImplementation(async (args: Record<string, unknown>) => {
      if (args._authTest === true) {
        return { user_id: "B001" };
      }
      return { ok: true };
    });
    const socketClient = createMockSocketClient();

    const channel = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: webClient,
      _socketClient: socketClient,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Bot's own message
    socketClient._emit("message", {
      event: {
        type: "message",
        text: "bot echo",
        user: "B001",
        channel: "C100",
        ts: "1234567890.000001",
      },
      ack: mock(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(0);

    // Other user's message should pass through
    socketClient._emit("message", {
      event: {
        type: "message",
        text: "human message",
        user: "U999",
        channel: "C100",
        ts: "1234567890.000002",
      },
      ack: mock(() => {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);

    await channel.disconnect();
  });

  // ── Test 7: Session + turn lifecycle hooks fire ─────────────────────

  test(
    "session and turn lifecycle hooks fire for Slack-sourced messages",
    async () => {
      const socketClient = createMockSocketClient();
      const channel = createSlackChannel({
        botToken: "xoxb-test",
        deployment: { mode: "socket", appToken: "xapp-test" },
        _webClient: createMockWebClient(),
        _socketClient: socketClient,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      socketClient._emit("message", {
        event: {
          type: "message",
          text: "Say OK",
          user: "U1",
          channel: "C1",
          ts: "1234567890.000001",
        },
        ack: mock(() => {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

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
        channelId: "slack",
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 8: Connect/disconnect lifecycle ────────────────────────────

  test("connect calls socketClient.start, disconnect calls socketClient.disconnect", async () => {
    const socketClient = createMockSocketClient();
    const channel = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: createMockWebClient(),
      _socketClient: socketClient,
    });

    await channel.connect();
    expect(socketClient.start).toHaveBeenCalledTimes(1);

    await channel.disconnect();
    expect(socketClient.disconnect).toHaveBeenCalledTimes(1);
  });

  // ── Test 9: Reaction normalization ──────────────────────────────────

  test("reaction event normalizes to slack:reaction custom block", async () => {
    const socketClient = createMockSocketClient();
    const channel = createSlackChannel({
      botToken: "xoxb-test",
      deployment: { mode: "socket", appToken: "xapp-test" },
      _webClient: createMockWebClient(),
      _socketClient: socketClient,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    socketClient._emit("reaction_added", {
      event: {
        type: "reaction_added",
        user: "U42",
        reaction: "thumbsup",
        item: { type: "message", channel: "C100", ts: "123.456" },
        event_ts: "1234567890.000001",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const block = received[0]?.content[0] as {
      readonly kind: string;
      readonly type: string;
      readonly data: { readonly action: string; readonly reaction: string };
    };
    expect(block.kind).toBe("custom");
    expect(block.type).toBe("slack:reaction");
    expect(block.data.action).toBe("add");
    expect(block.data.reaction).toBe("thumbsup");

    await channel.disconnect();
  });

  // ── Test 10: HTTP mode handleEvent through full pipeline ───────────

  test(
    "HTTP mode handleEvent → normalize → createKoi → real LLM",
    async () => {
      const webClient = createMockWebClient();
      const socketClient = createMockSocketClient();
      const channel = createSlackChannel({
        botToken: "xoxb-test",
        deployment: { mode: "http", signingSecret: "test-secret" },
        _webClient: webClient,
        _socketClient: socketClient,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      const handleEvent = (channel as { readonly handleEvent?: (p: unknown) => void }).handleEvent;
      expect(handleEvent).toBeDefined();

      handleEvent?.({
        type: "event_callback",
        event: {
          type: "message",
          text: "Reply with exactly: hello",
          user: "U42",
          channel: "C789",
          ts: "1234567890.000001",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound");

      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "slack",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("hello");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );
});
