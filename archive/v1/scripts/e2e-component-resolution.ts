#!/usr/bin/env bun

/**
 * E2E: Issue #246 — ComponentProvider Resolution Semantics.
 *
 * Validates the full createKoi → createLoopAdapter path with:
 * 1. Priority-sorted assembly (lower number wins, first-write-wins)
 * 2. AssemblyConflict[] reporting when providers supply the same key
 * 3. Forge-first tool resolution (forged tool shadows entity tool at call-time)
 * 4. Descriptor deduplication (forged descriptors shadow entity by name)
 * 5. Real LLM call through middleware chain to prove wiring works end-to-end
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-component-resolution.ts
 *
 * Can also run without a key (scripted model mode):
 *   bun scripts/e2e-component-resolution.ts
 */

import { createLoopAdapter } from "../packages/drivers/engine-loop/src/loop-adapter.js";
import type {
  ComponentProvider,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  ModelRequest,
  ModelResponse,
  Tool,
  ToolDescriptor,
} from "../packages/kernel/core/src/index.js";
import { COMPONENT_PRIORITY, toolToken } from "../packages/kernel/core/src/index.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import type { ForgeRuntime } from "../packages/kernel/engine/src/types.js";

// ---------------------------------------------------------------------------
// Helpers
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
  console.log(`  ${tag}  ${name}${detail && !condition ? ` (${detail})` : ""}`);
}

