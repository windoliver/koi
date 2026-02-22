/**
 * One-off validation: forge tool → real LLM → engine executes forged tool.
 *
 * Run: ANTHROPIC_API_KEY=... bun scripts/validate-forge-llm.ts
 * Then delete this file — it's a manual validation, not a permanent test.
 */

import type { EngineEvent, ModelRequest } from "../packages/core/src/index.js";
import { createKoi } from "../packages/engine/src/koi.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { createDefaultForgeConfig } from "../packages/forge/src/config.js";
import { createForgeComponentProvider } from "../packages/forge/src/forge-component-provider.js";
import { createInMemoryForgeStore } from "../packages/forge/src/memory-store.js";
import { createForgeToolTool } from "../packages/forge/src/tools/forge-tool.js";
import type { ForgeDeps } from "../packages/forge/src/tools/shared.js";
import type { ForgeResult, SandboxExecutor } from "../packages/forge/src/types.js";
import { createAnthropicAdapter } from "../packages/model-router/src/adapters/anthropic.js";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ANTHROPIC_API_KEY not set");
  process.exit(1);
}

const anthropic = createAnthropicAdapter({ apiKey });
const modelCall = (request: ModelRequest) =>
  anthropic.complete({ ...request, model: "claude-sonnet-4-5-20250929" });

// --- Forge an "adder" tool ---
const store = createInMemoryForgeStore();
const executor: SandboxExecutor = {
  execute: async (_code, input, _timeout) => {
    const obj = input as { readonly a: number; readonly b: number };
    return { ok: true, value: { output: { sum: obj.a + obj.b }, durationMs: 1 } };
  },
};

const deps: ForgeDeps = {
  store,
  executor,
  verifiers: [],
  config: createDefaultForgeConfig(),
  context: { agentId: "e2e-real", depth: 0, sessionId: "real-session", forgesThisSession: 0 },
};

const forgeTool = createForgeToolTool(deps);
const forgeResult = (await forgeTool.execute({
  name: "adder",
  description: "Adds two numbers. Input: { a: number, b: number }. Returns { sum: number }.",
  inputSchema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  implementation: "return { sum: input.a + input.b };",
})) as { readonly ok: true; readonly value: ForgeResult };

if (!forgeResult.ok) {
  console.error("Forge failed:", forgeResult);
  process.exit(1);
}
console.log(`Forged tool "${forgeResult.value.name}" (${forgeResult.value.id})`);

// --- Create engine with forge provider ---
const forgeProvider = createForgeComponentProvider({ store, executor });
const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 5 });

const runtime = await createKoi({
  manifest: { name: "Real LLM E2E Agent", version: "0.1.0", model: { name: "claude-sonnet-4-5" } },
  adapter: loopAdapter,
  providers: [forgeProvider],
  loopDetection: false,
});

console.log(`Agent assembled (state: ${runtime.agent.state})`);
console.log("Sending: 'Use the adder tool to add 17 and 25.'");

const events: EngineEvent[] = [];
for await (const event of runtime.run({
  kind: "text",
  text: "Use the adder tool to add 17 and 25. Return the result.",
})) {
  events.push(event);
  if (event.kind === "text_delta") {
    process.stdout.write(event.delta);
  } else if (event.kind === "tool_call_start") {
    console.log(`\n[tool_call_start] ${event.toolName} (${event.callId})`);
  } else if (event.kind === "tool_call_end") {
    console.log(`[tool_call_end] ${JSON.stringify(event.result)}`);
  } else if (event.kind === "turn_end") {
    console.log(`[turn_end] turn ${event.turnIndex}`);
  } else if (event.kind === "done") {
    console.log(
      `\n[done] stopReason=${event.output.stopReason} turns=${event.output.metrics.turns}`,
    );
  }
}

console.log(`Final agent state: ${runtime.agent.state}`);

// --- Verify ---
const toolCalls = events.filter((e) => e.kind === "tool_call_start");
const toolResults = events.filter((e) => e.kind === "tool_call_end");
const done = events.find((e) => e.kind === "done");

if (toolCalls.length === 0) {
  console.error("\nFAIL: LLM did not call the adder tool");
  process.exit(1);
}
if (toolResults.length === 0) {
  console.error("\nFAIL: No tool results");
  process.exit(1);
}
if (done?.kind === "done" && done.output.stopReason !== "completed") {
  console.error(`\nFAIL: stopReason=${done.output.stopReason}`);
  process.exit(1);
}

console.log("\nVALIDATION PASSED: Forge -> real LLM -> tool execution -> result");
