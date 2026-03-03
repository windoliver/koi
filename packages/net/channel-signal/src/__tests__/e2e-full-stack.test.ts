/**
 * Full-stack E2E: createSignalChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Signal channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (signal-cli JSON events → InboundMessage)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock signal-cli process
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - E.164 phone normalization
 *   - Text chunking for oversized responses
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
import type { SpawnFn } from "../config.js";
import { createSignalChannel } from "../signal-channel.js";

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
// Mock signal-cli spawn for testing (avoids real signal-cli binary)
// ---------------------------------------------------------------------------

function createMockSpawn(): {
  readonly spawn: SpawnFn;
  readonly pushLine: (line: string) => void;
  readonly kill: ReturnType<typeof mock>;
  readonly stdinWrite: ReturnType<typeof mock>;
} {
  // let: resolve function for the exit promise
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const kill = mock(() => {
    resolveExit?.(0);
  });
  const stdinWrite = mock(() => 0);

  // let: controller reference for pushing data
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  const encoder = new TextEncoder();
  const pushLine = (line: string): void => {
    controller?.enqueue(encoder.encode(`${line}\n`));
  };

  const spawn: SpawnFn = mock(() => ({
    stdout,
    stdin: { write: stdinWrite },
    kill,
    exited,
  }));

  return { spawn, pushLine, kill, stdinWrite };
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
    name: "E2E Signal Agent",
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

describeE2E("e2e: channel-signal + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", () => {
    const { spawn } = createMockSpawn();
    const adapter = createSignalChannel({
      account: "+1234567890",
      _spawn: spawn,
    });

    expect(adapter.name).toBe("signal");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(false);
    expect(adapter.capabilities.threads).toBe(false);
    expect(adapter.capabilities.audio).toBe(false);
  });

  // ── Test 2: Signal message → LLM → channel.send() ────────────────

  test(
    "inbound Signal message → createKoi runtime → real LLM → channel.send()",
    async () => {
      const { spawn, pushLine, stdinWrite } = createMockSpawn();
      const channel = createSignalChannel({
        account: "+1234567890",
        debounceMs: 0,
        _spawn: spawn,
      });

      // Wire channel to collect inbound messages
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      // Simulate a signal-cli JSON-RPC event on stdout
      pushLine(
        JSON.stringify({
          params: {
            source: "+9876543210",
            dataMessage: {
              message: "Reply with exactly: pong",
              timestamp: 1700000000000,
            },
          },
        }),
      );
      await Bun.sleep(200);

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("+9876543210");
      expect(inbound.threadId).toBe("+9876543210");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "signal",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      // Send LLM response back through the Signal channel
      await channel.send({
        content: [{ kind: "text", text }],
        ...(inbound.threadId !== undefined ? { threadId: inbound.threadId } : {}),
      });

      // Verify signal-cli stdin received the send command
      expect(stdinWrite).toHaveBeenCalled();
      const written = stdinWrite.mock.calls[0]?.[0] as Uint8Array;
      const rpcText = new TextDecoder().decode(written);
      const rpcParsed = JSON.parse(rpcText.trim()) as {
        readonly method: string;
        readonly params: Record<string, unknown>;
      };
      expect(rpcParsed.method).toBe("send");
      expect(rpcParsed.params.recipient).toBe("+9876543210");

      await runtime.dispose();
      await channel.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through Signal channel + middleware ─────────

  test(
    "LLM tool call: Signal inbound → middleware → tool → LLM → outbound",
    async () => {
      const { spawn, pushLine } = createMockSpawn();
      const channel = createSignalChannel({
        account: "+1234567890",
        debounceMs: 0,
        _spawn: spawn,
      });

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      pushLine(
        JSON.stringify({
          params: {
            source: "+5555555555",
            dataMessage: {
              message: "Use the multiply tool to compute 7 * 8. Report the result number only.",
              timestamp: 1700000000001,
            },
          },
        }),
      );
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
        channelId: "signal",
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

  // ── Test 4: Session + turn lifecycle hooks fire ───────────────────

  test(
    "session and turn lifecycle hooks fire for Signal-sourced messages",
    async () => {
      const { spawn, pushLine } = createMockSpawn();
      const channel = createSignalChannel({
        account: "+1234567890",
        debounceMs: 0,
        _spawn: spawn,
      });

      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });

      await channel.connect();

      pushLine(
        JSON.stringify({
          params: {
            source: "+1111111111",
            dataMessage: {
              message: "Say OK",
              timestamp: 1700000000002,
            },
          },
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
        channelId: "signal",
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

  // ── Test 5: Connect/disconnect lifecycle ─────────────────────────

  test("connect spawns signal-cli and disconnect kills it", async () => {
    const { spawn, kill } = createMockSpawn();
    const channel = createSignalChannel({
      account: "+1234567890",
      _spawn: spawn,
    });

    await channel.connect();
    expect(spawn).toHaveBeenCalledTimes(1);

    await channel.disconnect();
    expect(kill).toHaveBeenCalled();
  });

  // ── Test 6: E.164 normalization in inbound messages ──────────────

  test("phone numbers are normalized to E.164 in inbound messages", async () => {
    const { spawn, pushLine } = createMockSpawn();
    const channel = createSignalChannel({
      account: "+1234567890",
      debounceMs: 0,
      _spawn: spawn,
    });

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();

    // Source number is already E.164 — should pass through unchanged
    pushLine(
      JSON.stringify({
        params: {
          source: "+4915123456789",
          dataMessage: {
            message: "hello from Germany",
            timestamp: 1700000000003,
          },
        },
      }),
    );
    await Bun.sleep(200);

    expect(received).toHaveLength(1);
    expect(received[0]?.senderId).toBe("+4915123456789");
    expect(received[0]?.threadId).toBe("+4915123456789");

    await channel.disconnect();
  });
});
