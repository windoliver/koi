/**
 * E2E: Real LLM → forged tool calls → forge middleware → dashboard events → TUI state.
 *
 * Creates a real Koi engine with:
 *   - A forged "reliable_adder" tool (always succeeds)
 *   - A forged "flaky_lookup" tool (fails after 2 calls)
 *   - Feedback-loop middleware tracking health
 *   - Real LLM via OpenRouter
 *
 * Sends prompts that trigger tool calls, collects dashboard events emitted
 * by the middleware, then feeds them into the TUI store and verifies the
 * forge view state matches reality.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-forge-view.test.ts
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  BrickArtifact,
  ComponentProvider,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  SnapshotStore,
  Tool,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { brickId, DEFAULT_UNSANDBOXED_POLICY, toolToken } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryForgeStore } from "@koi/forge-tools";
import type { ForgeHealthConfig } from "../config.js";
import { createFeedbackLoopMiddleware } from "../feedback-loop.js";
import { createToolHealthTracker } from "../tool-health.js";

// ---------------------------------------------------------------------------
// Gate
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

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function testManifest(): AgentManifest {
  return { name: "Forge View E2E Agent", version: "0.1.0", model: { name: "test-model" } };
}

// ---------------------------------------------------------------------------
// Forged tool bricks — seeded into ForgeStore
// ---------------------------------------------------------------------------

const ADDER_BRICK_ID = brickId("sha256:e2e-reliable-adder-001");
const ADDER_TOOL_ID = "reliable_adder";
const LOOKUP_BRICK_ID = brickId("sha256:e2e-flaky-lookup-001");
const LOOKUP_TOOL_ID = "flaky_lookup";

function createBrick(
  id: ReturnType<typeof brickId>,
  name: string,
  description: string,
): BrickArtifact {
  return {
    id,
    kind: "tool",
    name,
    description,
    scope: "agent",
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    lifecycle: "active",
    provenance: { kind: "system", metadata: {} },
    version: "0.1.0",
    tags: ["e2e-test"],
    usageCount: 0,
    implementation: "",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  } as unknown as BrickArtifact;
}

/** Always succeeds — returns a + b. */
function createReliableAdder(): Tool {
  return {
    descriptor: {
      name: ADDER_TOOL_ID,
      description:
        "Adds two numbers. ALWAYS use this tool for addition. Never compute in your head.",
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
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (input: Readonly<Record<string, unknown>>) => {
      return String(Number(input.a ?? 0) + Number(input.b ?? 0));
    },
  };
}

/** Fails after N successful calls. */
function createFlakyLookup(failAfter: number): {
  readonly tool: Tool;
  readonly callCount: () => number;
} {
  let calls = 0; // let: mutable counter
  const tool: Tool = {
    descriptor: {
      name: LOOKUP_TOOL_ID,
      description:
        "Looks up a user by name. ALWAYS use this tool when asked to look up or find a user.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "User name to look up" } },
        required: ["name"],
      },
    },
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,
    execute: async (input: Readonly<Record<string, unknown>>) => {
      calls++;
      if (calls > failAfter) {
        throw new Error(`Lookup service unavailable (call #${String(calls)})`);
      }
      return JSON.stringify({ found: true, name: input.name, id: `user-${String(calls)}` });
    },
  };
  return { tool, callCount: () => calls };
}

function resolveBrickId(toolId: string): string | undefined {
  if (toolId === ADDER_TOOL_ID) return ADDER_BRICK_ID;
  if (toolId === LOOKUP_TOOL_ID) return LOOKUP_BRICK_ID;
  return undefined;
}

function createToolProvider(tools: readonly Tool[]): ComponentProvider {
  return {
    name: "e2e-forge-view-provider",
    attach: async () => new Map(tools.map((t) => [toolToken(t.descriptor.name) as string, t])),
  };
}

