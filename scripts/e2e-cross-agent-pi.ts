#!/usr/bin/env bun
/**
 * E2E: Cross-Agent Brick Reuse + Promotion with Pi-Engine (Real LLM).
 *
 * Spins up two agents (Alpha, Beta) via createKoi() + createPiAdapter()
 * with real Anthropic API calls to validate cross-agent brick reuse and
 * promotion end-to-end.
 *
 * Flow:
 *   Test 1: Alpha forges a "doubler" tool  → store has active brick, notifier fires "saved"
 *   Test 2: Alpha promotes doubler to global scope → scope updated, notifier fires event
 *   Test 3: Beta discovers + executes the promoted doubler → usage recorded
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-cross-agent-pi.ts
 */

import type {
  ComponentProvider,
  EngineEvent,
  StoreChangeEvent,
} from "../packages/core/src/index.js";
import { toolToken } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeComponentProvider } from "../packages/forge/src/forge-component-provider.js";
import { createForgeUsageMiddleware } from "../packages/forge/src/forge-usage-middleware.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import { createMemoryStoreChangeNotifier } from "../packages/forge/src/store-notifier.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import { createPromoteForgeTool } from "../packages/forge/src/tools/promote-forge.js";
import { createSearchForgeTool } from "../packages/forge/src/tools/search-forge.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";
import type { SandboxExecutor, TieredSandboxExecutor } from "../packages/forge/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(0);
}

console.log("[e2e] Starting cross-agent pi-engine E2E tests...\n");

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  const suffix = detail && !condition ? ` \u2014 ${detail}` : "";
  console.log(`  ${tag}  ${name}${suffix}`);
}

