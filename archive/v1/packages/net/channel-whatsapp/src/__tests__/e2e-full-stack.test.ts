/**
 * Full-stack E2E: createWhatsAppChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - WhatsApp channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (text, images, documents, reactions)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock Baileys socket
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - Bot self-filtering (own JID)
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import { describe, expect, test } from "bun:test";
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
import { createMockBaileysSocket } from "../test-helpers.js";
import { createWhatsAppChannel } from "../whatsapp-channel.js";

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
    name: "E2E WhatsApp Agent",
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

describeE2E("e2e: channel-whatsapp + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", () => {
    const adapter = createWhatsAppChannel({
      authStatePath: "/tmp/test-auth",
      _socket: createMockBaileysSocket(),
    });

    expect(adapter.name).toBe("whatsapp");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(true);
    expect(adapter.capabilities.audio).toBe(true);
    expect(adapter.capabilities.video).toBe(true);
    expect(adapter.capabilities.threads).toBe(false);
  });

  // ── Test 2: Inbound text → LLM → outbound through full runtime ────

  test(
    "inbound WhatsApp message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const mockSocket = createMockBaileysSocket();
      const channel = createWhatsAppChannel({
        authStatePath: "/tmp/test-auth",
        _socket: mockSocket,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Simulate inbound WhatsApp message via ev._emit (Baileys pattern)
      mockSocket.ev._emit("messages.upsert", {
        messages: [
          {
            key: {
              remoteJid: "5511999999999@s.whatsapp.net",
              fromMe: false,
              id: "MSG-E2E-001",
            },
            message: { conversation: "Reply with exactly: pong" },
            messageTimestamp: 1234567890,
          },
        ],
        type: "notify",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({
        kind: "text",
        text: "Reply with exactly: pong",
      });
      expect(inbound.threadId).toBe("5511999999999@s.whatsapp.net");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "whatsapp",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the WhatsApp channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      expect(mockSocket.sendMessage).toHaveBeenCalled();

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through WhatsApp channel + middleware chain ───

  test(
    "LLM tool call: WhatsApp inbound → middleware → tool → LLM → outbound",
    async () => {
      const mockSocket = createMockBaileysSocket();
      const channel = createWhatsAppChannel({
        authStatePath: "/tmp/test-auth",
        _socket: mockSocket,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      mockSocket.ev._emit("messages.upsert", {
        messages: [
          {
            key: {
              remoteJid: "5511999999999@s.whatsapp.net",
              fromMe: false,
              id: "MSG-E2E-002",
            },
            message: {
              conversation:
                "Use the multiply tool to compute 7 * 8. Report the result number only.",
            },
            messageTimestamp: 1234567890,
          },
        ],
        type: "notify",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");

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
        channelId: "whatsapp",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      expect(toolCalls).toContain("multiply");

      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      expect(text).toContain("56");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Image message normalization ─────────────────────────────

  test("image message normalizes to image block", async () => {
    const mockSocket = createMockBaileysSocket();
    const channel = createWhatsAppChannel({
      authStatePath: "/tmp/test-auth",
      _socket: mockSocket,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    mockSocket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "MSG-E2E-IMG",
          },
          message: {
            imageMessage: {
              url: "https://example.com/photo.jpg",
              mimetype: "image/jpeg",
              caption: "Check this out",
            },
          },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const inbound = received[0];
    if (inbound === undefined) throw new Error("No inbound");

    const imageBlocks = inbound.content.filter((b) => b.kind === "image");
    expect(imageBlocks.length).toBeGreaterThanOrEqual(1);

    await channel.disconnect();
  });

  // ── Test 5: Bot self-filtering ──────────────────────────────────────

  test("bot's own messages (fromMe) are filtered", async () => {
    const mockSocket = createMockBaileysSocket();
    const channel = createWhatsAppChannel({
      authStatePath: "/tmp/test-auth",
      _socket: mockSocket,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    mockSocket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: true,
            id: "MSG-E2E-OWN",
          },
          message: { conversation: "bot echo" },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(0);

    await channel.disconnect();
  });

  // ── Test 6: Session + turn lifecycle hooks ──────────────────────────

  test(
    "session and turn lifecycle hooks fire for WhatsApp-sourced messages",
    async () => {
      const mockSocket = createMockBaileysSocket();
      const channel = createWhatsAppChannel({
        authStatePath: "/tmp/test-auth",
        _socket: mockSocket,
      });

      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      mockSocket.ev._emit("messages.upsert", {
        messages: [
          {
            key: {
              remoteJid: "5511999999999@s.whatsapp.net",
              fromMe: false,
              id: "MSG-E2E-LC",
            },
            message: { conversation: "Say OK" },
            messageTimestamp: 1234567890,
          },
        ],
        type: "notify",
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
        channelId: "whatsapp",
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

  // ── Test 7: Connect/disconnect lifecycle ────────────────────────────

  test("connect and disconnect lifecycle", async () => {
    const mockSocket = createMockBaileysSocket();
    const channel = createWhatsAppChannel({
      authStatePath: "/tmp/test-auth",
      _socket: mockSocket,
    });

    await channel.connect();
    await channel.disconnect();
    expect(mockSocket.end).toHaveBeenCalledTimes(1);
  });

  // ── Test 8: Reaction normalization ──────────────────────────────────

  test("reaction normalizes to whatsapp:reaction custom block", async () => {
    const mockSocket = createMockBaileysSocket();
    const channel = createWhatsAppChannel({
      authStatePath: "/tmp/test-auth",
      _socket: mockSocket,
    });

    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    // Baileys sends reactions as messages with reactionMessage
    mockSocket.ev._emit("messages.upsert", {
      messages: [
        {
          key: {
            remoteJid: "5511999999999@s.whatsapp.net",
            fromMe: false,
            id: "MSG-E2E-REACT",
          },
          message: {
            reactionMessage: {
              key: { remoteJid: "5511999999999@s.whatsapp.net", id: "MSG001" },
              text: "👍",
            },
          },
          messageTimestamp: 1234567890,
        },
      ],
      type: "notify",
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
    const block = received[0]?.content[0];
    expect(block?.kind).toBe("custom");

    await channel.disconnect();
  });
});
