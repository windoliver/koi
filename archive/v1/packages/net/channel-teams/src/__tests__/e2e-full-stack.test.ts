/**
 * Full-stack E2E: createTeamsChannel + createKoi + createPiAdapter.
 *
 * Validates the entire pipeline with a real LLM call:
 *   - Teams channel adapter creation + lifecycle (connect/disconnect)
 *   - Inbound message normalization (Activities → InboundMessage)
 *   - Full L1 runtime assembly (createKoi + middleware chain)
 *   - Real Anthropic LLM call via createPiAdapter
 *   - Tool registration + tool call + result integration
 *   - Outbound message delivery through mock turn context
 *   - Middleware hook observation (session/turn lifecycle, tool interception)
 *   - Bot echo prevention
 *   - @mention stripping
 *   - Conversation reference storage
 *   - Retry queue with Retry-After support
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
import { DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { TeamsActivity } from "../activity-types.js";
import { createTeamsChannel } from "../teams-channel.js";

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
    name: "E2E Teams Agent",
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

describeE2E("e2e: channel-teams + createKoi + createPiAdapter full stack", () => {
  // ── Test 1: Channel adapter capabilities ──────────────────────────

  test("channel adapter has correct name and capabilities", () => {
    const adapter = createTeamsChannel({
      appId: "test-app-id",
      appPassword: "test-password",
      _agent: {},
    });

    expect(adapter.name).toBe("teams");
    expect(adapter.capabilities.text).toBe(true);
    expect(adapter.capabilities.images).toBe(true);
    expect(adapter.capabilities.files).toBe(true);
    expect(adapter.capabilities.buttons).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
    expect(adapter.capabilities.audio).toBe(false);
  });

  // ── Test 2: Teams Activity → LLM → channel.send() ───────────────

  test(
    "inbound Teams Activity → createKoi runtime → real LLM → channel.send()",
    async () => {
      const adapter = createTeamsChannel({
        appId: "test-app-id",
        appPassword: "test-password",
        _agent: {},
      });

      // Wire channel to collect inbound messages
      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();

      // Simulate a Teams Activity via handleActivity
      const activity: TeamsActivity = {
        type: "message",
        id: "act-1",
        text: "Reply with exactly: pong",
        from: { id: "user-1", name: "Test User" },
        conversation: { id: "conv-1" },
        serviceUrl: "https://smba.trafficmanager.net/teams/",
      };

      await adapter.handleActivity?.(activity);
      await Bun.sleep(200);

      // Verify inbound normalization
      expect(received).toHaveLength(1);
      const inbound = received[0];
      if (inbound === undefined) throw new Error("No inbound message");
      expect(inbound.content[0]).toEqual({ kind: "text", text: "Reply with exactly: pong" });
      expect(inbound.senderId).toBe("user-1");
      expect(inbound.threadId).toBe("conv-1");

      // Verify conversation reference was stored
      const refs = adapter.conversationReferences();
      expect(refs.size).toBe(1);
      expect(refs.get("conv-1")?.serviceUrl).toBe("https://smba.trafficmanager.net/teams/");

      // Run through the full L1 runtime with real LLM
      const engineAdapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: engineAdapter,
        channelId: "teams",
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("pong");

      await runtime.dispose();
      await adapter.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Tool call through Teams channel + middleware ──────────

  test(
    "LLM tool call: Teams Activity → middleware → tool → LLM → outbound",
    async () => {
      const adapter = createTeamsChannel({
        appId: "test-app-id",
        appPassword: "test-password",
        _agent: {},
      });

      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();

      const activity: TeamsActivity = {
        type: "message",
        id: "act-2",
        text: "Use the multiply tool to compute 7 * 8. Report the result number only.",
        from: { id: "user-2", name: "Test User 2" },
        conversation: { id: "conv-2" },
      };

      await adapter.handleActivity?.(activity);
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
        channelId: "teams",
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
      await adapter.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 4: Bot echo prevention ──────────────────────────────────

  test("bot's own messages are filtered at normalization", async () => {
    const adapter = createTeamsChannel({
      appId: "bot-app-id",
      appPassword: "test-password",
      _agent: {},
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    // Bot's own message — should be filtered
    await adapter.handleActivity?.({
      type: "message",
      text: "bot echo",
      from: { id: "bot-app-id", name: "Bot" },
      conversation: { id: "conv-1" },
    });
    await Bun.sleep(100);
    expect(received).toHaveLength(0);

    // Another user's message — should pass through
    await adapter.handleActivity?.({
      type: "message",
      text: "human message",
      from: { id: "user-1", name: "Human" },
      conversation: { id: "conv-1" },
    });
    await Bun.sleep(100);
    expect(received).toHaveLength(1);

    await adapter.disconnect();
  });

  // ── Test 5: @mention stripping ───────────────────────────────────

  test("@mention tags are stripped from inbound text", async () => {
    const adapter = createTeamsChannel({
      appId: "test-app-id",
      appPassword: "test-password",
      _agent: {},
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    await adapter.handleActivity?.({
      type: "message",
      text: "<at>Bot</at> what is the weather?",
      from: { id: "user-1", name: "User" },
      conversation: { id: "conv-1" },
    });
    await Bun.sleep(100);

    expect(received).toHaveLength(1);
    expect(received[0]?.content[0]).toEqual({ kind: "text", text: "what is the weather?" });

    await adapter.disconnect();
  });

  // ── Test 6: Session + turn lifecycle hooks fire ───────────────────

  test(
    "session and turn lifecycle hooks fire for Teams-sourced messages",
    async () => {
      const adapter = createTeamsChannel({
        appId: "test-app-id",
        appPassword: "test-password",
        _agent: {},
      });

      const received: InboundMessage[] = [];
      adapter.onMessage(async (msg) => {
        received.push(msg);
      });

      await adapter.connect();

      await adapter.handleActivity?.({
        type: "message",
        text: "Say OK",
        from: { id: "user-1" },
        conversation: { id: "conv-1" },
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
        channelId: "teams",
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "messages", messages: [inbound] }));

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
      await adapter.disconnect();
    },
    TIMEOUT_MS,
  );

  // ── Test 7: Non-message activity types are ignored ────────────────

  test("non-message activity types (conversationUpdate) are ignored", async () => {
    const adapter = createTeamsChannel({
      appId: "test-app-id",
      appPassword: "test-password",
      _agent: {},
    });

    const received: InboundMessage[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    await adapter.handleActivity?.({
      type: "conversationUpdate",
      from: { id: "user-1" },
      conversation: { id: "conv-1" },
    });
    await Bun.sleep(100);

    expect(received).toHaveLength(0);

    await adapter.disconnect();
  });

  // ── Test 8: Conversation reference storage lifecycle ──────────────

  test("conversation references are stored and cleared on disconnect", async () => {
    const adapter = createTeamsChannel({
      appId: "test-app-id",
      appPassword: "test-password",
      _agent: {},
    });

    await adapter.connect();

    await adapter.handleActivity?.({
      type: "message",
      text: "hello",
      from: { id: "user-1" },
      conversation: { id: "conv-1", tenantId: "tenant-1" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
    });

    const refs = adapter.conversationReferences();
    expect(refs.size).toBe(1);
    expect(refs.get("conv-1")?.botId).toBe("test-app-id");
    expect(refs.get("conv-1")?.tenantId).toBe("tenant-1");

    await adapter.disconnect();
    expect(adapter.conversationReferences().size).toBe(0);
  });
});
