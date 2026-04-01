/**
 * E2E: @koi/channel-canvas-fallback through the full L1 runtime assembly.
 *
 * Validates that the canvas fallback channel decorator correctly intercepts
 * A2UI blocks, calls the Gateway canvas API, and replaces them with text
 * links — all wired through createKoi + createLoopAdapter with real
 * Anthropic API calls.
 *
 * Tests cover:
 *   1. Tool emits A2UI createSurface → decorator POSTs to Gateway → text link
 *   2. Full lifecycle: create → update → delete through middleware chain
 *   3. Mixed content (text + A2UI + image) — only A2UI blocks are replaced
 *   4. Gateway failure → degraded text with [Warning] + onGatewayError callback
 *   5. Channel with supportsA2ui: true → decorator is a no-op (passthrough)
 *   6. No A2UI blocks → messages pass through without Gateway calls
 *   7. Middleware wrapToolCall observes the full fallback pipeline
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/e2e-canvas-fallback.test.ts
 *
 * Cost: ~$0.03-0.06 per run (haiku model, minimal prompts).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createCanvasFallbackChannel, createGatewayClient } from "@koi/channel-canvas-fallback";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ComponentProvider,
  ContentBlock,
  EngineEvent,
  KoiError,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  OutboundMessage,
  Tool,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeFallback = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const MODEL_NAME = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Mock Gateway server
// ---------------------------------------------------------------------------

interface GatewayLog {
  readonly method: string;
  readonly surfaceId: string;
  readonly body: string;
}

type MockHandler = (req: Request) => Response | Promise<Response>;

// let: re-assigned per test to swap handler logic
let currentHandler: MockHandler = () => new Response("not configured", { status: 500 });

// let: server lifecycle — created in beforeEach, stopped in afterEach
let server: ReturnType<typeof Bun.serve>;
// let: resolved after server starts
let gatewayBaseUrl: string;
// let: accumulates gateway calls per test
let gatewayLog: GatewayLog[];

beforeEach(() => {
  gatewayLog = [];
  server = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      return currentHandler(req);
    },
  });
  gatewayBaseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

function makeTextOnlyCaps(): ChannelCapabilities {
  return {
    text: true,
    images: false,
    files: false,
    buttons: false,
    audio: false,
    video: false,
    threads: false,
    supportsA2ui: false,
  };
}

function makeA2uiCaps(): ChannelCapabilities {
  return {
    text: true,
    images: true,
    files: true,
    buttons: true,
    audio: false,
    video: false,
    threads: true,
    supportsA2ui: true,
  };
}

/** Creates a mock inner channel that records all sent messages. */
function makeInnerChannel(
  capabilities: ChannelCapabilities,
): ChannelAdapter & { readonly sentMessages: OutboundMessage[] } {
  const sentMessages: OutboundMessage[] = []; // let justified: test accumulator
  return {
    name: "e2e-mock",
    capabilities,
    connect: mock(() => Promise.resolve()),
    disconnect: mock(() => Promise.resolve()),
    send: mock(async (message: OutboundMessage) => {
      sentMessages.push(message);
    }),
    onMessage: mock(() => () => {}),
    sentMessages,
  };
}