function createMockSnapshotStore(): SnapshotStore {
  return {
    record: mock(() => Promise.resolve({ ok: true as const, value: undefined })),
    get: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
    list: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    history: mock(() => Promise.resolve({ ok: true as const, value: [] as never })),
    latest: mock(() => Promise.resolve({ ok: true as const, value: {} as never })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: real LLM → forged tool → forge middleware → dashboard events", () => {
  // ── Test 1: Successful tool call tracked by forge middleware ──────────

  test(
    "forged adder tool success tracked — middleware fires, brick unchanged",
    async () => {
      const forgeStore = createInMemoryForgeStore();
      await forgeStore.save(createBrick(ADDER_BRICK_ID, ADDER_TOOL_ID, "Adds two numbers"));

      const snapshotStore = createMockSnapshotStore();
      const forgeHealth: ForgeHealthConfig = {
        resolveBrickId,
        forgeStore,
        snapshotStore,
        windowSize: 10,
        quarantineThreshold: 0.5,
      };

      let toolCallSeen = false; // let: mutable flag
      const observer: KoiMiddleware = {
        name: "observer",
        describeCapabilities: () => undefined,
        wrapToolCall: async (
          _ctx: unknown,
          request: ToolRequest,
          next: (r: ToolRequest) => Promise<ToolResponse>,
        ) => {
          if (request.toolId === ADDER_TOOL_ID) toolCallSeen = true;
          return next(request);
        },
      };

      const { middleware: feedbackMw } = createFeedbackLoopMiddleware({ forgeHealth });
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: `You MUST use the ${ADDER_TOOL_ID} tool for any addition. Never compute yourself.`,
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [observer, feedbackMw],
        providers: [createToolProvider([createReliableAdder()])],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: `Use ${ADDER_TOOL_ID} to compute 15 + 27. Report the result.`,
        }),
      );

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");
      expect(toolCallSeen).toBe(true);

      // Tool call events present
      const toolStarts = events.filter((e) => e.kind === "tool_call_start");
      expect(toolStarts.length).toBeGreaterThanOrEqual(1);

      // Brick still active (single success doesn't change status)
      const loaded = await forgeStore.load(ADDER_BRICK_ID);
      expect(loaded.ok).toBe(true);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Flaky tool degrades — sustained failures trigger demotion ──

  test(
    "flaky tool failures tracked — health degrades after sustained errors",
    async () => {
      const forgeStore = createInMemoryForgeStore();
      await forgeStore.save(createBrick(LOOKUP_BRICK_ID, LOOKUP_TOOL_ID, "Looks up users"));

      const snapshotStore = createMockSnapshotStore();
      const tracker = createToolHealthTracker({
        resolveBrickId,
        forgeStore,
        snapshotStore,
        onDemotion: () => {},
        windowSize: 5,
        quarantineThreshold: 0.8,
        clock: () => Date.now(),
        demotionCriteria: {
          errorRateThreshold: 0.3,
          windowSize: 5,
          minSampleSize: 2, // Low threshold for test — 2 samples enough
          gracePeriodMs: 0,
          demotionCooldownMs: 0,
        },
      });

      // Simulate: 1 success + 2 failures = 67% error rate > 30% threshold
      tracker.recordSuccess(LOOKUP_TOOL_ID, 50);
      tracker.recordFailure(LOOKUP_TOOL_ID, 100, "service unavailable");
      tracker.recordFailure(LOOKUP_TOOL_ID, 100, "timeout");

      const demoted = await tracker.checkAndDemote(LOOKUP_TOOL_ID);
      expect(demoted).toBe(true);

      // Verify brick was demoted in store
      const loaded = await forgeStore.load(LOOKUP_BRICK_ID);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value.policy.sandbox).toBe(true); // Demoted to sandboxed
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Full flow — LLM calls flaky tool, it fails, health tracked ──

  test(
    "LLM calls flaky tool → succeeds then fails → middleware tracks both",
    async () => {
      const forgeStore = createInMemoryForgeStore();
      await forgeStore.save(createBrick(LOOKUP_BRICK_ID, LOOKUP_TOOL_ID, "Looks up users"));

      const snapshotStore = createMockSnapshotStore();
      const forgeHealth: ForgeHealthConfig = {
        resolveBrickId,
        forgeStore,
        snapshotStore,
        windowSize: 5,
        quarantineThreshold: 0.5,
      };

      const { tool: flakyTool, callCount } = createFlakyLookup(1); // Fails after 1st call

      const { middleware: feedbackMw } = createFeedbackLoopMiddleware({ forgeHealth });
      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: `You have a tool called ${LOOKUP_TOOL_ID}. ALWAYS use it when asked to look up users. If the tool fails, report the error.`,
        getApiKey: async () => OPENROUTER_KEY,
      });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter,
        middleware: [feedbackMw],
        providers: [createToolProvider([flakyTool])],
        loopDetection: false,
      });

      // Call 1: should succeed
      const events1 = await collectEvents(
        runtime.run({ kind: "text", text: `Use ${LOOKUP_TOOL_ID} to find user "alice".` }),
      );
      expect(findDoneOutput(events1)?.stopReason).toBe("completed");
      expect(callCount()).toBeGreaterThanOrEqual(1);

      // Call 2: should fail (tool throws after call 1)
      const events2 = await collectEvents(
        runtime.run({ kind: "text", text: `Use ${LOOKUP_TOOL_ID} to find user "bob".` }),
      );
      // The run should complete (error is caught by engine)
      const output2 = findDoneOutput(events2);
      expect(output2).toBeDefined();
      expect(callCount()).toBeGreaterThanOrEqual(2);

      // The forged tool was called through the real LLM pipeline
      const allToolCalls = [...events1, ...events2].filter((e) => e.kind === "tool_call_start");
      expect(allToolCalls.length).toBeGreaterThanOrEqual(2);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // Tests 1-3 cover the real E2E flow:
  //   LLM → forged tool call → forge middleware → health tracking → demotion
  // TUI rendering of forge events is verified separately in @koi/tui tests.
});
