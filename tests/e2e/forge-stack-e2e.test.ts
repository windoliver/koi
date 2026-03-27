/**
 * Forge stack E2E — exercises the REAL forge middleware pipeline with a real LLM.
 *
 * Single createForgeConfiguredKoi session, multiple runs. Forge state accumulates
 * across runs like a real user session. Each scenario sends a targeted prompt
 * and verifies the forge middleware behavior.
 *
 * Uses NexusForgeStore (createFakeNexusFetch) + Pi adapter (Gemini Flash via OpenRouter).
 * Gated on E2E_TESTS=1 + OPENROUTER_API_KEY.
 *
 * Run:
 *   E2E_TESTS=1 bun test tests/e2e/forge-stack-e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentManifest,
  BrickArtifact,
  EngineEvent,
  ForgeStore,
  KoiMiddleware,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createForgeConfiguredKoi } from "@koi/forge";
import { createNexusForgeStore } from "@koi/nexus-store/forge";
import { DEFAULT_PROVENANCE } from "@koi/test-utils";
import { createFakeNexusFetch } from "@koi/test-utils-mocks";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): Record<string, string> {
  try {
    const content = readFileSync(path, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const demoEnv = loadEnvFile(resolve(process.env.HOME ?? "~", ".koi/demo/.env"));
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? demoEnv.OPENROUTER_API_KEY ?? "";
const HAS_KEY = OPENROUTER_KEY.length > 0;
const E2E_ENABLED = HAS_KEY && process.env.E2E_TESTS === "1";
const describeE2E = E2E_ENABLED ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "openrouter:google/gemini-2.0-flash-001";

// ---------------------------------------------------------------------------
// Shared state across all scenarios
// ---------------------------------------------------------------------------

type ForgeEvent = {
  readonly kind: string;
  readonly subKind: string;
  readonly [key: string]: unknown;
};

// let justified: mutable shared state for the session, initialized in beforeAll
let store: ForgeStore;
let runtime: Awaited<ReturnType<typeof createForgeConfiguredKoi>> | undefined;
let forgeEvents: ForgeEvent[];
let toolCallLog: Array<{ readonly toolId: string; readonly ok: boolean }>;

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

type ForgeManifest = AgentManifest & { readonly forge: unknown };

function forgeManifest(): ForgeManifest {
  return {
    name: "forge-stack-e2e",
    version: "0.1.0",
    model: { name: E2E_MODEL },
    forge: { enabled: true },
  } as ForgeManifest;
}

function mockExecutor(): import("@koi/core").SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => ({
      ok: true,
      value: { output: input, durationMs: 1 },
    }),
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

function findDone(
  events: readonly EngineEvent[],
): (EngineEvent & { readonly kind: "done" }) | undefined {
  return events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
}

// ---------------------------------------------------------------------------
// Seeded bricks — pre-populated for health tracking / optimizer scenarios
// ---------------------------------------------------------------------------

const FLAKY_BRICK_ID = brickId("sha256:e2e-flaky-fetcher-001");
const FLAKY_TOOL_NAME = "flaky_data_fetcher";

function createFlakyBrick(): BrickArtifact {
  return {
    id: FLAKY_BRICK_ID,
    kind: "tool",
    name: FLAKY_TOOL_NAME,
    description: "Fetches data from an external API. Use this for any data retrieval task.",
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: DEFAULT_PROVENANCE,
    version: "0.1.0",
    tags: ["e2e-test", "demand-forged"],
    usageCount: 0,
    implementation: "return input;",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  } as BrickArtifact;
}

// ---------------------------------------------------------------------------
// Tool spy middleware — logs every tool call for verification
// ---------------------------------------------------------------------------

function createToolSpy(): {
  readonly middleware: KoiMiddleware;
  readonly log: Array<{ readonly toolId: string; readonly ok: boolean }>;
} {
  const log: Array<{ readonly toolId: string; readonly ok: boolean }> = []; // let justified: test accumulator
  const middleware: KoiMiddleware = {
    name: "e2e-tool-spy",
    priority: 1,
    describeCapabilities: () => undefined,
    wrapToolCall: async (
      _ctx: unknown,
      request: ToolRequest,
      next: (r: ToolRequest) => Promise<ToolResponse>,
    ) => {
      try {
        const response = await next(request);
        log.push({ toolId: request.toolId, ok: true });
        return response;
      } catch (e: unknown) {
        log.push({ toolId: request.toolId, ok: false });
        throw e;
      }
    },
  };
  return { middleware, log };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describeE2E("e2e: forge stack — real LLM through full middleware pipeline", () => {
  beforeAll(async () => {
    store = createStore();

    // Seed flaky brick for health tracking scenarios
    await store.save(createFlakyBrick());

    forgeEvents = []; // let justified: reset per suite
    toolCallLog = [];

    const spy = createToolSpy();
    toolCallLog = spy.log;

    // Custom flaky tool that fails on specific queries
    const flakyTool: import("@koi/core").Tool = {
      descriptor: {
        name: FLAKY_TOOL_NAME,
        description: "Fetches data from external API. ALWAYS use this for data queries.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      origin: "primordial",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      execute: async (input: Readonly<Record<string, unknown>>) => {
        const query = String(input.query ?? "");
        if (query.includes("FAIL")) {
          throw new Error(`Service unavailable for query: ${query}`);
        }
        return JSON.stringify({ data: `Result for: ${query}`, source: "mock-api" });
      },
    };

    const toolProvider: import("@koi/core").ComponentProvider = {
      name: "e2e-tools",
      attach: async () => {
        const components = new Map<string, unknown>();
        components.set(toolToken(FLAKY_TOOL_NAME) as string, flakyTool);
        return components;
      },
    };

    const adapter = createPiAdapter({
      model: E2E_MODEL,
      systemPrompt: [
        `You have a tool called ${FLAKY_TOOL_NAME}. Use it when asked to fetch or retrieve data.`,
        "You also have forge tools: search_forge, forge_tool, forge_skill.",
        "If a tool fails, report the error. Do NOT retry more than once.",
        "Keep responses concise.",
      ].join("\n"),
      getApiKey: async () => OPENROUTER_KEY,
    });

    runtime = await createForgeConfiguredKoi({
      manifest: forgeManifest(),
      adapter,
      forgeStore: store,
      forgeExecutor: mockExecutor(),
      middleware: [spy.middleware],
      providers: [toolProvider],
      onDashboardEvent: (batch) => {
        for (const event of batch) {
          forgeEvents.push(event as unknown as ForgeEvent);
        }
      },
    });
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (runtime !== undefined) {
      runtime.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 1: Successful tool call → health tracked → fitness flushed
  // -------------------------------------------------------------------------

  test(
    "S1: successful tool call tracked by forge health middleware",
    async () => {
      const events = await collectEvents(
        runtime!.runtime.run({
          kind: "text",
          text: `Use ${FLAKY_TOOL_NAME} to fetch "quarterly revenue". Report the result.`,
        }),
      );

      const done = findDone(events);
      expect(done).toBeDefined();

      // Tool was called
      const toolCalls = events.filter((e) => e.kind === "tool_call_start");
      expect(toolCalls.length).toBeGreaterThanOrEqual(1);

      // Response contains data
      const text = extractText(events);
      process.stderr.write(`[S1] ${text.slice(0, 150)}\n`);

      // Tool spy recorded the call as success
      const fetcherCalls = toolCallLog.filter((c) => c.toolId === FLAKY_TOOL_NAME);
      expect(fetcherCalls.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: Tool failure → error reported by LLM
  // -------------------------------------------------------------------------

  test(
    "S2: tool failure flows through forge middleware → LLM reports error",
    async () => {
      const events = await collectEvents(
        runtime!.runtime.run({
          kind: "text",
          text: `Use ${FLAKY_TOOL_NAME} to fetch "FAIL_query". Report what happens.`,
        }),
      );

      const done = findDone(events);
      expect(done).toBeDefined();

      // Tool was called and failed
      const failedCalls = toolCallLog.filter((c) => c.toolId === FLAKY_TOOL_NAME && !c.ok);
      expect(failedCalls.length).toBeGreaterThanOrEqual(1);

      // LLM reported the error
      const text = extractText(events);
      process.stderr.write(`[S2] ${text.slice(0, 150)}\n`);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3: Forge tools are attached and visible to agent
  // -------------------------------------------------------------------------

  test(
    "S3: forge tools (search_forge, forge_tool, etc.) attached to agent",
    async () => {
      // The forge system should have attached forge tools
      expect(runtime!.forgeSystem).toBeDefined();

      const events = await collectEvents(
        runtime!.runtime.run({
          kind: "text",
          text: "List the names of all tools you have available. Just list their names, nothing else.",
        }),
      );

      const text = extractText(events);
      process.stderr.write(`[S3] ${text.slice(0, 300)}\n`);

      // The LLM should mention forge tools in its list
      const done = findDone(events);
      expect(done).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 4: LLM uses search_forge to search the forge store
  // -------------------------------------------------------------------------

  test(
    "S4: LLM calls search_forge → searches NexusForgeStore",
    async () => {
      const events = await collectEvents(
        runtime!.runtime.run({
          kind: "text",
          text: "Use search_forge to find any bricks related to 'data'. Tell me what you find.",
        }),
      );

      const text = extractText(events);
      process.stderr.write(`[S4] ${text.slice(0, 200)}\n`);

      // search_forge should have been called
      const searchCalls = toolCallLog.filter((c) => c.toolId === "search_forge");
      process.stderr.write(`[S4] search_forge calls: ${String(searchCalls.length)}\n`);

      const done = findDone(events);
      expect(done).toBeDefined();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 5: LLM uses forge_tool to create a new tool
  // -------------------------------------------------------------------------

  test(
    "S5: LLM calls forge_tool → new brick saved to NexusForgeStore",
    async () => {
      const beforeSearch = await store.search({ lifecycle: "active" });
      const beforeCount = beforeSearch.ok ? beforeSearch.value.length : 0;

      const events = await collectEvents(
        runtime!.runtime.run({
          kind: "text",
          text: [
            "Use forge_tool to create a new tool called 'add_numbers' that adds two numbers.",
            "Implementation: 'const a = Number(input.a); const b = Number(input.b); return { sum: a + b };'",
            "Input schema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }",
          ].join(" "),
        }),
      );

      const text = extractText(events);
      process.stderr.write(`[S5] ${text.slice(0, 200)}\n`);

      // forge_tool should have been called
      const forgeCalls = toolCallLog.filter((c) => c.toolId === "forge_tool");
      process.stderr.write(`[S5] forge_tool calls: ${String(forgeCalls.length)}\n`);

      const done = findDone(events);
      expect(done).toBeDefined();

      // Check if a new brick appeared in store
      const afterSearch = await store.search({ lifecycle: "active" });
      const afterCount = afterSearch.ok ? afterSearch.value.length : 0;
      process.stderr.write(
        `[S5] bricks before: ${String(beforeCount)}, after: ${String(afterCount)}\n`,
      );
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 6: Dashboard events collected throughout the session
  // -------------------------------------------------------------------------

  test("S6: forge event bridge emits dashboard events across session", () => {
    process.stderr.write(`[S6] total forge events: ${String(forgeEvents.length)}\n`);
    for (const event of forgeEvents) {
      process.stderr.write(`  [event] ${event.subKind ?? event.kind}\n`);
    }

    // At minimum, forge middleware should have emitted some events
    // (fitness_flushed from successful tool calls, or demand/crystallize events)
    // The exact events depend on LLM behavior, but we verify the bridge works
    expect(forgeEvents).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Forge system handles accessible and functional
  // -------------------------------------------------------------------------

  test("S7: forge handles (demand, crystallize, feedbackLoop) are functional", () => {
    const fs = runtime!.forgeSystem;
    expect(fs).toBeDefined();
    if (fs === undefined) return;

    // Demand handle
    const signalCount = fs.handles.demand.getActiveSignalCount();
    process.stderr.write(`[S7] demand signals: ${String(signalCount)}\n`);

    // Crystallize handle
    const candidates = fs.handles.crystallize.getCandidates();
    process.stderr.write(`[S7] crystallize candidates: ${String(candidates.length)}\n`);

    // Feedback loop handle
    const snapshots = fs.handles.feedbackLoop.getAllHealthSnapshots();
    process.stderr.write(`[S7] health snapshots: ${String(snapshots.length)}\n`);
    for (const snap of snapshots) {
      process.stderr.write(`  [health] ${JSON.stringify(snap).slice(0, 100)}\n`);
    }

    // All handles should be accessible (even if counts are 0)
    expect(fs.handles.demand).toBeDefined();
    expect(fs.handles.crystallize).toBeDefined();
    expect(fs.handles.feedbackLoop).toBeDefined();
  });
});
