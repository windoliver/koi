#!/usr/bin/env bun

/**
 * E2E test script for hot-attach with Pi engine adapter + real Claude API calls.
 *
 * Validates the full pipeline:
 *   1. forge_tool → store.watch fires typed events → ForgeRuntime cache invalidation
 *   2. ForgeRuntime.toolDescriptors() → build tool definitions
 *   3. ForgeRuntime.resolveTool() → callable Tool (sandbox execution)
 *   4. Pi adapter with callHandlers → real Claude API → Claude calls forged tool
 *   5. Forge second tool mid-session → watch → ForgeRuntime sees both
 *
 * Uses createPiAdapter().stream() directly with composed callHandlers.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-hot-attach.ts
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type { ToolDescriptor } from "../packages/kernel/core/src/ecs.js";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
} from "../packages/kernel/core/src/engine.js";
import type { SandboxExecutor } from "../packages/kernel/core/src/index.js";
import type {
  ModelHandler,
  ModelStreamHandler,
  ToolRequest,
  ToolResponse,
} from "../packages/kernel/core/src/middleware.js";
import { createDefaultForgeConfig } from "../packages/meta/forge/src/config.js";
import { createForgeRuntime } from "../packages/meta/forge/src/forge-runtime.js";
import { createInMemoryForgeStore } from "../packages/meta/forge/src/memory-store.js";
import { createForgeToolTool } from "../packages/meta/forge/src/tools/forge-tool.js";
import type { ForgeDeps } from "../packages/meta/forge/src/tools/shared.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping hot-attach E2E test.");
  process.exit(0);
}

console.log("[e2e] Starting hot-attach E2E test (Pi adapter + real Claude API)...");
console.log("[e2e] ANTHROPIC_API_KEY: set\n");

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
  const suffix = detail && !condition ? ` — ${detail}` : "";
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

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
  maxEvents = 100,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (events.length >= maxEvents) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Forge + ForgeRuntime setup
// ---------------------------------------------------------------------------

const store = createInMemoryForgeStore();

const executor: SandboxExecutor = {
  execute: async (code, input, _timeout) => {
    try {
      const fn = new Function("input", code) as (input: unknown) => unknown;
      const output = fn(input);
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

const config = createDefaultForgeConfig({ maxForgesPerSession: 10 });
const deps: ForgeDeps = {
  store,
  executor,
  verifiers: [],
  config,
  context: {
    agentId: "e2e-hot-attach-agent",
    depth: 0,
    sessionId: `e2e-${Date.now()}`,
    forgesThisSession: 0,
  },
};

const forgeTool = createForgeToolTool(deps);

const forgeRuntime = createForgeRuntime({
  store,
  executor,
});

// ---------------------------------------------------------------------------
// Helper: build callHandlers from ForgeRuntime descriptors + adapter terminals
// ---------------------------------------------------------------------------

async function buildCallHandlers(adapter: EngineAdapter): Promise<{
  readonly modelCall: ModelHandler;
  readonly modelStream: ModelStreamHandler;
  readonly toolCall: (request: ToolRequest) => Promise<ToolResponse>;
  readonly tools: readonly ToolDescriptor[];
}> {
  const descriptors = await forgeRuntime.toolDescriptors();

  // Use the adapter's own terminals — the model stream terminal reads from a WeakMap
  // side-channel that the bridge populates with the real streamSimple function.
  // Without these terminals, the bridge has no way to call the actual LLM.
  const modelStream = adapter.terminals?.modelStream;
  const modelCall = adapter.terminals?.modelCall;
  if (modelStream === undefined || modelCall === undefined) {
    throw new Error("Pi adapter must expose terminals.modelStream and terminals.modelCall");
  }

  return {
    modelCall,
    modelStream,
    toolCall: async (request: ToolRequest): Promise<ToolResponse> => {
      const tool = await forgeRuntime.resolveTool(request.toolId);
      if (tool === undefined) {
        return { output: `Unknown tool: ${request.toolId}` };
      }
      const result = await tool.execute(request.input);
      return { output: result };
    },
    tools: descriptors,
  };
}

// ---------------------------------------------------------------------------
// Test 1: onChange pipeline — forge tool, verify ForgeRuntime sees it
// ---------------------------------------------------------------------------

console.log("[test 1] watch pipeline: forge → store.watch → ForgeRuntime cache invalidation");

try {
  const before = await forgeRuntime.toolDescriptors();
  assert("forgeRuntime starts empty", before.length === 0, `found ${before.length} tools`);

  let watchCount = 0;
  const unsub = forgeRuntime.watch?.(() => {
    watchCount++;
  });
  assert("forgeRuntime.watch is available", unsub !== undefined);

  const result = await forgeTool.execute({
    name: "adder",
    description: "Adds two numbers together. Pass a and b as numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    implementation: "return { sum: (input.a || 0) + (input.b || 0) };",
  });

  const forgeOk =
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { ok: boolean }).ok;
  assert("forge_tool 'adder' succeeded", forgeOk, JSON.stringify(result).slice(0, 200));

  await new Promise((r) => setTimeout(r, 50));
  assert("watch fired", watchCount >= 1, `count: ${watchCount}`);

  const after = await forgeRuntime.toolDescriptors();
  assert(
    "forgeRuntime sees 'adder'",
    after.some((d) => d.name === "adder"),
  );

  const resolved = await forgeRuntime.resolveTool("adder");
  assert("resolveTool('adder') returns a tool", resolved !== undefined);

  if (resolved !== undefined) {
    const toolResult = await resolved.execute({ a: 17, b: 25 });
    assert("adder(17, 25) = { sum: 42 }", JSON.stringify(toolResult).includes("42"));
  }

  if (unsub !== undefined) unsub();
} catch (err: unknown) {
  assert("Test 1 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 2: Pi adapter → real Claude API → calls forged tool
// ---------------------------------------------------------------------------

console.log("\n[test 2] Pi adapter: real Claude API call with forged 'adder' tool");

try {
  const adapter = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. When asked to add numbers, always use the 'adder' tool. " +
      "Do not compute manually — you must use the tool.",
    getApiKey: async () => API_KEY,
  });

  const handlers = await buildCallHandlers(adapter);
  assert(
    "callHandlers has 'adder' descriptor",
    handlers.tools.some((t) => t.name === "adder"),
  );

  const input: EngineInput = {
    kind: "text",
    text: "What is 17 + 25? Use the adder tool.",
    callHandlers: handlers,
  };

  console.log("  Calling Claude via Pi adapter...");
  const events = await withTimeout(
    () => collectEvents(adapter.stream(input)),
    120_000,
    "Test 2 — Pi adapter stream",
  );

  // Log event summary
  const eventKinds = events.map((e) => e.kind);
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${events.length} total):`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }

  assert("received events from Pi adapter", events.length > 0, `count: ${events.length}`);
  assert("has done event", eventKinds.includes("done"));

  // Check for text output
  const textDeltas = events.filter((e) => e.kind === "text_delta");
  assert(
    "Claude produced text response",
    textDeltas.length > 0,
    `text_delta count: ${textDeltas.length}`,
  );

  if (textDeltas.length > 0) {
    const fullText = textDeltas.map((e) => ("delta" in e ? e.delta : "")).join("");
    console.log(`  Claude text: "${fullText.slice(0, 120)}"`);
  }

  // Check for tool calls
  const toolCallStarts = events.filter((e) => e.kind === "tool_call_start");
  const toolCallEnds = events.filter((e) => e.kind === "tool_call_end");

  const hasToolCalls = toolCallStarts.length > 0;
  assert("Claude called a tool", hasToolCalls, `tool_call_start count: ${toolCallStarts.length}`);

  if (hasToolCalls) {
    const toolNames = toolCallStarts.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'adder'", toolNames.includes("adder"), `tools: ${toolNames.join(", ")}`);

    // Check tool result
    if (toolCallEnds.length > 0) {
      const adderEnd = toolCallEnds.find((e) => "result" in e);
      if (adderEnd && "result" in adderEnd) {
        const resultStr = JSON.stringify(adderEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("adder returned sum=42", resultStr.includes("42"), `result: ${resultStr}`);
      }
    }
  }

  // Check metrics
  const doneEvent = events.find((e) => e.kind === "done");
  if (doneEvent !== undefined && "output" in doneEvent) {
    const output = (
      doneEvent as { output: { metrics: { inputTokens: number; outputTokens: number } } }
    ).output;
    console.log(
      `  Tokens: input=${output.metrics.inputTokens}, output=${output.metrics.outputTokens}`,
    );
    assert("inputTokens > 0", output.metrics.inputTokens > 0);
  }

  await adapter.dispose();
} catch (err: unknown) {
  assert("Test 2 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Test 3: Forge second tool → onChange → Pi adapter sees both
// ---------------------------------------------------------------------------

console.log("\n[test 3] Forge second tool → watch → Pi adapter sees both tools");

try {
  let watchCount = 0;
  const unsub = forgeRuntime.watch?.(() => {
    watchCount++;
  });

  const result = await forgeTool.execute({
    name: "multiplier",
    description: "Multiplies two numbers together. Pass a and b as numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
    implementation: "return { product: (input.a || 0) * (input.b || 0) };",
  });

  const forgeOk =
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    (result as { ok: boolean }).ok;
  assert("forge_tool 'multiplier' succeeded", forgeOk, JSON.stringify(result).slice(0, 200));

  await new Promise((r) => setTimeout(r, 50));
  assert("watch fired for second forge", watchCount >= 1);

  const descriptors = await forgeRuntime.toolDescriptors();
  assert(
    "ForgeRuntime sees both 'adder' and 'multiplier'",
    descriptors.some((d) => d.name === "adder") && descriptors.some((d) => d.name === "multiplier"),
    `tools: ${descriptors.map((d) => d.name).join(", ")}`,
  );

  // Now use Pi adapter with both tools
  const adapter2 = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. Use the 'multiplier' tool when asked to multiply numbers.",
    getApiKey: async () => API_KEY,
  });

  const handlers2 = await buildCallHandlers(adapter2);
  assert(
    "callHandlers has both tools",
    handlers2.tools.length >= 2,
    `tool count: ${handlers2.tools.length}`,
  );

  console.log("  Calling Claude via Pi adapter (with both forged tools)...");
  const events2 = await withTimeout(
    () =>
      collectEvents(
        adapter2.stream({
          kind: "text",
          text: "What is 6 * 7? Use the multiplier tool.",
          callHandlers: handlers2,
        }),
      ),
    120_000,
    "Test 3 — Pi adapter stream",
  );

  const toolCallStarts = events2.filter((e) => e.kind === "tool_call_start");
  const toolCallEnds = events2.filter((e) => e.kind === "tool_call_end");

  if (toolCallStarts.length > 0) {
    const toolNames = toolCallStarts.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'multiplier'", toolNames.includes("multiplier"));

    if (toolCallEnds.length > 0) {
      const multEnd = toolCallEnds.find((e) => "result" in e);
      if (multEnd && "result" in multEnd) {
        const resultStr = JSON.stringify(multEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert(
          "multiplier(6, 7) returned product=42",
          resultStr.includes("42"),
          `result: ${resultStr}`,
        );
      }
    }
  } else {
    assert("Claude called 'multiplier'", false, "no tool_call_start events");
  }

  // Log event summary
  const counts: Record<string, number> = {};
  for (const e of events2) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${events2.length} total):`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }

  await adapter2.dispose();
  if (unsub !== undefined) unsub();
} catch (err: unknown) {
  assert("Test 3 completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All hot-attach E2E tests passed!");
