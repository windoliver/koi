#!/usr/bin/env bun
/**
 * E2E test: FsForgeStore filesystem watcher + dispose chain + real LLM calls.
 *
 * Validates the full pipeline at two levels:
 *
 *   Direct Pi adapter (Tests 1-3):
 *   1. FsForgeStore with watch: true detects cross-process brick writes
 *   2. ForgeRuntime.onChange fires when watcher detects external change
 *   3. Pi adapter uses hot-attached forged tools from watched store
 *
 *   Full L1 runtime via createKoi (Tests 5-6):
 *   5. createKoi + forge option + Pi adapter → L1 middleware chain + forged tools
 *   6. Forge tool externally WHILE createKoi is assembled → onChange → next run sees it
 *
 *   Dispose (Test 7):
 *   7. dispose() chain cleans up watchers + timers (no leaked handles)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-fs-watcher.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDescriptor } from "../packages/core/src/ecs.js";
import type { EngineAdapter, EngineEvent, EngineInput } from "../packages/core/src/engine.js";
import type { SandboxExecutor } from "../packages/core/src/index.js";
import type {
  ModelHandler,
  ModelStreamHandler,
  ToolRequest,
  ToolResponse,
} from "../packages/core/src/middleware.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createPiAdapter } from "../packages/engine-pi/src/adapter.js";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeRuntime } from "../packages/forge/src/forge-runtime.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";
import { createFsForgeStore } from "../packages/store-fs/src/fs-store.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping fs-watcher E2E test.");
  process.exit(0);
}

console.log("[e2e] Starting FsForgeStore watcher E2E test (Pi adapter + real Claude API)...");
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
// Shared sandbox executor (simple Function-based, same as e2e-hot-attach)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeForgeDeps(
  store: Awaited<ReturnType<typeof createFsForgeStore>>,
  label: string,
): ForgeDeps {
  return {
    store,
    executor,
    verifiers: [],
    config: createDefaultForgeConfig({ maxForgesPerSession: 10 }),
    context: {
      agentId: `e2e-watcher-${label}`,
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 0,
    },
  };
}

async function buildCallHandlers(
  adapter: EngineAdapter,
  forgeRuntime: ReturnType<typeof createForgeRuntime>,
): Promise<{
  readonly modelCall: ModelHandler;
  readonly modelStream: ModelStreamHandler;
  readonly toolCall: (request: ToolRequest) => Promise<ToolResponse>;
  readonly tools: readonly ToolDescriptor[];
}> {
  const descriptors = await forgeRuntime.toolDescriptors();
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
// Test 1: Cross-process watcher detection
//
// Two FsForgeStore instances share the same directory.
// Store A watches, Store B writes. Verify Store A detects the change.
// ---------------------------------------------------------------------------

console.log("[test 1] Cross-process watcher: Store B writes → Store A (watching) detects change");

const tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-watcher-"));

try {
  // Store A watches the directory
  const storeA = await createFsForgeStore({ baseDir: tempDir, watch: true });

  // ForgeRuntime backed by Store A
  const runtimeA = createForgeRuntime({ store: storeA, executor });

  const beforeA = await runtimeA.toolDescriptors();
  assert("Store A starts empty", beforeA.length === 0, `found ${beforeA.length} tools`);

  // Subscribe to onChange on the watching runtime
  let onChangeCountA = 0;
  const unsubA = runtimeA.onChange?.(() => {
    onChangeCountA++;
  });
  assert("runtimeA.onChange is available", unsubA !== undefined);

  // Store B: non-watching, same directory — simulates another process
  const storeB = await createFsForgeStore({ baseDir: tempDir });
  const depsB = makeForgeDeps(storeB, "process-B");
  const forgeToolB = createForgeToolTool(depsB);

  // Forge a tool via Store B (the "other process")
  console.log("  Forging 'adder' via Store B (other process)...");
  const forgeResult = await forgeToolB.execute({
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
    typeof forgeResult === "object" &&
    forgeResult !== null &&
    "ok" in forgeResult &&
    (forgeResult as { ok: boolean }).ok;
  assert("forge_tool 'adder' via Store B succeeded", forgeOk);

  // Wait for watcher debounce (100ms) + onChange debounce (50ms) + margin
  console.log("  Waiting for fs.watch debounce (300ms)...");
  await new Promise((r) => setTimeout(r, 300));

  assert(
    "Store A onChange fired (watcher detected external write)",
    onChangeCountA >= 1,
    `count: ${onChangeCountA}`,
  );

  // ForgeRuntime should now see the tool via watched store
  const afterA = await runtimeA.toolDescriptors();
  assert(
    "Store A ForgeRuntime sees 'adder' after watcher rescan",
    afterA.some((d) => d.name === "adder"),
    `tools: ${afterA.map((d) => d.name).join(", ")}`,
  );

  // Resolve and test the tool
  const resolvedAdder = await runtimeA.resolveTool("adder");
  assert("resolveTool('adder') via Store A succeeds", resolvedAdder !== undefined);

  if (resolvedAdder !== undefined) {
    const toolResult = await resolvedAdder.execute({ a: 17, b: 25 });
    assert("adder(17, 25) = { sum: 42 }", JSON.stringify(toolResult).includes("42"));
  }

  // --- Test 2: Pi adapter uses the cross-process forged tool ----------------

  console.log("\n[test 2] Pi adapter: real Claude API call using cross-process forged 'adder'");

  const adapter = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. When asked to add numbers, always use the 'adder' tool. " +
      "Do not compute manually — you must use the tool.",
    getApiKey: async () => API_KEY,
  });

  const handlers = await buildCallHandlers(adapter, runtimeA);
  assert(
    "callHandlers includes 'adder' from watched store",
    handlers.tools.some((t) => t.name === "adder"),
    `tools: ${handlers.tools.map((t) => t.name).join(", ")}`,
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
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${events.length} total):`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }

  assert("received events from Pi adapter", events.length > 0);
  assert(
    "has done event",
    events.some((e) => e.kind === "done"),
  );

  const toolCallStarts = events.filter((e) => e.kind === "tool_call_start");
  const toolCallEnds = events.filter((e) => e.kind === "tool_call_end");

  if (toolCallStarts.length > 0) {
    const toolNames = toolCallStarts.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'adder'", toolNames.includes("adder"));

    if (toolCallEnds.length > 0) {
      const adderEnd = toolCallEnds.find((e) => "result" in e);
      if (adderEnd && "result" in adderEnd) {
        const resultStr = JSON.stringify(adderEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("adder returned sum=42", resultStr.includes("42"));
      }
    }
  } else {
    assert("Claude called 'adder'", false, "no tool_call_start events");
  }

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

  // --- Test 3: Second tool forged mid-session via watcher ------------------

  console.log("\n[test 3] Second tool forged externally → watcher detects → Pi adapter sees both");

  // Reset onChange counter
  onChangeCountA = 0;

  const forgeResult2 = await forgeToolB.execute({
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

  const forge2Ok =
    typeof forgeResult2 === "object" &&
    forgeResult2 !== null &&
    "ok" in forgeResult2 &&
    (forgeResult2 as { ok: boolean }).ok;
  assert("forge_tool 'multiplier' via Store B succeeded", forge2Ok);

  // Wait for watcher
  await new Promise((r) => setTimeout(r, 300));

  assert(
    "Store A onChange fired for second forge",
    onChangeCountA >= 1,
    `count: ${onChangeCountA}`,
  );

  const descriptorsAfter2 = await runtimeA.toolDescriptors();
  assert(
    "Store A sees both 'adder' and 'multiplier'",
    descriptorsAfter2.some((d) => d.name === "adder") &&
      descriptorsAfter2.some((d) => d.name === "multiplier"),
    `tools: ${descriptorsAfter2.map((d) => d.name).join(", ")}`,
  );

  // Pi adapter with both tools
  const adapter2 = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. Use the 'multiplier' tool when asked to multiply numbers.",
    getApiKey: async () => API_KEY,
  });

  const handlers2 = await buildCallHandlers(adapter2, runtimeA);
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

  const toolCallStarts2 = events2.filter((e) => e.kind === "tool_call_start");
  const toolCallEnds2 = events2.filter((e) => e.kind === "tool_call_end");

  if (toolCallStarts2.length > 0) {
    const toolNames = toolCallStarts2.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'multiplier'", toolNames.includes("multiplier"));

    if (toolCallEnds2.length > 0) {
      const multEnd = toolCallEnds2.find((e) => "result" in e);
      if (multEnd && "result" in multEnd) {
        const resultStr = JSON.stringify(multEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("multiplier(6, 7) returned product=42", resultStr.includes("42"));
      }
    }
  } else {
    assert("Claude called 'multiplier'", false, "no tool_call_start events");
  }

  await adapter2.dispose();

  // --- Test 5: Full L1 runtime via createKoi + forge + watcher ---------------

  console.log("\n[test 5] Full L1 runtime: createKoi + forge + watcher → real Claude API call");

  const piAdapter5 = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. When asked to add numbers, always use the 'adder' tool. " +
      "Do not compute manually — you must use the tool.",
    getApiKey: async () => API_KEY,
  });

  // Wire through createKoi — this exercises:
  //  - L1 guard creation (iteration, loop, spawn)
  //  - Middleware chain composition
  //  - forge.onChange subscription (createKoi subscribes internally)
  //  - Dynamic callHandlers.tools getter (entity + forged descriptors)
  //  - Tool resolution: entity first, then forge fallback via defaultToolTerminal
  //  - turn_start / turn_end event emission (L1-only, not emitted by Pi adapter alone)
  const koiRuntime = await createKoi({
    manifest: { name: "fs-watcher-e2e", version: "0.1.0", model: { name: "claude-sonnet-4-5" } },
    adapter: piAdapter5,
    forge: runtimeA,
    loopDetection: false,
  });

  assert("createKoi assembled agent (state=created)", koiRuntime.agent.state === "created");

  console.log("  Calling Claude via createKoi runtime (full L1 path)...");
  const koiEvents = await withTimeout(
    async () => {
      const collected: EngineEvent[] = [];
      for await (const event of koiRuntime.run({
        kind: "text",
        text: "What is 17 + 25? Use the adder tool.",
      })) {
        collected.push(event);
        if (collected.length >= 100) break;
      }
      return collected;
    },
    120_000,
    "Test 5 — createKoi runtime.run",
  );

  // Log event summary
  const counts5: Record<string, number> = {};
  for (const e of koiEvents) {
    counts5[e.kind] = (counts5[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${koiEvents.length} total):`);
  for (const [kind, count] of Object.entries(counts5)) {
    console.log(`    ${kind}: ${count}`);
  }

  assert("received events from createKoi runtime", koiEvents.length > 0);

  // turn_start is L1-only — proves we went through createKoi, not just Pi adapter
  assert(
    "has turn_start event (L1-only, proves full runtime path)",
    koiEvents.some((e) => e.kind === "turn_start"),
  );
  assert(
    "has done event",
    koiEvents.some((e) => e.kind === "done"),
  );

  // Verify tool calls
  const toolStarts5 = koiEvents.filter((e) => e.kind === "tool_call_start");
  const toolEnds5 = koiEvents.filter((e) => e.kind === "tool_call_end");

  if (toolStarts5.length > 0) {
    const toolNames = toolStarts5.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert("Claude called 'adder' via L1 runtime", toolNames.includes("adder"));

    if (toolEnds5.length > 0) {
      const adderEnd = toolEnds5.find((e) => "result" in e);
      if (adderEnd && "result" in adderEnd) {
        const resultStr = JSON.stringify(adderEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("adder returned sum=42 via L1 runtime", resultStr.includes("42"));
      }
    }
  } else {
    assert("Claude called 'adder' via L1 runtime", false, "no tool_call_start events");
  }

  // Check metrics
  const doneEvent5 = koiEvents.find((e) => e.kind === "done");
  if (doneEvent5 !== undefined && "output" in doneEvent5) {
    const output5 = (
      doneEvent5 as { output: { metrics: { inputTokens: number; outputTokens: number } } }
    ).output;
    console.log(
      `  Tokens: input=${output5.metrics.inputTokens}, output=${output5.metrics.outputTokens}`,
    );
    assert("inputTokens > 0 (L1 runtime)", output5.metrics.inputTokens > 0);
  }

  // Check text output
  const textDeltas5 = koiEvents.filter((e) => e.kind === "text_delta");
  if (textDeltas5.length > 0) {
    const fullText = textDeltas5.map((e) => ("delta" in e ? e.delta : "")).join("");
    console.log(`  Claude text: "${fullText.slice(0, 120)}"`);
  }

  await koiRuntime.dispose();

  // --- Test 6: Forge tool externally WHILE createKoi has active onChange ------

  console.log("\n[test 6] Forge tool externally → createKoi forge.onChange sees it on next run");

  const piAdapter6 = createPiAdapter({
    model: "anthropic:claude-sonnet-4-5-20250929",
    systemPrompt:
      "You are a helpful assistant. When asked to subtract numbers, always use the 'subtractor' tool. " +
      "Do not compute manually — you must use the tool.",
    getApiKey: async () => API_KEY,
  });

  const koiRuntime6 = await createKoi({
    manifest: { name: "fs-watcher-e2e-6", version: "0.1.0", model: { name: "claude-sonnet-4-5" } },
    adapter: piAdapter6,
    forge: runtimeA,
    loopDetection: false,
  });

  // Forge a NEW tool via Store B (external process) while createKoi is assembled
  console.log("  Forging 'subtractor' via Store B while createKoi is assembled...");
  const forgeResult6 = await forgeToolB.execute({
    name: "subtractor",
    description: "Subtracts b from a. Pass a and b as numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "Number to subtract from" },
        b: { type: "number", description: "Number to subtract" },
      },
      required: ["a", "b"],
    },
    implementation: "return { difference: (input.a || 0) - (input.b || 0) };",
  });

  assert(
    "forge_tool 'subtractor' via Store B succeeded",
    typeof forgeResult6 === "object" &&
      forgeResult6 !== null &&
      "ok" in forgeResult6 &&
      (forgeResult6 as { ok: boolean }).ok,
  );

  // Wait for watcher + onChange to propagate
  console.log("  Waiting for fs.watch → onChange → createKoi forge refresh...");
  await new Promise((r) => setTimeout(r, 400));

  // Verify runtimeA (forge) sees subtractor
  const descriptorsAfter6 = await runtimeA.toolDescriptors();
  assert(
    "ForgeRuntime sees 'subtractor' after external forge",
    descriptorsAfter6.some((d) => d.name === "subtractor"),
    `tools: ${descriptorsAfter6.map((d) => d.name).join(", ")}`,
  );

  // Run a NEW query — createKoi should pick up the new tool via the dirty flag / onChange
  console.log("  Calling Claude via createKoi (should see 'subtractor')...");
  const koiEvents6 = await withTimeout(
    async () => {
      const collected: EngineEvent[] = [];
      for await (const event of koiRuntime6.run({
        kind: "text",
        text: "What is 100 - 58? Use the subtractor tool.",
      })) {
        collected.push(event);
        if (collected.length >= 100) break;
      }
      return collected;
    },
    120_000,
    "Test 6 — createKoi with newly forged tool",
  );

  // Log event summary
  const counts6: Record<string, number> = {};
  for (const e of koiEvents6) {
    counts6[e.kind] = (counts6[e.kind] ?? 0) + 1;
  }
  console.log(`  Events (${koiEvents6.length} total):`);
  for (const [kind, count] of Object.entries(counts6)) {
    console.log(`    ${kind}: ${count}`);
  }

  const toolStarts6 = koiEvents6.filter((e) => e.kind === "tool_call_start");
  if (toolStarts6.length > 0) {
    const toolNames = toolStarts6.map((e) => ("toolName" in e ? e.toolName : "?"));
    console.log(`  Tools called: ${toolNames.join(", ")}`);
    assert(
      "Claude called 'subtractor' (newly forged tool detected via watcher → createKoi onChange)",
      toolNames.includes("subtractor"),
    );

    const toolEnds6 = koiEvents6.filter((e) => e.kind === "tool_call_end");
    if (toolEnds6.length > 0) {
      const subEnd = toolEnds6.find((e) => "result" in e);
      if (subEnd && "result" in subEnd) {
        const resultStr = JSON.stringify(subEnd.result);
        console.log(`  Tool result: ${resultStr}`);
        assert("subtractor(100, 58) returned difference=42", resultStr.includes("42"));
      }
    }
  } else {
    assert(
      "Claude called 'subtractor' (newly forged tool detected via watcher → createKoi onChange)",
      false,
      "no tool_call_start events",
    );
  }

  await koiRuntime6.dispose();

  // --- Test 7: Dispose chain — verify cleanup works -------------------------

  console.log("\n[test 7] Dispose chain: dispose stops all notifications");

  onChangeCountA = 0;

  // Dispose the forge runtime + store (this should close the watcher)
  runtimeA.dispose?.();
  storeA.dispose();

  // Forge another tool via Store B — Store A should NOT fire onChange
  const forgeResult3 = await forgeToolB.execute({
    name: "divider",
    description: "Divides two numbers. Pass a and b as numbers.",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "Dividend" },
        b: { type: "number", description: "Divisor" },
      },
      required: ["a", "b"],
    },
    implementation: "return { quotient: (input.a || 0) / (input.b || 1) };",
  });

  assert(
    "forge_tool 'divider' via Store B succeeded",
    typeof forgeResult3 === "object" &&
      forgeResult3 !== null &&
      "ok" in forgeResult3 &&
      (forgeResult3 as { ok: boolean }).ok,
  );

  // Wait generously
  await new Promise((r) => setTimeout(r, 400));

  assert(
    "After dispose, Store A onChange did NOT fire",
    onChangeCountA === 0,
    `count: ${onChangeCountA}`,
  );

  // Cleanup Store B
  storeB.dispose();
  if (unsubA !== undefined) unsubA();
} catch (err: unknown) {
  assert("Test suite completed", false, err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Cleanup temp directory
// ---------------------------------------------------------------------------

await rm(tempDir, { recursive: true, force: true });

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

console.log("\n[e2e] All FsForgeStore watcher E2E tests passed!");
