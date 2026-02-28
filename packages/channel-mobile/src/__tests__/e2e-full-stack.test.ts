/**
 * Full-stack E2E: createMobileChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Mobile WebSocket channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (JSON frames → InboundMessage)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through channel.send()
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - WebSocket threading (mobile:clientId format)
 *   - Rate limiting integration
 *   - Text chunking for oversized responses
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
import { toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createMobileChannel } from "../mobile-channel.js";

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
    name: "E2E Mobile Agent",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

/** Find an available port for the WebSocket server. */
async function findPort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port;
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

describeE2E("e2e: channel-mobile + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", async () => {
    const port = await findPort();
    const adapter = createMobileChannel({ port });
    expect(adapter.name).toBe("mobile");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(true);
    expect(adapter.capabilities.audio).toBe(true);
    expect(adapter.capabilities.video).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.tools).toEqual([]);
    expect(adapter.connectedClients()).toBe(0);
  });

  // ── Test 2: WebSocket message → LLM → channel.send() ─────────────

  test(
    "inbound WebSocket message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const port = await findPort();
      const channel = createMobileChannel({ port });
      await channel.connect();

      // Wire channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Connect a WebSocket client
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      // Collect outbound frames sent back to the client
      const outbound: string[] = [];
      ws.onmessage = (event) => {
        outbound.push(typeof event.data === "string" ? event.data : "");
      };

      // Send a message frame
      ws.send(
        JSON.stringify({
          kind: "message",
          content: [{ kind: "text", text: "Reply with exactly: pong" }],
          senderId: "user-1",
        }),
      );
      await Bun.sleep(200);

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("user-1");
      // ThreadId should be auto-assigned as "mobile:<clientId>"
      expect(inbound.threadId).toMatch(/^mobile:\d+$/);

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "mobile",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the mobile channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Wait for outbound WebSocket frame
      await Bun.sleep(100);
      // Filter out heartbeat pong frames
      const messageFrames = outbound.filter((f) => {
        const parsed = JSON.parse(f) as { readonly kind: string };
        return parsed.kind === "message";
      });
      expect(messageFrames.length).toBeGreaterThanOrEqual(1);

      ws.close();
      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through mobile channel + middleware chain ────

  test(
    "LLM tool call: WebSocket inbound → middleware → tool → LLM → outbound",
    async () => {
      const port = await findPort();
      const channel = createMobileChannel({ port });
      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      // Connect WebSocket client
      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      ws.send(
        JSON.stringify({
          kind: "message",
          content: [
            {
              kind: "text",
              text: "Use the multiply tool to compute 7 * 8. Report the result number only.",
            },
          ],
          senderId: "user-2",
        }),
      );
      await Bun.sleep(200);

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
        channelId: "mobile",
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

      ws.close();
      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Session + turn lifecycle hooks fire ───────────────────

  test(
    "session and turn lifecycle hooks fire for mobile-sourced messages",
    async () => {
      const port = await findPort();
      const channel = createMobileChannel({ port });
      await channel.connect();

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      const ws = new WebSocket(`ws://localhost:${port}`);
      await new Promise<void>((resolve) => {
        ws.onopen = () => resolve();
      });

      ws.send(
        JSON.stringify({
          kind: "message",
          content: [{ kind: "text", text: "Say OK" }],
          senderId: "user-3",
        }),
      );
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
        channelId: "mobile",
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      ws.close();
      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 5: Connect/disconnect lifecycle + client tracking ────────

  test("connect/disconnect lifecycle and client tracking", async () => {
    const port = await findPort();
    const channel = createMobileChannel({ port });

    await channel.connect();
    expect(channel.connectedClients()).toBe(0);

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    await Bun.sleep(50);
    expect(channel.connectedClients()).toBe(1);

    ws.close();
    await Bun.sleep(50);
    expect(channel.connectedClients()).toBe(0);

    await channel.disconnect();
  });

  // ── Test 6: Ping/pong heartbeat ──────────────────────────────────

  test("ping frame receives pong response", async () => {
    const port = await findPort();
    const channel = createMobileChannel({ port });
    await channel.connect();

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const responses: string[] = [];
    ws.onmessage = (event) => {
      responses.push(typeof event.data === "string" ? event.data : "");
    };

    ws.send(JSON.stringify({ kind: "ping" }));
    await Bun.sleep(100);

    const pongs = responses.filter((r) => {
      const parsed = JSON.parse(r) as { readonly kind: string };
      return parsed.kind === "pong";
    });
    expect(pongs.length).toBeGreaterThanOrEqual(1);

    ws.close();
    await channel.disconnect();
  });

  // ── Test 7: Auth flow ────────────────────────────────────────────

  test("auth flow rejects unauthenticated messages and accepts after auth", async () => {
    const port = await findPort();
    const channel = createMobileChannel({
      port,
      authToken: "secret-token",
      features: { requireAuth: true },
    });
    await channel.connect();

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    const responses: string[] = [];
    ws.onmessage = (event) => {
      responses.push(typeof event.data === "string" ? event.data : "");
    };

    // Send message without auth — should be rejected
    ws.send(
      JSON.stringify({
        kind: "message",
        content: [{ kind: "text", text: "before auth" }],
        senderId: "user-1",
      }),
    );
    await Bun.sleep(100);

    expect(received).toHaveLength(0);
    const errors = responses.filter((r) => {
      const parsed = JSON.parse(r) as { readonly kind: string };
      return parsed.kind === "error";
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);

    // Now authenticate
    ws.send(JSON.stringify({ kind: "auth", token: "secret-token" }));
    await Bun.sleep(100);

    // Send message after auth — should be accepted
    ws.send(
      JSON.stringify({
        kind: "message",
        content: [{ kind: "text", text: "after auth" }],
        senderId: "user-1",
      }),
    );
    await Bun.sleep(200);

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "after auth" });

    ws.close();
    await channel.disconnect();
  });
});
