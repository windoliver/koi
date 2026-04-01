/**
 * Capability Registry E2E — validates Issue #180 changes through the full
 * createKoi + createPiAdapter / createLoopAdapter runtime stack with real LLM calls.
 *
 * What this validates end-to-end:
 * - L0 shared types (AdvertisedTool, ToolCallPayload, isToolCallPayload) work across packages
 * - Tool registration via ComponentProvider + toolToken
 * - Tool calling through the full middleware chain (wrapToolCall)
 * - Lifecycle hooks (onSessionStart/End, onBeforeTurn/AfterTurn)
 * - Pi agent streaming middleware (wrapModelStream)
 * - Loop adapter with deterministic tool call + real LLM follow-up
 * - Multiple tools with capacity-based selection validation
 * - Gateway tool router unit integration (mock transport, real tool routing logic)
 * - Dynamic tool re-advertisement (node:tools_updated → queue drain)
 *
 * Gated on ANTHROPIC_API_KEY — tests are skipped when the key is not set.
 *
 * Run:
 *   bun test tests/e2e/capability-registry-e2e.test.ts
 *
 * Cost: ~$0.05-0.10 per run (haiku model, minimal prompts).
 */

import { describe, expect, test } from "bun:test";
import type {
  AdvertisedTool,
  CapacityReport,
  ComponentProvider,
  EngineEvent,
  JsonObject,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  Tool,
  ToolHandler,
  ToolRequest,
} from "@koi/core";
import { isToolCallPayload } from "@koi/core";
import { toolToken } from "@koi/core/ecs";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const describeLLM = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 60_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const MODEL_NAME = "claude-haiku-4-5-20251001";

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

