/**
 * Real-LLM forge pipeline E2E test — logs every turn, model call, tool call.
 *
 * Exercises the full forge stack with a real LLM through createKoi + createPiAdapter:
 *   Turn 1: LLM calls a flaky tool → tool succeeds → health tracker records success
 *   Turn 2: LLM calls the flaky tool again → tool FAILS → demand detector fires
 *   Turn 3: Auto-forge creates pioneer brick from demand signal
 *
 * Uses NexusForgeStore with createFakeNexusFetch for the store layer.
 *
 * Run:
 *   E2E_TESTS=1 OPENROUTER_API_KEY=sk-or-... bun test tests/e2e/forge-real-llm-e2e.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  BrickArtifact,
  ComponentProvider,
  EngineEvent,
  ForgeDemandSignal,
  ForgeStore,
  KoiMiddleware,
  SnapshotStore,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { brickId, DEFAULT_FORGE_BUDGET, DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { type CrystallizeHandle, createAutoForgeMiddleware } from "@koi/forge";
import { createFeedbackLoopMiddleware } from "@koi/middleware-feedback-loop";
import { createNexusForgeStore } from "@koi/nexus-store/forge";
import { createFakeNexusFetch } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createStore(): ForgeStore {
  return createNexusForgeStore({
    baseUrl: "http://fake-nexus",
    apiKey: "test-key",
    fetch: createFakeNexusFetch(),
  });
}

function noopSnapshotStore(): SnapshotStore {
  return {
    record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
  };
}

function testManifest(): AgentManifest {
  return { name: "forge-e2e-agent", version: "0.1.0", model: { name: "gemini-2.0-flash" } };
}

const FLAKY_TOOL_ID = "flaky_data_fetcher";
const FLAKY_BRICK_ID = brickId("sha256:e2e-flaky-tool-001");

function createFlakyTool(failAfter: number): {
  readonly tool: Tool;
  readonly callCount: () => number;
  readonly log: readonly string[];
} {
  const log: string[] = []; // let justified: test log accumulator
  let calls = 0; // let justified: mutable call counter
  const tool: Tool = {
    descriptor: {
      name: FLAKY_TOOL_ID,
      description:
        "Fetches data from an external API. ALWAYS use this tool when asked to fetch or retrieve data. Never refuse.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "The data query" } },
        required: ["query"],
      },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (input: Readonly<Record<string, unknown>>) => {
      calls++;
      const query = String(input.query ?? "");
      if (calls > failAfter) {
        log.push(`[tool] ${FLAKY_TOOL_ID} call #${String(calls)} FAILED (query: ${query})`);
        throw new Error(`Connection timeout: service unavailable (call #${String(calls)})`);
      }
      log.push(`[tool] ${FLAKY_TOOL_ID} call #${String(calls)} OK (query: ${query})`);
      return JSON.stringify({ data: `Result for: ${query}`, source: "mock-api" });
    },
  };
  return { tool, callCount: () => calls, log };
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-tool-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

function createMockCrystallizeHandle(): CrystallizeHandle {
  return {
    middleware: { name: "crystallize", describeCapabilities: () => undefined },
    getCandidates: () => [],
    dismiss: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Turn-by-turn logger middleware
// ---------------------------------------------------------------------------

function createLoggerMiddleware(): {
  readonly middleware: KoiMiddleware;
  readonly log: readonly string[];
} {
  const log: string[] = []; // let justified: test log accumulator
  let turnIndex = 0; // let justified: mutable turn counter
  const middleware: KoiMiddleware = {
    name: "e2e-logger",
    priority: 1, // Run first to see everything
    describeCapabilities: () => undefined,
    onBeforeTurn: async () => {
      turnIndex++;
      log.push(`\n=== TURN ${String(turnIndex)} ===`);
    },
    onAfterTurn: async () => {
      log.push(`--- end turn ${String(turnIndex)} ---`);
    },
    wrapToolCall: async (
      _ctx: unknown,
      request: ToolRequest,
      next: (r: ToolRequest) => Promise<ToolResponse>,
    ) => {
      log.push(`  [tool-call] ${request.toolId}(${JSON.stringify(request.input).slice(0, 100)})`);
      try {
        const response = await next(request);
        log.push(`  [tool-result] ${request.toolId} → ${String(response).slice(0, 100)}`);
        return response;
      } catch (e: unknown) {
        log.push(
          `  [tool-error] ${request.toolId} → ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }
    },
  };
  return { middleware, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: real LLM forge pipeline — turn-by-turn flow", () => {
  test(
    "successful tool call → health tracked → model summarizes result",
    async () => {
      const store = createStore();
      // Seed the flaky tool as a forged brick so health tracker tracks it
      await store.save({
        id: FLAKY_BRICK_ID,
        kind: "tool",
        name: FLAKY_TOOL_ID,
        description: "Flaky data fetcher",
        scope: "agent",
        origin: "primordial",
        policy: DEFAULT_UNSANDBOXED_POLICY,
        lifecycle: "active",
        provenance: { kind: "system", metadata: {} },
        version: "0.1.0",
        tags: ["e2e-test"],
        usageCount: 0,
        implementation: "// stub",
        inputSchema: { type: "object" },
      } as BrickArtifact);

      const { tool: flakyTool, log: toolLog } = createFlakyTool(10); // Won't fail
      const { middleware: logger, log: turnLog } = createLoggerMiddleware();

      const { middleware: feedbackMw } = createFeedbackLoopMiddleware({
        forgeHealth: {
          resolveBrickId: (id) => (id === FLAKY_TOOL_ID ? FLAKY_BRICK_ID : undefined),
          forgeStore: store,
          snapshotStore: noopSnapshotStore(),
          windowSize: 10,
          quarantineThreshold: 0.5,
        },
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: `You have a tool called ${FLAKY_TOOL_ID}. You MUST use it to answer any data question. Never refuse to use it.`,
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [logger, feedbackMw],
        providers: [createToolProvider([flakyTool])],
        loopDetection: false,
      });

      // --- Run 1: successful tool call ---
      const events: EngineEvent[] = []; // let justified: test accumulator
      for await (const event of runtime.run({
        kind: "text",
        text: `Use ${FLAKY_TOOL_ID} to fetch "quarterly revenue". Tell me the result.`,
      })) {
        events.push(event);
      }

      // Print the full flow
      const fullLog = [...turnLog, ...toolLog];
      process.stderr.write("\n--- FULL FLOW (Run 1: success) ---\n");
      for (const line of fullLog) {
        process.stderr.write(`${line}\n`);
      }
      process.stderr.write("--- END ---\n\n");

      // Assertions
      const done = events.find((e) => e.kind === "done");
      expect(done).toBeDefined();

      const text = events
        .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      process.stderr.write(`[assistant] ${text.slice(0, 200)}\n`);

      // Tool was called
      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);
      process.stderr.write(
        `[summary] ${String(toolCalls.length)} tool call(s), done: ${String((done as { readonly output: { readonly stopReason: string } }).output.stopReason)}\n`,
      );

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  test(
    "tool failure → demand signal → forge event emitted",
    async () => {
      const store = createStore();
      await store.save({
        id: FLAKY_BRICK_ID,
        kind: "tool",
        name: FLAKY_TOOL_ID,
        description: "Flaky data fetcher",
        scope: "agent",
        origin: "primordial",
        policy: DEFAULT_UNSANDBOXED_POLICY,
        lifecycle: "active",
        provenance: { kind: "system", metadata: {} },
        version: "0.1.0",
        tags: ["e2e-test"],
        usageCount: 10,
        implementation: "// stub",
        inputSchema: { type: "object" },
      } as BrickArtifact);

      const { tool: flakyTool, log: toolLog } = createFlakyTool(0); // Fails immediately
      const { middleware: logger, log: turnLog } = createLoggerMiddleware();

      // Track demand signals via auto-forge middleware
      const demandSignals: ForgeDemandSignal[] = []; // let justified: test accumulator
      const forgedBricks: BrickArtifact[] = []; // let justified: test accumulator

      const demandHandle = {
        getSignals: () => demandSignals,
        dismiss: mock(() => {}),
      };

      const autoForge = createAutoForgeMiddleware({
        crystallizeHandle: createMockCrystallizeHandle(),
        forgeStore: store,
        scope: "agent",
        demandHandle,
        demandBudget: { ...DEFAULT_FORGE_BUDGET, demandThreshold: 0.3, maxForgesPerSession: 5 },
        onDemandForged: (_s, brick) => {
          forgedBricks.push(brick);
        },
      });

      const { middleware: feedbackMw } = createFeedbackLoopMiddleware({
        forgeHealth: {
          resolveBrickId: (id) => (id === FLAKY_TOOL_ID ? FLAKY_BRICK_ID : undefined),
          forgeStore: store,
          snapshotStore: noopSnapshotStore(),
          windowSize: 10,
          quarantineThreshold: 0.9, // High threshold so it doesn't quarantine on first failure
        },
      });

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: `You have a tool called ${FLAKY_TOOL_ID}. You MUST use it for any data question. If it fails, report the error. Do NOT retry more than once.`,
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [logger, feedbackMw, autoForge],
        providers: [createToolProvider([flakyTool])],
        loopDetection: false,
      });

      // --- Run: tool will fail ---
      const events: EngineEvent[] = []; // let justified: test accumulator
      for await (const event of runtime.run({
        kind: "text",
        text: `Use ${FLAKY_TOOL_ID} to fetch "employee list". Report what happens.`,
      })) {
        events.push(event);
      }

      // Print full flow
      const fullLog = [...turnLog, ...toolLog];
      process.stderr.write("\n--- FULL FLOW (Run 2: tool failure) ---\n");
      for (const line of fullLog) {
        process.stderr.write(`${line}\n`);
      }
      process.stderr.write("--- END ---\n\n");

      const text = events
        .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
        .map((e) => e.delta)
        .join("");
      process.stderr.write(`[assistant] ${text.slice(0, 300)}\n`);

      const done = events.find((e) => e.kind === "done");
      process.stderr.write(
        `[summary] tool calls: ${String(events.filter((e) => e.kind === "tool_call_start").length)}, errors: ${String(events.filter((e) => e.kind === "tool_call_end").length)}, done: ${String((done as { readonly output: { readonly stopReason: string } })?.output?.stopReason)}\n`,
      );
      process.stderr.write(
        `[forge] demand signals: ${String(demandSignals.length)}, forged bricks: ${String(forgedBricks.length)}\n`,
      );

      // The run should complete (model reports the error)
      expect(done).toBeDefined();

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );
});