async function withTimeout<T>(fn: () => Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Shared infrastructure
// ---------------------------------------------------------------------------

const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";
const TIMEOUT_MS = 90_000;
const NOTIFICATION_SETTLE_MS = 200;

const store = createInMemoryForgeStore();
const notifier = createMemoryStoreChangeNotifier();

// Collect all notifier events for assertion
const allEvents: StoreChangeEvent[] = [];
notifier.subscribe((event) => allEvents.push(event));

/** Eval executor \u2014 runs forged code via `new Function()`. No sandbox isolation (dev only). */
const executor: SandboxExecutor = {
  execute: async (code, input, _timeout) => {
    try {
      const fn = new Function("input", code) as (input: unknown) => unknown;
      // await handles both sync returns and async implementations
      const output = await Promise.resolve(fn(input));
      return { ok: true as const, value: { output, durationMs: 1 } };
    } catch (err: unknown) {
      return {
        ok: false as const,
        error: {
          code: "CRASH" as const,
          message: err instanceof Error ? err.message : String(err),
          durationMs: 1,
        },
      };
    }
  },
};

const tieredExecutor: TieredSandboxExecutor = {
  forTier: (tier) => ({
    executor,
    requestedTier: tier,
    resolvedTier: tier,
    fallback: false,
  }),
};

// Config: disable HITL and lower trust requirements for scope promotion in tests
const config = createDefaultForgeConfig({
  maxForgesPerSession: 50,
  scopePromotion: {
    requireHumanApproval: false,
    minTrustForZone: "sandbox",
    minTrustForGlobal: "sandbox",
  },
});

function makeDeps(agentId: string, forgesThisSession: number): ForgeDeps {
  return {
    store,
    executor: tieredExecutor,
    verifiers: [],
    config,
    context: {
      agentId,
      depth: 0,
      sessionId: `e2e-${agentId}-${Date.now()}`,
      forgesThisSession,
    },
    notifier,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

function extractToolStarts(
  events: readonly EngineEvent[],
): ReadonlyArray<EngineEvent & { readonly kind: "tool_call_start" }> {
  return events.filter(
    (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
  );
}

function extractToolEnds(
  events: readonly EngineEvent[],
): ReadonlyArray<Extract<EngineEvent, { readonly kind: "tool_call_end" }>> {
  return events.filter(
    (e): e is Extract<EngineEvent, { readonly kind: "tool_call_end" }> =>
      e.kind === "tool_call_end",
  );
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

/**
 * Creates a ComponentProvider wrapping primordial forge tools for an agent.
 */
function makePrimordialProvider(deps: ForgeDeps): ComponentProvider {
  const forgeTool = createForgeToolTool(deps);
  const promoteTool = createPromoteForgeTool(deps);
  const searchTool = createSearchForgeTool(deps);

  const entries: ReadonlyArray<[string, unknown]> = [
    [toolToken("forge_tool"), forgeTool],
    [toolToken("promote_forge"), promoteTool],
    [toolToken("search_forge"), searchTool],
  ];

  return {
    name: "forge-primordials",
    attach: async (): Promise<ReadonlyMap<string, unknown>> => new Map(entries),
  };
}

// ---------------------------------------------------------------------------
// Test 1: Agent Alpha forges a "doubler" tool
// ---------------------------------------------------------------------------

console.log("[test 1] Agent Alpha forges a 'doubler' tool via real LLM\n");

const eventCountBefore1 = allEvents.length;

try {
  const alphaDeps = makeDeps("alpha-agent", 0);
  const primordialProvider = makePrimordialProvider(alphaDeps);

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You are a tool-forging agent. You have ONE task: use the forge_tool tool to create a tool.",
      "Call forge_tool with EXACTLY these arguments:",
      '  name: "doubler"',
      '  description: "Doubles a number"',
      '  inputSchema: { "type": "object", "properties": { "n": { "type": "number" } }, "required": ["n"] }',
      '  implementation: "const n = input.n || 0; return { result: n * 2 };"',
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Alpha", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [primordialProvider],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  const events = await withTimeout(
    () => collectEvents(runtime.run({ kind: "text", text: "Forge the doubler tool now." })),
    TIMEOUT_MS,
    "Test 1",
  );

  // Allow fire-and-forget notifications to settle
  await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_SETTLE_MS));

  // Check LLM called forge_tool
  const toolStarts = extractToolStarts(events);
  const forgeStarts = toolStarts.filter((e) => e.toolName === "forge_tool");
  assert("Alpha LLM called forge_tool", forgeStarts.length >= 1, `got ${forgeStarts.length} calls`);

  // Check store has the brick
  const searchResult = await store.search({ kind: "tool", text: "doubler" });
  const hasBrick = searchResult.ok && searchResult.value.length >= 1;
  assert("store contains 'doubler' brick", hasBrick);

  if (searchResult.ok && searchResult.value.length >= 1) {
    const brick = searchResult.value[0];
    if (brick !== undefined) {
      assert("brick lifecycle is active", brick.lifecycle === "active", `got ${brick.lifecycle}`);
      assert("brick scope is agent (default)", brick.scope === "agent", `got ${brick.scope}`);
      console.log(`    Brick ID: ${brick.id}`);
    }
  }

  // Check notifier received "saved" event
  const savedEvents = allEvents.filter((e, i) => i >= eventCountBefore1 && e.kind === "saved");
  assert(
    "notifier fired 'saved' event",
    savedEvents.length >= 1,
    `got ${savedEvents.length} saved events`,
  );

  // Check done event
  const hasDone = events.some((e) => e.kind === "done");
  assert("run completed with done event", hasDone);
} catch (err: unknown) {
  assert("Test 1 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: Agent Alpha promotes brick to global scope
// ---------------------------------------------------------------------------

console.log("\n[test 2] Agent Alpha promotes doubler to global scope\n");

const eventCountBefore2 = allEvents.length;

try {
  // Find the brick ID from the store
  const searchResult = await store.search({ kind: "tool", text: "doubler" });
  if (!searchResult.ok || searchResult.value.length === 0) {
    assert("Test 2 requires doubler brick from test 1", false, "brick not found in store");
  } else {
    const brickId = searchResult.value[0]?.id;
    if (brickId === undefined) {
      assert("brick has ID", false, "brick ID is undefined");
    } else {
      const alphaDeps2 = makeDeps("alpha-agent", 1);
      const primordialProvider2 = makePrimordialProvider(alphaDeps2);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: [
          "You have ONE task: use the promote_forge tool to promote a brick.",
          `Call promote_forge with these arguments:`,
          `  brickId: "${brickId}"`,
          `  targetScope: "global"`,
          "Do NOT say anything before calling the tool. Just call it immediately.",
        ].join("\n"),
        getApiKey: async () => API_KEY,
      });

      const runtime = await createKoi({
        manifest: { name: "Alpha-Promote", version: "0.1.0", model: { name: E2E_MODEL } },
        adapter,
        providers: [primordialProvider2],
        loopDetection: false,
        limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await withTimeout(
        () =>
          collectEvents(runtime.run({ kind: "text", text: "Promote the doubler to global now." })),
        TIMEOUT_MS,
        "Test 2",
      );

      // Allow fire-and-forget notifications to settle
      await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_SETTLE_MS));

      // Check LLM called promote_forge
      const toolStarts = extractToolStarts(events);
      const promoteStarts = toolStarts.filter((e) => e.toolName === "promote_forge");
      assert(
        "Alpha LLM called promote_forge",
        promoteStarts.length >= 1,
        `got ${promoteStarts.length} calls`,
      );

      // Check brick scope updated to global
      const loadResult = await store.load(brickId);
      if (loadResult.ok) {
        assert(
          "brick scope is now 'global'",
          loadResult.value.scope === "global",
          `got ${loadResult.value.scope}`,
        );
      } else {
        assert("brick loaded after promotion", false, "load failed");
      }

      // Check notifier fired event after promotion
      // In-memory store has no promote() method, so it fires "updated" not "promoted"
      const postPromoteEvents = allEvents.filter(
        (e, i) => i >= eventCountBefore2 && (e.kind === "updated" || e.kind === "promoted"),
      );
      assert(
        "notifier fired event after promotion",
        postPromoteEvents.length >= 1,
        `got ${postPromoteEvents.length} events: ${postPromoteEvents.map((e) => e.kind).join(", ")}`,
      );

      // Check done event
      const hasDone = events.some((e) => e.kind === "done");
      assert("promote run completed with done event", hasDone);
    }
  }
} catch (err: unknown) {
  assert("Test 2 completed without error", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Agent Beta discovers + executes the promoted doubler
// ---------------------------------------------------------------------------

console.log("\n[test 3] Agent Beta discovers + executes the promoted doubler\n");

const forgeProvider = createForgeComponentProvider({
  store,
  executor: tieredExecutor,
  notifier,
});

try {
  // Create usage middleware
  const usageMiddleware = createForgeUsageMiddleware({
    store,
    config,
    resolveBrickId: (toolName) => forgeProvider.lookupBrickId(toolName),
    notifier,
  });

  const adapter = createPiAdapter({
    model: E2E_MODEL,
    systemPrompt: [
      "You have ONE task: use the doubler tool to double a number.",
      'Call the doubler tool with: { "n": 21 }',
      "After getting the result, report the doubled value in your response.",
      "Do NOT say anything before calling the tool. Just call it immediately.",
    ].join("\n"),
    getApiKey: async () => API_KEY,
  });

  const runtime = await createKoi({
    manifest: { name: "Beta", version: "0.1.0", model: { name: E2E_MODEL } },
    adapter,
    providers: [forgeProvider],
    middleware: [usageMiddleware],
    loopDetection: false,
    limits: { maxTurns: 10, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
  });

  // Check lookupBrickId resolves AFTER createKoi (which calls attach) but BEFORE run
  // (the run may trigger notifications that invalidate the provider cache)
  const resolvedIdPreRun = forgeProvider.lookupBrickId("doubler");
  assert(
    "forgeProvider.lookupBrickId('doubler') resolves after attach",
    resolvedIdPreRun !== undefined,
    `got ${resolvedIdPreRun}`,
  );

  const events = await withTimeout(
    () =>
      collectEvents(
        runtime.run({ kind: "text", text: "Double the number 21 using the doubler tool." }),
      ),
    TIMEOUT_MS,
    "Test 3",
  );

  // Allow fire-and-forget notifications to settle
  await new Promise((resolve) => setTimeout(resolve, NOTIFICATION_SETTLE_MS));

  // Check LLM called doubler
  const toolStarts = extractToolStarts(events);
  const doublerStarts = toolStarts.filter((e) => e.toolName === "doubler");
  assert(
    "Beta LLM called doubler tool",
    doublerStarts.length >= 1,
    `got ${doublerStarts.length} calls; all tools called: [${toolStarts.map((e) => e.toolName).join(", ")}]`,
  );

  // Check tool result contains 42
  // tool_call_end events have callId + result but NOT toolName.
  // Correlate via callId from the tool_call_start event.
  const toolEnds = extractToolEnds(events);
  const doublerCallId = doublerStarts[0]?.callId;
  const matchingEnd =
    doublerCallId !== undefined ? toolEnds.find((e) => e.callId === doublerCallId) : toolEnds[0]; // fallback to first tool_call_end
  if (matchingEnd !== undefined) {
    const output = JSON.stringify(matchingEnd.result ?? "");
    assert(
      "doubler tool output contains 42",
      output.includes("42"),
      `got output: ${output.slice(0, 200)}`,
    );
  } else {
    assert(
      "doubler tool_call_end emitted",
      false,
      `no tool_call_end matching callId ${String(doublerCallId)}`,
    );
  }

  // Check text response mentions 42
  const text = extractText(events);
  assert("Beta response mentions 42", text.includes("42"), `response: ${text.slice(0, 200)}`);

  // Check usage count incremented (use pre-run resolved ID since notifications invalidate cache)
  if (resolvedIdPreRun !== undefined) {
    const loadResult = await store.load(resolvedIdPreRun);
    if (loadResult.ok) {
      assert(
        "brick usageCount > 0 after Beta's run",
        loadResult.value.usageCount > 0,
        `usageCount = ${loadResult.value.usageCount}`,
      );
    } else {
      assert("brick loaded for usage check", false, "load failed");
    }
  }

  // Check done event
  const hasDone = events.some((e) => e.kind === "done");
  assert("Beta run completed with done event", hasDone);
} catch (err: unknown) {
  assert("Test 3 completed without error", false, err instanceof Error ? err.message : String(err));
} finally {
  forgeProvider.dispose();
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);
console.log(`[e2e] Total notifier events captured: ${allEvents.length}`);
const breakdown: Record<string, number> = {};
for (const e of allEvents) {
  breakdown[e.kind] = (breakdown[e.kind] ?? 0) + 1;
}
console.log(`[e2e] Event breakdown: ${JSON.stringify(breakdown)}`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All cross-agent pi-engine E2E tests passed!");