function printReport(): void {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\n${"\u2500".repeat(60)}`);
  console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
  console.log("\u2500".repeat(60));

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const result: EngineEvent[] = [];
  for await (const event of iterable) {
    result.push(event);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scripted model (deterministic — no API key needed)
// ---------------------------------------------------------------------------

function createScriptedModel(
  script: readonly ((request: ModelRequest) => ModelResponse)[],
): (request: ModelRequest) => Promise<ModelResponse> {
  // let justified: mutable turn counter
  let turn = 0;
  return async (request: ModelRequest): Promise<ModelResponse> => {
    const handler = script[turn];
    if (handler === undefined) {
      return { content: "Script exhausted", model: "scripted" };
    }
    turn++;
    return handler(request);
  };
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

function createTrackingTool(
  name: string,
  tag: string,
): {
  readonly tool: Tool;
  readonly calls: Array<{ readonly input: unknown; readonly tag: string }>;
} {
  const calls: Array<{ readonly input: unknown; readonly tag: string }> = [];
  const tool: Tool = {
    descriptor: {
      name,
      description: `${tag} version of ${name}`,
      inputSchema: { type: "object" },
    },
    trustTier: "sandbox",
    execute: async (input: JsonObject): Promise<unknown> => {
      calls.push({ input, tag });
      return { result: `${tag}:${name}`, tag };
    },
  };
  return { tool, calls };
}

// ---------------------------------------------------------------------------
// Test 1: Priority-sorted assembly + conflict reporting
// ---------------------------------------------------------------------------

async function testAssemblyConflicts(): Promise<void> {
  console.log("\n--- Test 1: Priority-sorted assembly + conflict reporting ---\n");

  const { tool: bundledCalc } = createTrackingTool("calc", "bundled");
  const { tool: forgedCalc } = createTrackingTool("calc", "forged");

  // Bundled provider: priority 100 (default)
  const bundledProvider: ComponentProvider = {
    name: "bundled-tools",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async () => new Map<string, unknown>([[toolToken("calc") as string, bundledCalc]]),
  };

  // Agent-forged provider: priority 0 (highest precedence)
  const forgedProvider: ComponentProvider = {
    name: "agent-forged-tools",
    priority: COMPONENT_PRIORITY.AGENT_FORGED,
    attach: async () => new Map<string, unknown>([[toolToken("calc") as string, forgedCalc]]),
  };

  // Provide bundled FIRST in array — but agent-forged should win by priority
  const modelCall = createScriptedModel([
    () => ({ content: "No tools needed.", model: "scripted" }),
  ]);
  const adapter = createLoopAdapter({ modelCall, maxTurns: 1 });

  const runtime = await createKoi({
    manifest: { name: "conflict-test", version: "0.1.0", model: { name: "scripted" } },
    adapter,
    providers: [bundledProvider, forgedProvider],
    loopDetection: false,
  });

  // Check conflicts
  assert(
    "conflicts array has 1 entry (calc key collision)",
    runtime.conflicts.length === 1,
    `got ${runtime.conflicts.length}`,
  );

  if (runtime.conflicts.length > 0) {
    const conflict = runtime.conflicts[0];
    if (conflict === undefined) throw new Error("unreachable");
    assert("conflict key is tool:calc", conflict.key === "tool:calc", `got ${conflict.key}`);
    assert(
      "conflict winner is agent-forged-tools (priority 0)",
      conflict.winner === "agent-forged-tools",
      `got ${conflict.winner}`,
    );
    assert(
      "conflict shadowed includes bundled-tools",
      conflict.shadowed.includes("bundled-tools"),
      `got ${JSON.stringify(conflict.shadowed)}`,
    );
  }

  // Verify the winning component is indeed the forged one
  const resolvedCalc = runtime.agent.component(toolToken("calc"));
  assert(
    "agent.component() returns forged calc (priority 0 wins)",
    resolvedCalc === forgedCalc,
    resolvedCalc === bundledCalc ? "got bundled instead" : "got unknown",
  );

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Test 2: Forge-first tool resolution at call-time
// ---------------------------------------------------------------------------

async function testForgeFirstResolution(): Promise<void> {
  console.log("\n--- Test 2: Forge-first tool resolution (shadow pattern) ---\n");

  const { tool: entityGreet, calls: entityCalls } = createTrackingTool("greet", "entity");
  const { tool: forgedGreet, calls: forgeCalls } = createTrackingTool("greet", "forged");

  // Entity provider (bundled in assembly)
  const entityProvider: ComponentProvider = {
    name: "entity-tools",
    attach: async () => new Map<string, unknown>([[toolToken("greet") as string, entityGreet]]),
  };

  // ForgeRuntime that shadows "greet" at call-time
  const forge: ForgeRuntime = {
    resolveTool: async (toolId: string): Promise<Tool | undefined> => {
      if (toolId === "greet") return forgedGreet;
      return undefined;
    },
    toolDescriptors: async (): Promise<readonly ToolDescriptor[]> => [forgedGreet.descriptor],
  };

  // Scripted model calls "greet" tool, then gives final text
  const modelCall = createScriptedModel([
    () => ({
      content: "Let me greet.",
      model: "scripted",
      metadata: {
        toolCalls: [{ toolName: "greet", callId: "call-0", input: { name: "World" } }],
      } as JsonObject,
    }),
    () => ({ content: "Greeting done.", model: "scripted" }),
  ]);

  const adapter = createLoopAdapter({ modelCall, maxTurns: 3 });

  const runtime = await createKoi({
    manifest: { name: "forge-first-test", version: "0.1.0", model: { name: "scripted" } },
    adapter,
    forge,
    providers: [entityProvider],
    loopDetection: false,
  });

  const events = await collectEvents(runtime.run({ kind: "text", text: "Say hello" }));

  // Forged tool should have been called (forge-first resolution)
  assert(
    "forged greet was called (forge-first)",
    forgeCalls.length === 1,
    `forgeCalls=${forgeCalls.length}`,
  );
  assert(
    "entity greet was NOT called (shadowed by forge)",
    entityCalls.length === 0,
    `entityCalls=${entityCalls.length}`,
  );

  // Verify tool_call_end event has forged result
  const toolEnd = events.find((e) => e.kind === "tool_call_end");
  if (toolEnd?.kind === "tool_call_end") {
    const result = toolEnd.result as Record<string, unknown>;
    assert("tool result tag is 'forged'", result.tag === "forged", `got tag=${String(result.tag)}`);
  } else {
    assert("tool_call_end event found", false, "missing");
  }

  // Verify done event
  const doneEvent = events.find((e) => e.kind === "done");
  assert(
    "run completed successfully",
    doneEvent?.kind === "done" && doneEvent.output.stopReason === "completed",
  );

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Test 3: Descriptor deduplication (forged shadows entity by name)
// ---------------------------------------------------------------------------

async function testDescriptorDedup(): Promise<void> {
  console.log("\n--- Test 3: Descriptor deduplication (forged wins by name) ---\n");

  const { tool: entityCalc } = createTrackingTool("calc", "entity");
  const { tool: entitySearch } = createTrackingTool("search", "entity");

  const entityProvider: ComponentProvider = {
    name: "entity-tools",
    attach: async () =>
      new Map<string, unknown>([
        [toolToken("calc") as string, entityCalc],
        [toolToken("search") as string, entitySearch],
      ]),
  };

  // Forge provides a "calc" descriptor (shadows entity) + "special" (additive)
  const forgedCalcDescriptor: ToolDescriptor = {
    name: "calc",
    description: "Forged calculator",
    inputSchema: { type: "object" },
  };
  const specialDescriptor: ToolDescriptor = {
    name: "special",
    description: "Forged-only tool",
    inputSchema: { type: "object" },
  };

  const forge: ForgeRuntime = {
    resolveTool: async () => undefined,
    toolDescriptors: async () => [forgedCalcDescriptor, specialDescriptor],
  };

  // Intercepting adapter: wraps loop adapter to capture callHandlers.tools from EngineInput
  // let justified: mutable capture of the tools list seen by the adapter
  let capturedTools: readonly ToolDescriptor[] = [];

  const innerAdapter = createLoopAdapter({
    modelCall: createScriptedModel([() => ({ content: "Done.", model: "scripted" })]),
    maxTurns: 1,
  });

  const interceptingAdapter: EngineAdapter = {
    engineId: "intercepting-loop",
    terminals: innerAdapter.terminals,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      // Capture callHandlers.tools from the EngineInput that koi.ts passes
      if (input.callHandlers !== undefined) {
        capturedTools = input.callHandlers.tools;
      }
      return innerAdapter.stream(input);
    },
  };

  const runtime = await createKoi({
    manifest: { name: "dedup-test", version: "0.1.0", model: { name: "scripted" } },
    adapter: interceptingAdapter,
    forge,
    providers: [entityProvider],
    loopDetection: false,
  });

  await collectEvents(runtime.run({ kind: "text", text: "inspect tools" }));

  // Verify dedup: forged "calc" + forged "special" + entity "search" = 3 total
  // Entity "calc" should be deduped out (forged "calc" wins by name)
  assert(
    "total tool descriptors = 3 (forged calc + forged special + entity search)",
    capturedTools.length === 3,
    `got ${capturedTools.length}: [${capturedTools.map((d) => d.name).join(", ")}]`,
  );

  const calcDesc = capturedTools.find((d) => d.name === "calc");
  assert(
    "calc descriptor is forged version (description check)",
    calcDesc?.description === "Forged calculator",
    `got description="${calcDesc?.description}"`,
  );

  const hasSearch = capturedTools.some((d) => d.name === "search");
  assert("entity-only 'search' still present", hasSearch);

  const hasSpecial = capturedTools.some((d) => d.name === "special");
  assert("forged-only 'special' present", hasSpecial);

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Test 4: Real LLM call (optional, requires ANTHROPIC_API_KEY)
// ---------------------------------------------------------------------------

async function testRealLlm(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log("\n--- Test 4: Real LLM call (SKIPPED — no ANTHROPIC_API_KEY) ---\n");
    return;
  }

  console.log("\n--- Test 4: Real LLM call through assembled runtime with forge ---\n");

  const { createAnthropicAdapter } = await import(
    "../packages/drivers/model-router/src/adapters/anthropic.js"
  );

  const SECRET = `MAGIC_${Date.now()}`;

  const anthropic = createAnthropicAdapter({ apiKey });
  const modelCall = (request: ModelRequest) =>
    anthropic.complete({ ...request, model: "claude-haiku-4-5-20251001", maxTokens: 100 });

  // Entity tools: bundled calc + search
  const { tool: entityCalc } = createTrackingTool("calc", "entity");
  const { tool: entitySearch } = createTrackingTool("search", "entity");

  const entityProvider: ComponentProvider = {
    name: "entity-tools",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async () =>
      new Map<string, unknown>([
        [toolToken("calc") as string, entityCalc],
        [toolToken("search") as string, entitySearch],
      ]),
  };

  // Forge: shadows "calc" descriptor (different description) + adds "special"
  const forgedCalcDescriptor: ToolDescriptor = {
    name: "calc",
    description: "Forged calculator (shadowed)",
    inputSchema: { type: "object" },
  };
  const specialDescriptor: ToolDescriptor = {
    name: "special",
    description: "Forged-only tool",
    inputSchema: { type: "object" },
  };

  const forge: ForgeRuntime = {
    resolveTool: async () => undefined,
    toolDescriptors: async () => [forgedCalcDescriptor, specialDescriptor],
  };

  // Intercepting adapter: captures callHandlers.tools, then delegates to real loop adapter
  // let justified: mutable capture
  let capturedTools: readonly ToolDescriptor[] = [];

  const innerAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

  const interceptingAdapter: EngineAdapter = {
    engineId: "intercepting-loop",
    terminals: innerAdapter.terminals,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      if (input.callHandlers !== undefined) {
        capturedTools = input.callHandlers.tools;
      }
      return innerAdapter.stream(input);
    },
  };

  const runtime = await createKoi({
    manifest: { name: "real-llm-e2e", version: "0.1.0", model: { name: "claude-haiku-4-5" } },
    adapter: interceptingAdapter,
    forge,
    providers: [entityProvider],
    loopDetection: false,
  });

  console.log(`  Conflicts: ${runtime.conflicts.length}`);
  console.log(`  Sending: "Reply with exactly: ${SECRET}"\n`);

  let fullResponse = "";

  for await (const event of runtime.run({
    kind: "text",
    text: `Reply with exactly this text and nothing else: ${SECRET}`,
  })) {
    if (event.kind === "text_delta") {
      fullResponse += event.delta;
      process.stdout.write(event.delta);
    } else if (event.kind === "done") {
      console.log(
        `\n\n  [done] stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`,
      );
      console.log(
        `  [done] tokens: ${event.output.metrics.inputTokens} in / ${event.output.metrics.outputTokens} out`,
      );
    }
  }

  console.log();

  // Verify real LLM response came through
  assert(
    `LLM response contains secret (${SECRET})`,
    fullResponse.includes(SECRET),
    `response="${fullResponse.substring(0, 100)}"`,
  );

  // Verify descriptor dedup worked with real adapter (same as Test 3 but with real LLM)
  assert(
    "callHandlers.tools has 3 descriptors (forged calc + forged special + entity search)",
    capturedTools.length === 3,
    `got ${capturedTools.length}: [${capturedTools.map((d) => d.name).join(", ")}]`,
  );

  const calcDesc = capturedTools.find((d) => d.name === "calc");
  assert(
    "calc descriptor is forged version in real LLM path",
    calcDesc?.description === "Forged calculator (shadowed)",
    `got "${calcDesc?.description}"`,
  );

  // Verify conflicts were tracked
  assert(
    "no assembly conflicts (forge doesn't go through providers)",
    runtime.conflicts.length === 0,
    `got ${runtime.conflicts.length}`,
  );

  await runtime.dispose();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(
    "\n\u2550\u2550\u2550 E2E: Issue #246 — ComponentProvider Resolution Semantics \u2550\u2550\u2550\n",
  );

  await testAssemblyConflicts();
  await testForgeFirstResolution();
  await testDescriptorDedup();
  await testRealLlm();

  printReport();

  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    process.exit(1);
  }

  console.log("\n[e2e] COMPONENT RESOLUTION E2E VALIDATION PASSED");
}

main().catch((error: unknown) => {
  console.error("\nE2E FAILED:", error);
  process.exit(1);
});