function createWeatherTool(): Tool {
  return {
    descriptor: {
      name: "get_weather",
      description: "Get current weather for a city. Returns temperature and condition.",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
    trustTier: "sandbox",
    execute: async (input: JsonObject) => {
      const city = typeof input.city === "string" ? input.city : "unknown";
      return { city, temperature: "22C", condition: "sunny", source: "mock" };
    },
  };
}

function createSearchTool(): Tool {
  return {
    descriptor: {
      name: "web_search",
      description: "Search the web for information. Returns a list of results.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
    trustTier: "sandbox",
    execute: async (input: JsonObject) => {
      const query = typeof input.query === "string" ? input.query : "";
      return {
        results: [
          { title: `Result for: ${query}`, url: "https://example.com/1", snippet: "Mock result" },
        ],
      };
    },
  };
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-capability-tools",
    attach: async () => {
      const components = new Map<string, unknown>();
      for (const tool of tools) {
        components.set(toolToken(tool.descriptor.name), tool);
      }
      return components;
    },
  };
}

// ===========================================================================
// 1. L0 shared types work across package boundaries
// ===========================================================================

describe("L0 shared types", () => {
  test("isToolCallPayload validates correct payloads", () => {
    const valid = { toolName: "get_weather", args: { city: "Tokyo" }, callerAgentId: "agent-1" };
    expect(isToolCallPayload(valid)).toBe(true);
  });

  test("isToolCallPayload rejects malformed payloads", () => {
    expect(isToolCallPayload(null)).toBe(false);
    expect(isToolCallPayload({})).toBe(false);
    expect(isToolCallPayload({ toolName: "" })).toBe(false);
    expect(isToolCallPayload({ toolName: "x" })).toBe(false); // missing callerAgentId
    expect(isToolCallPayload({ toolName: 42, callerAgentId: "a" })).toBe(false);
  });

  test("AdvertisedTool shape is importable and usable from @koi/core", () => {
    const tool: AdvertisedTool = {
      name: "test_tool",
      description: "A test tool",
      schema: { type: "object" },
    };
    expect(tool.name).toBe("test_tool");
    expect(tool.description).toBe("A test tool");
  });

  test("CapacityReport shape is importable and usable from @koi/core", () => {
    const report: CapacityReport = { current: 3, max: 10, available: 7 };
    expect(report.available).toBe(7);
  });
});

// ===========================================================================
// 2. Pi agent with single tool — full stack through real LLM
// ===========================================================================

describeLLM("e2e: Pi agent with tool calling (capability registry types)", () => {
  test(
    "Pi agent calls get_weather tool and generates response using tool result",
    async () => {
      const weatherTool = createWeatherTool();
      const toolProvider = createToolProvider([weatherTool]);

      let toolWasCalled = false; // let justified: toggled in middleware
      const interceptedTools: string[] = []; // let justified: test accumulator
      const textChunks: string[] = []; // let justified: test accumulator

      const toolObserver: KoiMiddleware = {
        name: "e2e-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          interceptedTools.push(request.toolId);
          toolWasCalled = true;
          return next(request);
        },
      };

      const textObserver: KoiMiddleware = {
        name: "e2e-text-observer",
        priority: 100,
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          for await (const chunk of next(request)) {
            if (chunk.kind === "text_delta") {
              textChunks.push(chunk.delta);
            }
            yield chunk;
          }
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You are a weather assistant. When asked about weather, ALWAYS use the get_weather tool. After getting the result, summarize it briefly.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-capability-weather",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [toolProvider],
        middleware: [toolObserver, textObserver],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Tokyo?" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
          expect(doneEvent.output.metrics.turns).toBeGreaterThan(0);
        }

        // Tool was called through the middleware chain
        expect(toolWasCalled).toBe(true);
        expect(interceptedTools).toContain("get_weather");

        // Tool call events were emitted
        const toolStartEvents = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStartEvents.length).toBeGreaterThan(0);
        if (toolStartEvents[0]?.kind === "tool_call_start") {
          expect(toolStartEvents[0].toolName).toBe("get_weather");
        }
        const toolEndEvents = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEndEvents.length).toBeGreaterThan(0);

        // LLM generated text (observed via wrapModelStream)
        expect(textChunks.length).toBeGreaterThan(0);
        const fullText = textChunks.join("");
        expect(fullText.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 3. Pi agent with multiple tools — validates tool descriptor discovery
// ===========================================================================

describeLLM("e2e: Pi agent with multiple tools", () => {
  test(
    "Pi agent selects correct tool from multiple options",
    async () => {
      const weatherTool = createWeatherTool();
      const searchTool = createSearchTool();
      const toolProvider = createToolProvider([weatherTool, searchTool]);

      const calledTools: string[] = []; // let justified: test accumulator

      const toolObserver: KoiMiddleware = {
        name: "e2e-multi-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          calledTools.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You have two tools: get_weather (for weather queries) and web_search (for general queries). Use the correct tool based on the question. After using the tool, give a brief answer.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-capability-multi-tool",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [toolProvider],
        middleware: [toolObserver],
      });

      try {
        const events = await collectEvents(
          runtime.run({
            kind: "text",
            text: "Search the web for TypeScript best practices",
          }),
        );

        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // LLM chose the search tool (not weather)
        expect(calledTools).toContain("web_search");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 4. Loop adapter with deterministic tool call + real LLM follow-up
// ===========================================================================

describeLLM("e2e: Loop adapter tool calling (capability types)", () => {
  test(
    "deterministic tool call phase 1 + real LLM phase 2 through middleware",
    async () => {
      const weatherTool = createWeatherTool();
      const _toolProvider = createToolProvider([weatherTool]);

      let toolExecuted = false; // let justified: toggled in execute
      let modelCallCount = 0; // let justified: tracks call phases
      const interceptedTools: string[] = []; // let justified: test accumulator

      const toolObserver: KoiMiddleware = {
        name: "e2e-loop-tool-observer",
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          interceptedTools.push(request.toolId);
          return next(request);
        },
      };

      // Two-phase model handler:
      //   Call 1: deterministic tool call (tests tool dispatch)
      //   Call 2: real Anthropic LLM generates answer using tool result
      const modelCall = async (request: ModelRequest): Promise<ModelResponse> => {
        modelCallCount++;
        if (modelCallCount === 1) {
          return {
            content: "Let me check the weather for you.",
            model: MODEL_NAME,
            usage: { inputTokens: 10, outputTokens: 15 },
            metadata: {
              toolCalls: [
                { toolName: "get_weather", callId: "call-e2e-cap-1", input: { city: "Tokyo" } },
              ],
            },
          };
        }
        // Real LLM call — model sees tool result in context
        const { createAnthropicAdapter } = await import("@koi/model-router");
        const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
        return anthropic.complete({ ...request, model: MODEL_NAME, maxTokens: 150 });
      };

      const weatherToolWithTracking: Tool = {
        ...weatherTool,
        execute: async (input: JsonObject) => {
          toolExecuted = true;
          return weatherTool.execute(input);
        },
      };

      const trackedProvider = createToolProvider([weatherToolWithTracking]);

      const { createLoopAdapter } = await import("@koi/engine-loop");
      const adapter = createLoopAdapter({ modelCall, maxTurns: 5 });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-loop-capability",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        middleware: [toolObserver],
        providers: [trackedProvider],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Tokyo?" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Tool executed through the full chain
        expect(toolExecuted).toBe(true);
        expect(interceptedTools).toContain("get_weather");

        // Two model calls: deterministic + real LLM
        expect(modelCallCount).toBeGreaterThanOrEqual(2);

        // Tool call events emitted
        const toolStarts = events.filter((e) => e.kind === "tool_call_start");
        expect(toolStarts.length).toBeGreaterThan(0);
        const toolEnds = events.filter((e) => e.kind === "tool_call_end");
        expect(toolEnds.length).toBeGreaterThan(0);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 5. Full lifecycle + middleware composition with tools
// ===========================================================================

describeLLM("e2e: Full middleware chain with capability tools", () => {
  test(
    "lifecycle hooks + wrapToolCall + wrapModelStream compose correctly",
    async () => {
      const weatherTool = createWeatherTool();
      const toolProvider = createToolProvider([weatherTool]);

      const hookLog: string[] = []; // let justified: test accumulator

      const lifecycle: KoiMiddleware = {
        name: "e2e-cap-lifecycle",
        priority: 100,
        onSessionStart: async () => {
          hookLog.push("session:start");
        },
        onBeforeTurn: async (ctx) => {
          hookLog.push(`turn:before:${String(ctx.turnIndex)}`);
        },
        onAfterTurn: async (ctx) => {
          hookLog.push(`turn:after:${String(ctx.turnIndex)}`);
        },
        onSessionEnd: async () => {
          hookLog.push("session:end");
        },
        wrapToolCall: async (_ctx, request: ToolRequest, next: ToolHandler) => {
          hookLog.push(`tool:${request.toolId}`);
          return next(request);
        },
        wrapModelStream: async function* (_ctx, request, next: ModelStreamHandler) {
          hookLog.push("stream:start");
          for await (const chunk of next(request)) {
            yield chunk;
          }
          hookLog.push("stream:end");
        },
      };

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You are a weather assistant. ALWAYS use the get_weather tool when asked about weather. After getting the result, summarize it in one sentence.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-cap-full-chain",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [toolProvider],
        middleware: [lifecycle],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in London?" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Lifecycle order: session:start → turn:before → ... → turn:after → session:end
        expect(hookLog.at(0)).toBe("session:start");
        expect(hookLog.at(-1)).toBe("session:end");
        expect(hookLog).toContain("turn:before:0");

        // Streaming middleware intercepted Pi's model call
        // Note: Pi may abort the generator early, so stream:end is not guaranteed.
        // stream:start is sufficient to prove wrapModelStream was invoked.
        expect(hookLog).toContain("stream:start");

        // Tool was intercepted through wrapToolCall
        expect(hookLog).toContain("tool:get_weather");

        // Correct ordering: session:start before any turn, tool after stream
        const sessionStartIdx = hookLog.indexOf("session:start");
        const firstTurnIdx = hookLog.indexOf("turn:before:0");
        expect(sessionStartIdx).toBeLessThan(firstTurnIdx);
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});

// ===========================================================================
// 6. Gateway tool router integration (no real LLM, validates routing logic)
// ===========================================================================

describe("Gateway tool router with L0 types", () => {
  test("resolveTargetNode uses AdvertisedTool from @koi/core", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { resolveTargetNode } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    // Register nodes using AdvertisedTool shape from @koi/core
    const toolA: AdvertisedTool = { name: "search", description: "Search tool" };
    const toolB: AdvertisedTool = { name: "camera.capture", description: "Camera tool" };

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [toolA],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [toolB],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    // Route from node-a to node-b (camera.capture)
    const result = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-b");
    }
  });

  test("updateTools uses AdvertisedTool from @koi/core for dynamic re-advertisement", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { resolveTargetNode } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [{ name: "browse" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    // camera.capture not available yet
    const before = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(before.kind).toBe("not_available");

    // Dynamic re-advertisement: node-b adds camera.capture
    const updateResult = registry.updateTools(
      "node-b",
      [{ name: "camera.capture", description: "Capture photos" }],
      [],
    );
    expect(updateResult.ok).toBe(true);

    // Now camera.capture routes to node-b
    const after = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(after.kind).toBe("routed");
    if (after.kind === "routed") {
      expect(after.targetNodeId).toBe("node-b");
    }
  });

  test("updateTools removes tools and routing reflects the change", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { resolveTargetNode } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [{ name: "code" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [{ name: "search" }, { name: "camera.capture" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    // camera.capture routes to node-b
    const before = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(before.kind).toBe("routed");

    // node-b withdraws camera.capture
    registry.updateTools("node-b", [], ["camera.capture"]);

    // camera.capture no longer available
    const after = resolveTargetNode("camera.capture", "node-a", registry, []);
    expect(after.kind).toBe("not_available");
  });

  test("capacity-based routing selects highest-capacity node", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { resolveTargetNode } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "source",
      mode: "full",
      tools: [{ name: "code" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-source",
    });

    registry.register({
      nodeId: "node-low",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 8, max: 10, available: 2 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-low",
    });

    registry.register({
      nodeId: "node-high",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 1, max: 10, available: 9 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-high",
    });

    const result = resolveTargetNode("search", "source", registry, []);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      expect(result.targetNodeId).toBe("node-high");
    }
  });

  test("affinity routing overrides capacity", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { resolveTargetNode, compileAffinities } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "source",
      mode: "full",
      tools: [{ name: "code" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-source",
    });

    registry.register({
      nodeId: "preferred",
      mode: "full",
      tools: [{ name: "camera.capture" }],
      capacity: { current: 8, max: 10, available: 2 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-preferred",
    });

    registry.register({
      nodeId: "high-cap",
      mode: "full",
      tools: [{ name: "camera.capture" }],
      capacity: { current: 1, max: 10, available: 9 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-high",
    });

    const affinities = compileAffinities([{ pattern: "camera.*", nodeId: "preferred" }]);
    const result = resolveTargetNode("camera.capture", "source", registry, affinities);
    expect(result.kind).toBe("routed");
    if (result.kind === "routed") {
      // Affinity wins over capacity
      expect(result.targetNodeId).toBe("preferred");
    }
  });
});

// ===========================================================================
// 7. Full gateway tool router E2E with mock transport
// ===========================================================================

describe("Gateway tool router full flow (mock transport)", () => {
  test("tool_call routed, executed, result returned via full createToolRouter", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { createToolRouter, DEFAULT_TOOL_ROUTING_CONFIG, TOOL_ROUTING_ERROR_CODES } =
      await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [{ name: "camera.capture" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    const sentFrames: Array<{ readonly nodeId: string; readonly frame: unknown }> = [];

    const router = createToolRouter(
      { ...DEFAULT_TOOL_ROUTING_CONFIG, maxQueuedCalls: 10 },
      {
        registry,
        sendToNode: (nodeId, frame) => {
          sentFrames.push({ nodeId, frame });
          return { ok: true, value: 1 };
        },
      },
    );

    // Node-A sends a tool_call for camera.capture
    router.handleToolCall({
      kind: "tool_call",
      nodeId: "node-a",
      agentId: "agent-1",
      correlationId: "corr-e2e-1",
      payload: { toolName: "camera.capture", args: {}, callerAgentId: "agent-1" },
    });

    expect(router.pendingCount()).toBe(1);

    // Verify frame was forwarded to node-b
    const forwarded = sentFrames.find(
      (s) => s.nodeId === "node-b" && (s.frame as { kind: string }).kind === "tool_call",
    );
    expect(forwarded).toBeDefined();

    const forwardedFrame = forwarded?.frame as { correlationId: string };
    expect(forwardedFrame.correlationId).toMatch(/^route-/);

    // Node-B responds with tool_result
    router.handleToolResult({
      kind: "tool_result",
      nodeId: "node-b",
      agentId: "agent-1",
      correlationId: forwardedFrame.correlationId,
      payload: { toolName: "camera.capture", result: { photo: "base64data" } },
    });

    expect(router.pendingCount()).toBe(0);

    // Verify result was sent back to node-a with original correlationId
    const resultFrame = sentFrames.find(
      (s) => s.nodeId === "node-a" && (s.frame as { kind: string }).kind === "tool_result",
    );
    expect(resultFrame).toBeDefined();
    expect((resultFrame?.frame as { correlationId: string }).correlationId).toBe("corr-e2e-1");

    // Verify error codes are typed
    expect(TOOL_ROUTING_ERROR_CODES.NOT_FOUND).toBe("not_found");
    expect(TOOL_ROUTING_ERROR_CODES.TIMEOUT).toBe("timeout");
    expect(TOOL_ROUTING_ERROR_CODES.RATE_LIMIT).toBe("rate_limit");
    expect(TOOL_ROUTING_ERROR_CODES.VALIDATION).toBe("validation");

    router.dispose();
  });

  test("queue drains when node registers with needed tool", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { createToolRouter, DEFAULT_TOOL_ROUTING_CONFIG } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    const sentFrames: Array<{ readonly nodeId: string; readonly frame: unknown }> = [];

    const router = createToolRouter(
      { ...DEFAULT_TOOL_ROUTING_CONFIG, maxQueuedCalls: 10 },
      {
        registry,
        sendToNode: (nodeId, frame) => {
          sentFrames.push({ nodeId, frame });
          return { ok: true, value: 1 };
        },
      },
    );

    // Tool call for camera.capture — no node has it yet → queued
    router.handleToolCall({
      kind: "tool_call",
      nodeId: "node-a",
      agentId: "agent-1",
      correlationId: "corr-queued-e2e",
      payload: { toolName: "camera.capture", args: {}, callerAgentId: "agent-1" },
    });

    expect(router.queuedCount()).toBe(1);
    expect(router.pendingCount()).toBe(0);

    // No error sent — call is queued
    const errorBefore = sentFrames.find((s) => (s.frame as { kind: string }).kind === "tool_error");
    expect(errorBefore).toBeUndefined();

    // Node-B registers with camera.capture
    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [{ name: "camera.capture" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    // Trigger queue drain
    router.handleNodeRegistered("node-b");

    // Queued call was dequeued and routed
    expect(router.queuedCount()).toBe(0);
    expect(router.pendingCount()).toBe(1);

    const forwarded = sentFrames.find(
      (s) => s.nodeId === "node-b" && (s.frame as { kind: string }).kind === "tool_call",
    );
    expect(forwarded).toBeDefined();

    router.dispose();
  });

  test("queue drains on handleToolsUpdated (dynamic re-advertisement)", async () => {
    const { createInMemoryNodeRegistry } = await import("@koi/gateway");
    const { createToolRouter, DEFAULT_TOOL_ROUTING_CONFIG } = await import("@koi/gateway");

    const registry = createInMemoryNodeRegistry();

    registry.register({
      nodeId: "node-a",
      mode: "full",
      tools: [{ name: "search" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-a",
    });

    registry.register({
      nodeId: "node-b",
      mode: "full",
      tools: [{ name: "browse" }],
      capacity: { current: 0, max: 10, available: 10 },
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connId: "conn-b",
    });

    const sentFrames: Array<{ readonly nodeId: string; readonly frame: unknown }> = [];

    const router = createToolRouter(
      { ...DEFAULT_TOOL_ROUTING_CONFIG, maxQueuedCalls: 10 },
      {
        registry,
        sendToNode: (nodeId, frame) => {
          sentFrames.push({ nodeId, frame });
          return { ok: true, value: 1 };
        },
      },
    );

    // Queue a tool call for camera.capture (nobody has it)
    router.handleToolCall({
      kind: "tool_call",
      nodeId: "node-a",
      agentId: "agent-1",
      correlationId: "corr-tools-updated-e2e",
      payload: { toolName: "camera.capture", args: {}, callerAgentId: "agent-1" },
    });

    expect(router.queuedCount()).toBe(1);

    // Node-B dynamically adds camera.capture (tools_updated)
    registry.updateTools("node-b", [{ name: "camera.capture" }], []);

    // Trigger queue drain via handleToolsUpdated (Phase 3 feature)
    router.handleToolsUpdated("node-b");

    // Call was dequeued and routed to node-b
    expect(router.queuedCount()).toBe(0);
    expect(router.pendingCount()).toBe(1);

    const forwarded = sentFrames.find(
      (s) => s.nodeId === "node-b" && (s.frame as { kind: string }).kind === "tool_call",
    );
    expect(forwarded).toBeDefined();

    router.dispose();
  });
});

// ===========================================================================
// 8. Pi agent with audit middleware + tools (full middleware stack)
// ===========================================================================

describeLLM("e2e: Pi agent audit middleware + tools", () => {
  test(
    "audit captures tool calls and session lifecycle with real LLM",
    async () => {
      const { createAuditMiddleware, createInMemoryAuditSink } = await import(
        "@koi/middleware-audit"
      );
      const weatherTool = createWeatherTool();
      const toolProvider = createToolProvider([weatherTool]);
      const auditSink = createInMemoryAuditSink();
      const audit = createAuditMiddleware({ sink: auditSink });

      const adapter = createPiAdapter({
        model: PI_MODEL,
        systemPrompt:
          "You are a weather assistant. ALWAYS use the get_weather tool when asked about weather. After getting the result, summarize it.",
        getApiKey: async () => ANTHROPIC_KEY,
        thinkingLevel: "off",
      });

      const runtime = await createKoi({
        manifest: {
          name: "e2e-cap-audit",
          version: "0.0.1",
          model: { name: MODEL_NAME },
        },
        adapter,
        providers: [toolProvider],
        middleware: [audit],
      });

      try {
        const events = await collectEvents(
          runtime.run({ kind: "text", text: "What is the weather in Paris?" }),
        );

        // Agent completed
        const doneEvent = events.find((e) => e.kind === "done");
        expect(doneEvent).toBeDefined();
        if (doneEvent?.kind === "done") {
          expect(doneEvent.output.stopReason).toBe("completed");
        }

        // Audit captured session lifecycle
        const kinds = auditSink.entries.map((e) => e.kind);
        expect(kinds).toContain("session_start");
        expect(kinds).toContain("session_end");

        // Audit captured tool call event (tool was invoked)
        expect(kinds).toContain("tool_call");
      } finally {
        await runtime.dispose?.();
      }
    },
    TIMEOUT_MS,
  );
});
