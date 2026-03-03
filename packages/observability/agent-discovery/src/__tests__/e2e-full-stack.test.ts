/**
 * Full-stack E2E: createDiscoveryProvider wired into createKoi with both
 * createPiAdapter and createLoopAdapter, using real Anthropic API calls.
 *
 * Suite 1 (Pi adapter): Full tool-calling validation — LLM calls discover_agents,
 *   middleware intercepts, structured results verified, filter arguments tested.
 *
 * Suite 2 (Loop adapter): Runtime assembly validation — discovery provider attaches
 *   correctly, agent completes with provider wired, lifecycle hooks fire, state
 *   transitions are correct. (Tool calling not tested here because @koi/model-router's
 *   createAnthropicAdapter is text-only and does not support tool_use.)
 *
 * Suite 3: Cross-cutting — lifecycle hooks, multi-middleware, state transitions.
 *
 * Run:
 *   E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test src/__tests__/e2e-full-stack.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { EXTERNAL_AGENTS, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createPiAdapter } from "@koi/engine-pi";
import { createAnthropicAdapter } from "@koi/model-router";
import { createDiscoveryProvider } from "../component-provider.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";

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

function testManifest(suffix: string): AgentManifest {
  return {
    name: `E2E Agent-Discovery ${suffix}`,
    version: "0.1.0",
    model: { name: "claude-haiku-4-5" },
  };
}

/** Create a ModelHandler from the Anthropic adapter for use with createLoopAdapter. */
function createModelCall(): (req: ModelRequest) => Promise<ReturnType<typeof Object>> {
  const anthropic = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (req: ModelRequest) => anthropic.complete({ ...req, model: HAIKU_MODEL_ID });
}

// ---------------------------------------------------------------------------
// Suite 1: createPiAdapter — full tool-calling through L1 runtime
// ---------------------------------------------------------------------------

describeE2E("e2e: agent-discovery + createPiAdapter (tool calling)", () => {
  test(
    "discover_agents tool is callable through createKoi + createPiAdapter",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You have a discover_agents tool. When asked about agents, you MUST use it. Always use the tool, never guess.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi"),
        adapter,
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the discover_agents tool to find all available external coding agents. Report what you find.",
        }),
      );

      // tool_call_start for discover_agents must appear
      const toolStarts = events.filter(
        (e) => e.kind === "tool_call_start" && "toolName" in e && e.toolName === "discover_agents",
      );
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // done event with completed stop reason
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Response text mentions agents or results
      const text = extractText(events);
      const mentionsAgents =
        text.toLowerCase().includes("agent") ||
        text.toLowerCase().includes("found") ||
        text.toLowerCase().includes("discover") ||
        text.toLowerCase().includes("available") ||
        text.toLowerCase().includes("no ");
      expect(mentionsAgents).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "middleware observes discover_agents tool call (pi adapter)",
    async () => {
      const observedToolIds: string[] = [];

      const observerMiddleware: KoiMiddleware = {
        name: "pi-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          observedToolIds.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the discover_agents tool when asked about agents. Always call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-mw"),
        adapter,
        middleware: [observerMiddleware],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the discover_agents tool to list available agents.",
        }),
      );

      expect(observedToolIds).toContain("discover_agents");
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "tool returns structured agent descriptors (pi adapter)",
    async () => {
      // let justified: capture tool result for structural assertions
      let capturedResult: unknown;

      const resultCapture: KoiMiddleware = {
        name: "pi-result-capture",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          const response = await next(request);
          if (request.toolId === "discover_agents") {
            capturedResult = response.output;
          }
          return response;
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Use discover_agents when asked. Always call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-struct"),
        adapter,
        middleware: [resultCapture],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use discover_agents to find all agents.",
        }),
      );

      expect(capturedResult).toBeDefined();

      const parsed =
        typeof capturedResult === "string"
          ? (JSON.parse(capturedResult) as {
              agents: readonly Record<string, unknown>[];
              count: number;
            })
          : (capturedResult as {
              agents: readonly Record<string, unknown>[];
              count: number;
            });

      expect(typeof parsed.count).toBe("number");
      expect(Array.isArray(parsed.agents)).toBe(true);

      if (parsed.agents.length > 0) {
        const first = parsed.agents[0];
        expect(first).toBeDefined();
        if (first !== undefined) {
          expect(typeof first.name).toBe("string");
          expect(typeof first.transport).toBe("string");
        }
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "discover_agents works with filter arguments (pi adapter)",
    async () => {
      const capturedArgs: Record<string, unknown>[] = [];

      const argsCapture: KoiMiddleware = {
        name: "pi-args-capture",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          if (request.toolId === "discover_agents") {
            capturedArgs.push({ ...(request.input as Record<string, unknown>) });
          }
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the discover_agents tool with the transport filter set to 'cli' when asked to find CLI agents. Always pass transport: 'cli' as an argument.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-filter"),
        adapter,
        middleware: [argsCapture],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use discover_agents to find agents with transport type cli only. Pass transport: 'cli' as the filter.",
        }),
      );

      expect(capturedArgs.length).toBeGreaterThanOrEqual(1);
      const discoverCall = capturedArgs.find((a) => a.transport === "cli");
      expect(discoverCall).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Suite 2: createLoopAdapter — runtime assembly + text completion