/** Default mock Gateway handler: accepts all operations, captures request bodies. */
async function defaultGatewayHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/");
  const sid = parts[parts.length - 1] ?? "unknown";
  const body = req.method !== "DELETE" ? await req.text() : "";

  gatewayLog.push({ method: req.method, surfaceId: sid, body });

  switch (req.method) {
    case "POST":
      return new Response(JSON.stringify({ ok: true, surfaceId: sid }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    case "PATCH":
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    case "DELETE":
      return new Response(null, { status: 204 });
    default:
      return new Response("bad method", { status: 405 });
  }
}

function makeCreateSurfaceBlock(sid: string, title: string): ContentBlock {
  return {
    kind: "custom",
    type: "a2ui:createSurface",
    data: {
      kind: "createSurface",
      surfaceId: sid,
      title,
      components: [{ id: "c1", type: "Text", properties: { text: "Hello" } }],
    },
  };
}

function makeUpdateComponentsBlock(sid: string): ContentBlock {
  return {
    kind: "custom",
    type: "a2ui:updateComponents",
    data: {
      kind: "updateComponents",
      surfaceId: sid,
      components: [{ id: "c1", type: "Text", properties: { text: "Updated" } }],
    },
  };
}

function makeDeleteSurfaceBlock(sid: string): ContentBlock {
  return {
    kind: "custom",
    type: "a2ui:deleteSurface",
    data: { kind: "deleteSurface", surfaceId: sid },
  };
}

// ---------------------------------------------------------------------------
// Test harness — eliminates repeated boilerplate across tests
// ---------------------------------------------------------------------------

interface HarnessConfig {
  readonly manifestName: string;
  readonly tool: Tool;
  readonly toolName: string;
  readonly toolCallInput: Record<string, unknown>;
  readonly middleware?: readonly KoiMiddleware[];
  readonly prompt: string;
}

interface HarnessResult {
  readonly events: readonly EngineEvent[];
  readonly modelCallCount: number;
}

/** Runs the two-phase model handler through createKoi + createLoopAdapter. */
async function runWithKoi(config: HarnessConfig): Promise<HarnessResult> {
  let modelCallCount = 0; // let justified: tracks model call phases

  const toolProvider: ComponentProvider = {
    name: `e2e-${config.manifestName}-provider`,
    attach: async () => {
      const components = new Map<string, unknown>();
      components.set(toolToken(config.toolName), config.tool);
      return components;
    },
  };

  const { createAnthropicAdapter } = await import("@koi/model-router");
  const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
    modelCallCount++;
    if (modelCallCount === 1) {
      return {
        content: "Executing tool.",
        model: MODEL_NAME,
        usage: { inputTokens: 10, outputTokens: 15 },
        metadata: {
          toolCalls: [
            {
              toolName: config.toolName,
              callId: `call-${config.manifestName}-1`,
              input: config.toolCallInput,
            },
          ],
        },
      };
    }
    const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
    return anthropic.complete({
      ...request,
      model: MODEL_NAME,
      maxTokens: 100,
    });
  };

  const { createLoopAdapter } = await import("@koi/engine-loop");
  const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

  const runtime = await createKoi({
    manifest: {
      name: config.manifestName,
      version: "0.0.1",
      model: { name: MODEL_NAME },
    },
    adapter,
    middleware: config.middleware !== undefined ? [...config.middleware] : [],
    providers: [toolProvider],
  });

  try {
    const events = await collectEvents(runtime.run({ kind: "text", text: config.prompt }));
    return { events, modelCallCount };
  } finally {
    await runtime.dispose?.();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeFallback("e2e: canvas fallback through createKoi + createLoopAdapter", () => {
  test(
    "tool emits A2UI createSurface, decorator POSTs to Gateway, channel receives text link",
    async () => {
      currentHandler = defaultGatewayHandler;

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      const channelBridge: KoiMiddleware = {
        name: "e2e-channel-bridge",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          const result = await next(request);
          const output = result.output as {
            readonly a2ui?: {
              readonly kind: string;
              readonly surfaceId: string;
              readonly title?: string;
            };
          };
          if (output.a2ui !== undefined) {
            await channel.send({
              content: [
                makeCreateSurfaceBlock(output.a2ui.surfaceId, output.a2ui.title ?? "Untitled"),
              ],
            });
          }
          return result;
        },
      };

      const uiTool: Tool = {
        descriptor: {
          name: "create_ui",
          description: "Creates a UI surface.",
          inputSchema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
          },
        },
        trustTier: "sandbox",
        execute: async (args) => ({
          a2ui: {
            kind: "createSurface",
            surfaceId: "dashboard-1",
            title: String(args.title ?? "Untitled"),
          },
        }),
      };

      const { events, modelCallCount } = await runWithKoi({
        manifestName: "e2e-canvas-fallback",
        tool: uiTool,
        toolName: "create_ui",
        toolCallInput: { title: "Analytics Dashboard" },
        middleware: [channelBridge],
        prompt: "Create an analytics dashboard.",
      });

      // Agent completed
      const doneEvent = events.find((e) => e.kind === "done");
      expect(doneEvent).toBeDefined();
      if (doneEvent?.kind === "done") {
        expect(doneEvent.output.stopReason).toBe("completed");
      }

      // Gateway received POST with body containing surfaceId
      expect(gatewayLog.length).toBeGreaterThanOrEqual(1);
      const postCall = gatewayLog.find((l) => l.method === "POST");
      expect(postCall).toBeDefined();
      expect(postCall?.surfaceId).toBe("dashboard-1");
      expect(postCall?.body).toContain("dashboard-1");

      // Inner channel received a text link, not A2UI blocks
      expect(inner.sentMessages.length).toBeGreaterThanOrEqual(1);
      const block = inner.sentMessages[0]?.content[0];
      expect(block?.kind).toBe("text");
      if (block?.kind === "text") {
        expect(block.text).toContain("[Surface]");
        expect(block.text).toContain("Analytics Dashboard");
        expect(block.text).toContain(gatewayBaseUrl);
      }

      // Real LLM was called (phase 2)
      expect(modelCallCount).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  test(
    "full lifecycle: create → update → delete through middleware chain",
    async () => {
      currentHandler = defaultGatewayHandler;

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      const lifecycleTool: Tool = {
        descriptor: {
          name: "surface_lifecycle",
          description: "Creates, updates, then deletes a surface.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [makeCreateSurfaceBlock("surf-1", "My Surface")],
          });
          await channel.send({
            content: [makeUpdateComponentsBlock("surf-1")],
          });
          await channel.send({
            content: [makeDeleteSurfaceBlock("surf-1")],
          });
          return { status: "lifecycle complete" };
        },
      };

      const { modelCallCount } = await runWithKoi({
        manifestName: "e2e-canvas-lifecycle",
        tool: lifecycleTool,
        toolName: "surface_lifecycle",
        toolCallInput: {},
        prompt: "Run the surface lifecycle.",
      });

      // Gateway received all three operations: POST, PATCH, DELETE
      expect(gatewayLog.length).toBe(3);
      expect(gatewayLog[0]?.method).toBe("POST");
      expect(gatewayLog[0]?.surfaceId).toBe("surf-1");
      expect(gatewayLog[1]?.method).toBe("PATCH");
      expect(gatewayLog[1]?.surfaceId).toBe("surf-1");
      expect(gatewayLog[2]?.method).toBe("DELETE");
      expect(gatewayLog[2]?.surfaceId).toBe("surf-1");

      // Inner channel received 3 messages, all text (no A2UI)
      expect(inner.sentMessages.length).toBe(3);

      const createBlock = inner.sentMessages[0]?.content[0];
      expect(createBlock?.kind).toBe("text");
      if (createBlock?.kind === "text") {
        expect(createBlock.text).toContain("[Surface]");
        expect(createBlock.text).toContain("My Surface");
      }

      const updateBlock = inner.sentMessages[1]?.content[0];
      expect(updateBlock?.kind).toBe("text");
      if (updateBlock?.kind === "text") {
        expect(updateBlock.text).toContain("[Updated]");
      }

      const deleteBlock = inner.sentMessages[2]?.content[0];
      expect(deleteBlock?.kind).toBe("text");
      if (deleteBlock?.kind === "text") {
        expect(deleteBlock.text).toContain("[Removed]");
      }

      expect(modelCallCount).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  test(
    "mixed content: only A2UI blocks replaced, text and image preserved",
    async () => {
      currentHandler = defaultGatewayHandler;

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      const mixedTool: Tool = {
        descriptor: {
          name: "send_mixed",
          description: "Sends mixed content.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [
              { kind: "text", text: "Here is your dashboard:" },
              makeCreateSurfaceBlock("mixed-1", "Dashboard"),
              { kind: "image", url: "https://example.com/chart.png" },
            ],
          });
          return { sent: true };
        },
      };

      await runWithKoi({
        manifestName: "e2e-canvas-mixed",
        tool: mixedTool,
        toolName: "send_mixed",
        toolCallInput: {},
        prompt: "Send mixed content.",
      });

      expect(inner.sentMessages.length).toBe(1);
      const msg = inner.sentMessages[0];
      expect(msg).toBeDefined();
      if (msg === undefined) return;
      expect(msg.content.length).toBe(3);

      // Text preserved
      expect(msg.content[0]?.kind).toBe("text");
      if (msg.content[0]?.kind === "text") {
        expect(msg.content[0].text).toBe("Here is your dashboard:");
      }
      // A2UI replaced with text link
      expect(msg.content[1]?.kind).toBe("text");
      if (msg.content[1]?.kind === "text") {
        expect(msg.content[1].text).toContain("[Surface]");
      }
      // Image preserved
      expect(msg.content[2]?.kind).toBe("image");
      if (msg.content[2]?.kind === "image") {
        expect(msg.content[2].url).toBe("https://example.com/chart.png");
      }

      expect(gatewayLog.length).toBe(1);
      expect(gatewayLog[0]?.method).toBe("POST");
    },
    TIMEOUT_MS,
  );

  test(
    "Gateway failure produces degraded [Warning] text and fires onGatewayError",
    async () => {
      currentHandler = () => new Response("boom", { status: 500 });

      const gatewayErrors: Array<{
        readonly error: KoiError;
        readonly surfaceId: string;
      }> = []; // let justified: test accumulator

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const onGatewayError = mock((error: KoiError, surfaceId: string) => {
        gatewayErrors.push({ error, surfaceId });
      });
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
        onGatewayError,
      });

      const failTool: Tool = {
        descriptor: {
          name: "create_failing_ui",
          description: "Creates a UI that will fail at Gateway.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [makeCreateSurfaceBlock("fail-1", "Failing Dashboard")],
          });
          return { attempted: true };
        },
      };

      await runWithKoi({
        manifestName: "e2e-canvas-fail",
        tool: failTool,
        toolName: "create_failing_ui",
        toolCallInput: {},
        prompt: "Try creating a UI.",
      });

      // onGatewayError was called
      expect(onGatewayError).toHaveBeenCalledTimes(1);
      expect(gatewayErrors[0]?.surfaceId).toBe("fail-1");
      expect(gatewayErrors[0]?.error.code).toBe("EXTERNAL");
      expect(gatewayErrors[0]?.error.retryable).toBe(true);

      // Inner channel received degraded text
      expect(inner.sentMessages.length).toBe(1);
      const block = inner.sentMessages[0]?.content[0];
      expect(block?.kind).toBe("text");
      if (block?.kind === "text") {
        expect(block.text).toContain("[Warning]");
        expect(block.text).toContain("Failing Dashboard");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "channel with supportsA2ui: true passes A2UI blocks through unchanged",
    async () => {
      currentHandler = defaultGatewayHandler;

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeA2uiCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      // Decorator returns inner unchanged
      expect(channel).toBe(inner);

      const a2uiTool: Tool = {
        descriptor: {
          name: "send_a2ui",
          description: "Sends A2UI blocks to a capable channel.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [makeCreateSurfaceBlock("native-1", "Native Dashboard")],
          });
          return { sent: true };
        },
      };

      await runWithKoi({
        manifestName: "e2e-canvas-native",
        tool: a2uiTool,
        toolName: "send_a2ui",
        toolCallInput: {},
        prompt: "Send A2UI to native channel.",
      });

      // Gateway was NOT called
      expect(gatewayLog.length).toBe(0);

      // Inner channel received the original A2UI block unchanged
      expect(inner.sentMessages.length).toBe(1);
      const block = inner.sentMessages[0]?.content[0];
      expect(block?.kind).toBe("custom");
      if (block?.kind === "custom") {
        expect(block.type).toBe("a2ui:createSurface");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "no A2UI blocks: messages pass through without Gateway calls",
    async () => {
      currentHandler = defaultGatewayHandler;

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      const textTool: Tool = {
        descriptor: {
          name: "send_text",
          description: "Sends a plain text message.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [{ kind: "text", text: "Just plain text" }],
          });
          return { sent: true };
        },
      };

      await runWithKoi({
        manifestName: "e2e-canvas-passthrough",
        tool: textTool,
        toolName: "send_text",
        toolCallInput: {},
        prompt: "Send plain text.",
      });

      expect(gatewayLog.length).toBe(0);
      expect(inner.sentMessages.length).toBe(1);
      const block = inner.sentMessages[0]?.content[0];
      expect(block?.kind).toBe("text");
      if (block?.kind === "text") {
        expect(block.text).toBe("Just plain text");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "middleware wrapToolCall observes the full fallback pipeline",
    async () => {
      currentHandler = defaultGatewayHandler;
      const interceptedToolIds: string[] = []; // let justified: test accumulator

      const client = createGatewayClient({ canvasBaseUrl: gatewayBaseUrl });
      const inner = makeInnerChannel(makeTextOnlyCaps());
      const channel = createCanvasFallbackChannel(inner, {
        gatewayClient: client,
      });

      const uiTool: Tool = {
        descriptor: {
          name: "build_form",
          description: "Builds a form UI.",
          inputSchema: { type: "object", properties: {} },
        },
        trustTier: "sandbox",
        execute: async () => {
          await channel.send({
            content: [makeCreateSurfaceBlock("form-1", "Contact Form")],
          });
          return { surfaceId: "form-1" };
        },
      };

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          interceptedToolIds.push(request.toolId);
          return next(request);
        },
      };

      const { events } = await runWithKoi({
        manifestName: "e2e-canvas-middleware",
        tool: uiTool,
        toolName: "build_form",
        toolCallInput: {},
        middleware: [toolObserver],
        prompt: "Build me a form.",
      });

      // Agent completed
      expect(events.find((e) => e.kind === "done")).toBeDefined();

      // wrapToolCall intercepted the call
      expect(interceptedToolIds).toContain("build_form");

      // Gateway was called
      expect(gatewayLog.length).toBe(1);
      expect(gatewayLog[0]?.method).toBe("POST");

      // Channel received text link
      const block = inner.sentMessages[0]?.content[0];
      if (block?.kind === "text") {
        expect(block.text).toContain("[Surface]");
        expect(block.text).toContain("Contact Form");
      }

      // Engine events include tool call lifecycle
      expect(events.filter((e) => e.kind === "tool_call_start").length).toBeGreaterThan(0);
      expect(events.filter((e) => e.kind === "tool_call_end").length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
