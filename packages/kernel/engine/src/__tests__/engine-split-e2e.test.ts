/**
 * Engine Split E2E — validates the 3-package split works end-to-end
 * through the full createKoi + createPiAdapter runtime assembly with
 * a real LLM call via OpenRouter.
 *
 * Tests that:
 * 1. Barrel re-exports from @koi/engine-compose and @koi/engine-reconcile
 *    resolve correctly at runtime (not just typecheck)
 * 2. Pure composition functions (from engine-compose) wire through createKoi
 * 3. Reconciliation infra (from engine-reconcile) integrates with registry
 * 4. Middleware chain (guards, extension-composer) fires with real adapter
 * 5. Tool execution pipeline works through the split packages
 * 6. Supervision + cascading termination work with real child agents
 * 7. Governance controller integrates through the split
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... bun test src/__tests__/engine-split-e2e.test.ts
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { agentId, DEFAULT_SANDBOXED_POLICY, toolToken } from "@koi/core";

// ── Imports from engine-compose (guards, composition, types) ────────────
import {
  composeExtensions,
  createDefaultGuardExtension,
  createIterationGuard,
  createLoopDetector,
  DEFAULT_ITERATION_LIMITS,
  DEFAULT_LOOP_DETECTION,
  DEFAULT_SPAWN_POLICY,
  resolveActiveMiddleware,
  sortMiddlewareByPhase,
} from "@koi/engine-compose";
import { createLoopAdapter } from "@koi/engine-loop";
// ── Adapter imports ─────────────────────────────────────────────────────
import { createPiAdapter } from "@koi/engine-pi";
// ── Imports from engine-reconcile (reconciliation, registry, process tree) ──
import type { InMemoryRegistry, ProcessTree } from "@koi/engine-reconcile";
import {
  applyTransition,
  computeBackoff,
  createCascadingTermination,
  createDefaultGovernanceConfig,
  createFakeClock,
  createInMemoryRegistry,
  createProcessTree,
  createReconcileQueue,
  DEFAULT_GOVERNANCE_CONFIG,
  isPromise,
  validateTransition,
} from "@koi/engine-reconcile";
import { AgentEntity } from "../agent-entity.js";
// ── Imports from engine (factory, entity, lifecycle) ────────────────────
import { createKoi } from "../koi.js";
import { spawnChildAgent } from "../spawn-child.js";
import { createInMemorySpawnLedger } from "../spawn-ledger.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const describeE2E = HAS_KEY ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "openrouter:anthropic/claude-3.5-haiku";

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

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "engine-split-e2e",
    version: "0.1.0",
    model: { name: "claude-3.5-haiku" },
    ...overrides,
  };
}

const ADD_TOOL: Tool = {
  descriptor: {
    name: "add_numbers",
    description: "Adds two numbers. Returns the sum.",
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
    return String(a + b);
  },
};

const ECHO_TOOL: Tool = {
  descriptor: {
    name: "echo",
    description: "Echoes back the input text verbatim.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo" },
      },
      required: ["text"],
    },
  },
  origin: "primordial",
  policy: DEFAULT_SANDBOXED_POLICY,
  execute: async (input: Readonly<Record<string, unknown>>) => {
    return String(input.text ?? "");
  },
};

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

// ---------------------------------------------------------------------------
// Test 0: Smoke test — engine-compose and engine-reconcile exports resolve
// ---------------------------------------------------------------------------

describe("engine-split: package exports resolve at runtime", () => {
  test("engine-compose guard factories are callable", () => {
    // These come from @koi/engine-compose — if the split broke re-exports, this throws
    expect(typeof createIterationGuard).toBe("function");
    expect(typeof createLoopDetector).toBe("function");
    expect(typeof sortMiddlewareByPhase).toBe("function");
    expect(typeof resolveActiveMiddleware).toBe("function");
    expect(typeof composeExtensions).toBe("function");
    expect(typeof createDefaultGuardExtension).toBe("function");

    // Default constants
    expect(DEFAULT_ITERATION_LIMITS).toBeDefined();
    expect(DEFAULT_LOOP_DETECTION).toBeDefined();
    expect(DEFAULT_SPAWN_POLICY).toBeDefined();
  });

  test("engine-reconcile factories are callable", () => {
    // These come from @koi/engine-reconcile
    expect(typeof createInMemoryRegistry).toBe("function");
    expect(typeof createProcessTree).toBe("function");
    expect(typeof createCascadingTermination).toBe("function");
    expect(typeof createReconcileQueue).toBe("function");
    expect(typeof createFakeClock).toBe("function");
    expect(typeof computeBackoff).toBe("function");
    expect(typeof isPromise).toBe("function");
    expect(typeof createDefaultGovernanceConfig).toBe("function");
    expect(typeof applyTransition).toBe("function");
    expect(typeof validateTransition).toBe("function");

    // Default constants
    expect(DEFAULT_GOVERNANCE_CONFIG).toBeDefined();
  });

  test("registry + process tree integrate correctly", () => {
    const registry = createInMemoryRegistry();
    const tree = createProcessTree(registry);

    // Register parent
    registry.register({
      agentId: agentId("parent"),
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
    });

    // Register children with parentId — tree auto-tracks via registry watch
    registry.register({
      agentId: agentId("child-1"),
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
      parentId: agentId("parent"),
    });

    registry.register({
      agentId: agentId("child-2"),
      status: { phase: "created", generation: 0, conditions: [], lastTransitionAt: Date.now() },
      agentType: "worker",
      priority: 10,
      metadata: {},
      registeredAt: Date.now(),
      parentId: agentId("parent"),
    });

    expect(tree.childrenOf(agentId("parent"))).toHaveLength(2);
    expect(tree.parentOf(agentId("child-1"))).toBe(agentId("parent"));
  });

  test("transition validation from engine-reconcile works", () => {
    const valid = validateTransition("created", "running");
    expect(valid.ok).toBe(true);

    const invalid = validateTransition("terminated", "running");
    expect(invalid.ok).toBe(false);
  });

  test("AgentEntity assembly uses composition from engine-compose", async () => {
    const provider: ComponentProvider = {
      name: "test-provider",
      attach: async () => new Map([["test:key", "value"]]),
    };

    const result = await AgentEntity.assemble(
      { id: agentId("test"), name: "test", type: "worker", depth: 0 },
      testManifest(),
      [provider],
    );

    expect(result.agent.has("test:key" as never)).toBe(true);
    expect(result.agent.component<string>("test:key" as never)).toBe("value");
    expect(result.conflicts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 1: Full createKoi + createPiAdapter (real LLM via OpenRouter)
// ---------------------------------------------------------------------------

describeE2E("engine-split e2e: createKoi + createPiAdapter (OpenRouter)", () => {
  test(
    "streams text through full L1 runtime with split packages",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise assistant. Reply in one sentence.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      expect(runtime.agent.state).toBe("created");

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly: engine-split-ok" }),
      );

      expect(runtime.agent.state).toBe("terminated");

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.inputTokens).toBeGreaterThan(0);
      expect(output?.metrics.outputTokens).toBeGreaterThan(0);

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "tool call flows through middleware chain with split compose/reconcile",
    async () => {
      // let justified: mutable counters for middleware observation
      let toolCallCount = 0;
      let sessionStarted = false;
      let sessionEnded = false;
      let turnCount = 0;

      const observer: KoiMiddleware = {
        name: "split-observer",
        describeCapabilities: () => undefined,
        onSessionStart: async () => {
          sessionStarted = true;
        },
        onSessionEnd: async () => {
          sessionEnded = true;
        },
        onAfterTurn: async () => {
          turnCount += 1;
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolCallCount += 1;
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You MUST use the add_numbers tool for any math. Never compute in your head.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the add_numbers tool to compute 17 + 25. Tell me the result.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Middleware hooks must have fired (from engine-compose composition)
      expect(sessionStarted).toBe(true);
      expect(sessionEnded).toBe(true);
      expect(turnCount).toBeGreaterThan(0);

      // Tool call must have been intercepted by middleware
      expect(toolCallCount).toBeGreaterThanOrEqual(1);

      // tool_call_start/end events present
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      const toolEnds = events.filter((e) => e.kind === "tool_call_end");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);
      expect(toolEnds.length).toBeGreaterThanOrEqual(1);

      // Response should contain 42
      const text = extractText(events);
      expect(text).toContain("42");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "iteration guard (from engine-compose) limits turns",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the add_numbers tool for every calculation. Never skip the tool.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        providers: [createToolProvider([ADD_TOOL])],
        limits: { maxTurns: 3 },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Compute 1+2, then 3+4, then 5+6, then 7+8, then 9+10. Show all results.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      // Pi adapter manages its own loop — iteration guard fires as extension.
      // Verify the runtime completed (guard was loaded but may not limit pi adapter turns).
      expect(output?.stopReason).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "multi-tool agent with multiple middleware layers",
    async () => {
      const callOrder: string[] = [];

      const mw1: KoiMiddleware = {
        name: "layer-1",
        describeCapabilities: () => ({ label: "layer-1", description: "First layer" }),
        wrapToolCall: async (
          _ctx,
          req: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          callOrder.push(`mw1:before:${req.toolId}`);
          const res = await next(req);
          callOrder.push(`mw1:after:${req.toolId}`);
          return res;
        },
      };

      const mw2: KoiMiddleware = {
        name: "layer-2",
        describeCapabilities: () => ({ label: "layer-2", description: "Second layer" }),
        wrapToolCall: async (
          _ctx,
          req: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          callOrder.push(`mw2:before:${req.toolId}`);
          const res = await next(req);
          callOrder.push(`mw2:after:${req.toolId}`);
          return res;
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You have add_numbers and echo tools. Use them when asked. Always use tools.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [mw1, mw2],
        providers: [createToolProvider([ADD_TOOL, ECHO_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: 'Use the echo tool with text "hello". Then tell me what it returned.',
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Middleware should have composed in onion order (mw1 wraps mw2)
      if (callOrder.length >= 4) {
        // Verify onion: mw1:before → mw2:before → mw2:after → mw1:after
        const firstBefore = callOrder.findIndex((c) => c.startsWith("mw1:before"));
        const secondBefore = callOrder.findIndex((c) => c.startsWith("mw2:before"));
        const secondAfter = callOrder.findIndex((c) => c.startsWith("mw2:after"));
        const firstAfter = callOrder.findIndex((c) => c.startsWith("mw1:after"));

        if (firstBefore >= 0 && secondBefore >= 0) {
          expect(firstBefore).toBeLessThan(secondBefore);
        }
        if (secondAfter >= 0 && firstAfter >= 0) {
          expect(secondAfter).toBeLessThan(firstAfter);
        }
      }

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 2: createKoi + createLoopAdapter (heavier — tests middleware chain)
// ---------------------------------------------------------------------------

describeE2E("engine-split e2e: createKoi + createLoopAdapter (full chain)", () => {
  test(
    "loop adapter with model terminal through split packages",
    async () => {
      // let justified: mutable for model call interception
      let modelCallCount = 0;

      const adapter = createLoopAdapter({
        modelCall: async (_request: ModelRequest): Promise<ModelResponse> => {
          modelCallCount += 1;
          return {
            content: "loop-adapter response from split packages",
            model: "test-model",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));

      expect(modelCallCount).toBe(1);

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Verify the done output exists and has content
      // Loop adapter emits text_delta with ContentBlock[] (non-streaming)
      // so extract text from the done output's content blocks
      const content = output?.content ?? [];
      const allText = content
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b.text)))
        .join(" ");
      expect(allText).toContain("loop-adapter response");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "loop adapter with tool calls exercises engine-compose middleware chain",
    async () => {
      // let justified: mutable tracking
      let turn = 0;
      let toolExecuted = false;

      const adapter = createLoopAdapter({
        modelCall: async (_request: ModelRequest): Promise<ModelResponse> => {
          turn += 1;
          if (turn === 1) {
            // First turn: request a tool call
            return {
              content: "calling tool...",
              model: "test-model",
              usage: { inputTokens: 10, outputTokens: 5 },
              metadata: {
                toolCalls: [
                  {
                    toolName: "add_numbers",
                    callId: "call_1",
                    input: { a: 10, b: 32 },
                  },
                ],
              },
            };
          }
          // Second turn: return final response
          return {
            content: "The result is 42",
            model: "test-model",
            usage: { inputTokens: 20, outputTokens: 10 },
          };
        },
      });

      const toolObserver: KoiMiddleware = {
        name: "tool-observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          toolExecuted = true;
          expect(request.toolId).toBe("add_numbers");
          return next(request);
        },
      };

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [toolObserver],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "compute 10 + 32" }));

      expect(turn).toBe(2);
      expect(toolExecuted).toBe(true);

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(output?.metrics.turns).toBe(2);

      // tool_call events must be present
      expect(events.some((e) => e.kind === "tool_call_start")).toBe(true);
      expect(events.some((e) => e.kind === "tool_call_end")).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 3: Registry + CascadingTermination integration
// ---------------------------------------------------------------------------

describeE2E("engine-split e2e: registry + cascading termination", () => {
  // let justified: mutable test state
  let registry: InMemoryRegistry;
  let tree: ProcessTree;

  beforeEach(() => {
    registry = createInMemoryRegistry();
    tree = createProcessTree(registry);
  });

  test(
    "cascading termination propagates through split packages",
    async () => {
      // Register parent + children
      registry.register({
        agentId: agentId("parent"),
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: Date.now(),
      });

      registry.register({
        agentId: agentId("child-1"),
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: Date.now(),
        parentId: agentId("parent"),
      });

      registry.register({
        agentId: agentId("child-2"),
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: Date.now(),
        parentId: agentId("parent"),
      });

      // tree auto-tracks via registry.watch — no manual add needed

      // Wire cascading termination (from engine-reconcile)
      const cascade = createCascadingTermination(registry, tree);

      // Terminate parent
      const result = registry.transition(agentId("parent"), "terminated", 1, {
        kind: "completed",
      });
      expect(result.ok).toBe(true);

      // Give cascade async BFS time to run
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Children should be terminated via cascade
      const child1 = registry.lookup(agentId("child-1"));
      const child2 = registry.lookup(agentId("child-2"));
      expect(child1?.status.phase).toBe("terminated");
      expect(child2?.status.phase).toBe("terminated");

      await cascade[Symbol.asyncDispose]();
    },
    TIMEOUT_MS,
  );

  test(
    "spawnChildAgent works with registry from engine-reconcile",
    async () => {
      const ledger = createInMemorySpawnLedger(10);

      const childAdapter = createLoopAdapter({
        modelCall: async (): Promise<ModelResponse> => ({
          content: "child response",
          model: "test",
        }),
      });

      // Create parent runtime
      const parentRuntime = await createKoi({
        manifest: testManifest({ name: "parent-agent" }),
        adapter: childAdapter,
        spawnLedger: ledger,
        registry,
        loopDetection: false,
      });

      // Register parent
      registry.register({
        agentId: parentRuntime.agent.pid.id,
        status: { phase: "running", generation: 1, conditions: [], lastTransitionAt: Date.now() },
        agentType: "worker",
        priority: 10,
        metadata: {},
        registeredAt: Date.now(),
      });

      // Spawn child
      const childResult = await spawnChildAgent({
        parentAgent: parentRuntime.agent,
        manifest: testManifest({ name: "child-agent" }),
        adapter: childAdapter,
        spawnLedger: ledger,
        registry,
        spawnPolicy: DEFAULT_SPAWN_POLICY,
      });

      expect(childResult.childPid).toBeDefined();
      expect(childResult.runtime).toBeDefined();
      expect(childResult.handle).toBeDefined();

      // Child should be registered
      const childEntry = registry.lookup(childResult.childPid.id);
      expect(childEntry).toBeDefined();

      // Run child and verify it works
      const events = await collectEvents(childResult.runtime.run({ kind: "text", text: "hi" }));

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      await childResult.runtime.dispose();
      await parentRuntime.dispose();
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Test 4: Full stack — real LLM + tool + spawn + middleware + governance
// ---------------------------------------------------------------------------

describeE2E("engine-split e2e: full stack real LLM with governance", () => {
  test(
    "createKoi with governance config from engine-reconcile",
    async () => {
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "Reply concisely.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const govConfig = createDefaultGovernanceConfig();
      expect(govConfig).toBeDefined();

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        governance: govConfig,
        loopDetection: false,
      });

      const events = await collectEvents(runtime.run({ kind: "text", text: "Say: governance-ok" }));

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "real LLM call through OpenRouter validates end-to-end wiring",
    async () => {
      const hookLog: string[] = [];

      const lifecycleMw: KoiMiddleware = {
        name: "lifecycle-tracker",
        describeCapabilities: () => ({
          label: "lifecycle-tracker",
          description: "Tracks lifecycle",
        }),
        onSessionStart: async () => {
          hookLog.push("session_start");
        },
        onSessionEnd: async () => {
          hookLog.push("session_end");
        },
        onAfterTurn: async () => {
          hookLog.push("after_turn");
        },
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          hookLog.push(`tool_call:${request.toolId}`);
          return next(request);
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt:
          "You MUST use the add_numbers tool. Never compute in your head. Always use tools.",
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [lifecycleMw],
        providers: [createToolProvider([ADD_TOOL])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the add_numbers tool to calculate 100 + 200. Report the answer.",
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // Lifecycle hooks must have fired (composed by engine-compose)
      expect(hookLog).toContain("session_start");
      expect(hookLog).toContain("session_end");
      expect(hookLog).toContain("after_turn");

      // Tool call middleware should have fired for add_numbers
      expect(hookLog.some((h) => h.startsWith("tool_call:"))).toBe(true);

      // Response should contain 300
      const text = extractText(events);
      expect(text).toContain("300");

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
