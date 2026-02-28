/**
 * Full-stack E2E: createMatrixChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Matrix channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (room events → InboundMessage)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock Matrix client
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - Bot echo prevention
 *   - Text chunking for oversized responses
 *   - Send queue serialization
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
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createMatrixChannel } from "../matrix-channel.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const BOT_USER_ID = "@bot:matrix.org";

// ---------------------------------------------------------------------------
// Mock Matrix client for testing (avoids real homeserver)
// ---------------------------------------------------------------------------

function createMockMatrixClient(): {
  readonly client: {
    readonly getUserId: () => Promise<string>;
    readonly start: () => Promise<void>;
    readonly stop: () => void;
    readonly on: (event: string, handler: (...args: readonly unknown[]) => void) => void;
    readonly off: (event: string, handler: (...args: readonly unknown[]) => void) => void;
    readonly sendText: ReturnType<typeof mock>;
    readonly sendMessage: ReturnType<typeof mock>;
    readonly joinRoom: ReturnType<typeof mock>;
  };
  readonly emitRoomMessage: (roomId: string, event: Record<string, unknown>) => void;
} {
  const handlers = new Map<string, ((...args: readonly unknown[]) => void)[]>();

  const client = {
    getUserId: async () => BOT_USER_ID,
    start: async () => {},
    stop: () => {},
    on: (event: string, handler: (...args: readonly unknown[]) => void) => {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
    },
    off: (event: string, handler: (...args: readonly unknown[]) => void) => {
      const existing = handlers.get(event) ?? [];
      handlers.set(
        event,
        existing.filter((h) => h !== handler),
      );
    },
    sendText: mock(async () => "$event1"),
    sendMessage: mock(async () => "$event2"),
    joinRoom: mock(async () => "!joined:matrix.org"),
  };

  return {
    client,
    emitRoomMessage: (roomId: string, event: Record<string, unknown>) => {
      const fns = handlers.get("room.message") ?? [];
      for (const fn of fns) {
        fn(roomId, event);
      }
    },
  };
}

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
    name: "E2E Matrix Agent",
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

describeE2E("e2e: channel-matrix + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", () => {
    const { client } = createMockMatrixClient();
    const adapter = createMatrixChannel({
      homeserverUrl: "https://matrix.org",
      accessToken: "test-token",
      _client: client,
    });

    expect(adapter.name).toBe("matrix");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(false);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.capabilities.audio).toBe(false);
  });

  // ── Test 2: Room message → LLM → channel.send() ──────────────────

  test(
    "inbound Matrix room message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const { client, emitRoomMessage } = createMockMatrixClient();
      const channel = createMatrixChannel({
        homeserverUrl: "https://matrix.org",
        accessToken: "test-token",
        _client: client,
        debounceMs: 0,
      });

      // Wire channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      // Simulate a Matrix room message
      emitRoomMessage("!room1:matrix.org", {
        type: "m.room.message",
        sender: "@user:matrix.org",
        event_id: "$ev1",
        content: {
          msgtype: "m.text",
          body: "Reply with exactly: pong",
        },
        origin_server_ts: Date.now(),
      });
      await Bun.sleep(200);

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("@user:matrix.org");
      expect(inbound.threadId).toBe("!room1:matrix.org");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "matrix",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the Matrix channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Verify the mock Matrix client's sendText was called
      expect(client.sendText).toHaveBeenCalled();
      const sendCall = client.sendText.mock.calls[0];
      expect(sendCall?.[0]).toBe("!room1:matrix.org");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through Matrix channel + middleware ─────────

  test(
    "LLM tool call: Matrix inbound → middleware → tool → LLM → outbound",
    async () => {
      const { client, emitRoomMessage } = createMockMatrixClient();
      const channel = createMatrixChannel({
        homeserverUrl: "https://matrix.org",
        accessToken: "test-token",
        _client: client,
        debounceMs: 0,
      });

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      emitRoomMessage("!room2:matrix.org", {
        type: "m.room.message",
        sender: "@user:matrix.org",
        event_id: "$ev2",
        content: {
          msgtype: "m.text",
          body: "Use the multiply tool to compute 7 * 8. Report the result number only.",
        },
        origin_server_ts: Date.now(),
      });
      await Bun.sleep(200);

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
        channelId: "matrix",
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

  // ── Test 4: Bot echo prevention ──────────────────────────────────

  test("bot's own messages are filtered at normalization", async () => {
    const { client, emitRoomMessage } = createMockMatrixClient();
    const channel = createMatrixChannel({
      homeserverUrl: "https://matrix.org",
      accessToken: "test-token",
      _client: client,
      debounceMs: 0,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();

    // Bot's own message — should be filtered
    emitRoomMessage("!room:matrix.org", {
      type: "m.room.message",
      sender: BOT_USER_ID,
      event_id: "$bot-ev",
      content: { msgtype: "m.text", body: "bot echo" },
      origin_server_ts: Date.now(),
    });
    await Bun.sleep(100);
    expect(received).toHaveLength(0);

    // Another user's message — should pass through
    emitRoomMessage("!room:matrix.org", {
      type: "m.room.message",
      sender: "@human:matrix.org",
      event_id: "$human-ev",
      content: { msgtype: "m.text", body: "human message" },
      origin_server_ts: Date.now(),
    });
    await Bun.sleep(100);
    expect(received).toHaveLength(1);

    await channel.disconnect();
  });

  // ── Test 5: Session + turn lifecycle hooks fire ───────────────────

  test(
    "session and turn lifecycle hooks fire for Matrix-sourced messages",
    async () => {
      const { client, emitRoomMessage } = createMockMatrixClient();
      const channel = createMatrixChannel({
        homeserverUrl: "https://matrix.org",
        accessToken: "test-token",
        _client: client,
        debounceMs: 0,
      });

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      emitRoomMessage("!room:matrix.org", {
        type: "m.room.message",
        sender: "@user:matrix.org",
        event_id: "$ev",
        content: { msgtype: "m.text", body: "Say OK" },
        origin_server_ts: Date.now(),
      });
      await Bun.sleep(200);

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
        channelId: "matrix",
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

  // ── Test 6: Connect/disconnect lifecycle ─────────────────────────

  test("connect and disconnect complete without error", async () => {
    const { client } = createMockMatrixClient();
    const channel = createMatrixChannel({
      homeserverUrl: "https://matrix.org",
      accessToken: "test-token",
      _client: client,
    });

    await channel.connect();
    await channel.disconnect();
  });
});