//
// NOTE: @koi/model-router's createAnthropicAdapter is a text-only adapter.
// It does not send tool descriptors to the API and does not parse tool_use
// responses. Therefore createLoopAdapter cannot trigger tool calls here.
// These tests validate that the discovery provider attaches correctly and
// the L1 runtime completes successfully with the provider wired in.
// ---------------------------------------------------------------------------

describeE2E("e2e: agent-discovery + createLoopAdapter (runtime assembly)", () => {
  test(
    "createKoi assembles successfully with discovery provider + loop adapter",
    async () => {
      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest("loop-assembly"),
        adapter,
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      // Agent assembled in created state
      expect(runtime.agent.state).toBe("created");

      // discover_agents tool is attached as a component
      const toolKey = toolToken("discover_agents");
      expect(runtime.agent.has(toolKey)).toBe(true);

      // EXTERNAL_AGENTS singleton is attached
      expect(runtime.agent.has(EXTERNAL_AGENTS)).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "text completion succeeds through loop adapter with discovery provider attached",
    async () => {
      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest("loop-text"),
        adapter,
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Reply with exactly one word: hello",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.turns).toBeGreaterThanOrEqual(1);

      const text = extractText(events);
      expect(text.toLowerCase()).toContain("hello");

      expect(runtime.agent.state).toBe("terminated");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "lifecycle hooks fire with discovery provider (loop adapter)",
    async () => {
      const hookOrder: string[] = [];

      const lifecycleObserver: KoiMiddleware = {
        name: "loop-lifecycle-observer",
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

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest("loop-lifecycle"),
        adapter,
        middleware: [lifecycleObserver],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Say: OK" }));

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multiple middleware layers compose with discovery provider (loop adapter)",
    async () => {
      const outerHooksCalled: string[] = [];
      const innerHooksCalled: string[] = [];

      const outerMiddleware: KoiMiddleware = {
        name: "outer-lifecycle",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          outerHooksCalled.push("session_start");
        },
        onSessionEnd: async () => {
          outerHooksCalled.push("session_end");
        },
      };

      const innerMiddleware: KoiMiddleware = {
        name: "inner-lifecycle",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          innerHooksCalled.push("session_start");
        },
        onSessionEnd: async () => {
          innerHooksCalled.push("session_end");
        },
      };

      const modelCall = createModelCall();
      const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest("loop-multi-mw"),
        adapter,
        middleware: [outerMiddleware, innerMiddleware],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(runtime.run({ kind: "text", text: "Reply with: OK" }));

      // Both middleware layers must have fired session lifecycle hooks
      expect(outerHooksCalled).toContain("session_start");
      expect(outerHooksCalled).toContain("session_end");
      expect(innerHooksCalled).toContain("session_start");
      expect(innerHooksCalled).toContain("session_end");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Suite 3: Cross-cutting concerns (pi adapter — full tool flow)
// ---------------------------------------------------------------------------

describeE2E("e2e: agent-discovery cross-cutting concerns", () => {
  test(
    "session lifecycle hooks fire with discovery tool call (pi adapter)",
    async () => {
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

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Use discover_agents when asked. Always call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-lifecycle"),
        adapter,
        middleware: [lifecycleObserver],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use discover_agents to find agents, then summarize.",
        }),
      );

      expect(hookOrder[0]).toBe("session_start");
      expect(hookOrder[hookOrder.length - 1]).toBe("session_end");
      expect(hookOrder).toContain("after_turn");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "agent state transitions correctly with discovery provider (pi adapter)",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Use discover_agents when asked. Always call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-state"),
        adapter,
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      // Before run: agent is in created state
      expect(runtime.agent.state).toBe("created");

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use discover_agents to find agents.",
        }),
      );

      // After run: agent is terminated
      expect(runtime.agent.state).toBe("terminated");

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multiple middleware layers all observe discover_agents tool call (pi adapter)",
    async () => {
      const layer1Calls: string[] = [];
      const layer2Calls: string[] = [];

      const outerMiddleware: KoiMiddleware = {
        name: "outer-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          layer1Calls.push(request.toolId);
          return next(request);
        },
      };

      const innerMiddleware: KoiMiddleware = {
        name: "inner-tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          layer2Calls.push(request.toolId);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the discover_agents tool when asked about agents. Always call the tool.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest("pi-multi-mw"),
        adapter,
        middleware: [outerMiddleware, innerMiddleware],
        providers: [createDiscoveryProvider()],
        loopDetection: false,
      });

      await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use discover_agents to find all available agents.",
        }),
      );

      // Both middleware layers must have seen the tool call
      expect(layer1Calls).toContain("discover_agents");
      expect(layer2Calls).toContain("discover_agents");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
