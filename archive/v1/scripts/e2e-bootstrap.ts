#!/usr/bin/env bun
/**
 * Manual E2E test: @koi/bootstrap → context hydrator → real LLM call.
 *
 * Creates a .koi/ hierarchy with instruction files, resolves them via
 * resolveBootstrap(), wires through the context hydrator middleware,
 * and makes a real Anthropic API call to verify the LLM sees the
 * bootstrap content.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-bootstrap.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoopAdapter } from "../packages/drivers/engine-loop/src/loop-adapter.js";
import { createAnthropicAdapter } from "../packages/drivers/model-router/src/adapters/anthropic.js";
import { resolveBootstrap } from "../packages/kernel/bootstrap/src/resolve.js";
import type { EngineEvent, ModelRequest } from "../packages/kernel/core/src/index.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { createMockAgent } from "../packages/lib/test-utils/src/agents.js";
import { createContextHydrator } from "../packages/mm/context/src/hydrator.js";
import type { TextSource } from "../packages/mm/context/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping.");
  process.exit(1);
}

console.log("[e2e] Starting bootstrap E2E test...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
}

const results: TestResult[] = [];

function assert(name: string, condition: boolean): void {
  results.push({ name, passed: condition });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
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
      console.log(`  - ${r.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Set up temp .koi/ hierarchy
// ---------------------------------------------------------------------------

console.log("[setup] Creating .koi/ hierarchy...");

const tempDir = await mkdtemp(join(tmpdir(), "koi-e2e-bootstrap-"));

// Secret phrase the LLM must echo back — proves bootstrap content was injected
const SECRET = `PINEAPPLE-${Date.now()}`;

await Bun.write(
  join(tempDir, ".koi", "INSTRUCTIONS.md"),
  [
    "You are a concise test agent.",
    `Your secret code is: ${SECRET}`,
    "When asked for your secret code, reply with ONLY the code and nothing else.",
    "Do not add any explanation, greeting, or formatting.",
  ].join("\n"),
);

await Bun.write(
  join(tempDir, ".koi", "TOOLS.md"),
  "You have no tools. Never attempt to call any tool.",
);

await Bun.write(
  join(tempDir, ".koi", "CONTEXT.md"),
  "Project context: This is an E2E validation test for the @koi/bootstrap package.",
);

// Agent-specific override — replaces project-level INSTRUCTIONS.md
await Bun.write(
  join(tempDir, ".koi", "agents", "e2e-agent", "INSTRUCTIONS.md"),
  [
    "You are a concise E2E test agent running in agent-specific mode.",
    `Your secret code is: ${SECRET}`,
    "When asked for your secret code, reply with ONLY the code and nothing else.",
    "Do not add any explanation, greeting, or formatting.",
  ].join("\n"),
);

console.log(`[setup] Temp dir: ${tempDir}`);
console.log(`[setup] Secret: ${SECRET}\n`);

// ---------------------------------------------------------------------------
// 2. Resolve bootstrap — project-level
// ---------------------------------------------------------------------------

console.log("[test 1] resolveBootstrap (project-level)");

const projectResult = await resolveBootstrap({ rootDir: tempDir });

assert("resolveBootstrap returns ok", projectResult.ok === true);
if (!projectResult.ok) {
  console.error("  Bootstrap failed:", projectResult.error);
  await rm(tempDir, { recursive: true, force: true });
  process.exit(1);
}

assert(
  "3 sources resolved (INSTRUCTIONS + TOOLS + CONTEXT)",
  projectResult.value.sources.length === 3,
);
assert("no warnings", projectResult.value.warnings.length === 0);

for (const resolved of projectResult.value.resolved) {
  console.log(
    `  [resolved] ${resolved.fileName} (${resolved.content.length} chars, hash=${resolved.contentHash})`,
  );
}
console.log();

// ---------------------------------------------------------------------------
// 3. Resolve bootstrap — agent-specific override
// ---------------------------------------------------------------------------

console.log("[test 2] resolveBootstrap (agent-specific: e2e-agent)");

const agentResult = await resolveBootstrap({
  rootDir: tempDir,
  agentName: "e2e-agent",
});

assert("agent resolveBootstrap returns ok", agentResult.ok === true);
if (!agentResult.ok) {
  console.error("  Bootstrap failed:", agentResult.error);
  await rm(tempDir, { recursive: true, force: true });
  process.exit(1);
}

assert(
  "3 sources resolved (agent INSTRUCTIONS + project TOOLS + project CONTEXT)",
  agentResult.value.sources.length === 3,
);

const instructionsSlot = agentResult.value.resolved.find((r) => r.fileName === "INSTRUCTIONS.md");
assert(
  "INSTRUCTIONS.md resolved from agent-specific path",
  instructionsSlot?.resolvedFrom.includes("agents/e2e-agent") === true,
);
assert(
  "agent-specific content contains override text",
  instructionsSlot?.content.includes("agent-specific mode") === true,
);

for (const resolved of agentResult.value.resolved) {
  console.log(`  [resolved] ${resolved.fileName} (from=${resolved.resolvedFrom})`);
}
console.log();

// ---------------------------------------------------------------------------
// 4. Wire through context hydrator + createKoi + real LLM call
// ---------------------------------------------------------------------------

console.log("[test 3] Real LLM call with bootstrap context");
console.log(`  Model: claude-sonnet-4-5-20250929`);
console.log(`  Testing: LLM receives bootstrap instructions and echoes secret\n`);

// Model adapter
const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
const modelCall = (request: ModelRequest) =>
  anthropic.complete({ ...request, model: "claude-sonnet-4-5-20250929" });

// Engine adapter (1 turn max — just need a single model call)
const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 1 });

// Convert BootstrapTextSource[] → ContextSource[] (structural compatibility)
const contextSources: readonly TextSource[] = agentResult.value.sources.map((s) => ({
  kind: s.kind,
  text: s.text,
  label: s.label,
  priority: s.priority,
}));

// Context hydrator middleware — uses mock agent (text sources don't need real agent)
const mockAgent = createMockAgent();
const hydrator = createContextHydrator({
  config: { sources: contextSources },
  agent: mockAgent,
});

// Assemble the full runtime
const runtime = await createKoi({
  manifest: {
    name: "bootstrap-e2e",
    version: "0.1.0",
    model: { name: "claude-sonnet-4-5" },
  },
  adapter: loopAdapter,
  middleware: [hydrator],
  loopDetection: false,
});

console.log(`  Agent assembled (state: ${runtime.agent.state})`);
console.log(`  Sending: "What is your secret code?"\n`);

let fullResponse = "";
const events: EngineEvent[] = [];

for await (const event of runtime.run({
  kind: "text",
  text: "What is your secret code?",
})) {
  events.push(event);
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

// ---------------------------------------------------------------------------
// 5. Verify LLM response contains the secret
// ---------------------------------------------------------------------------

console.log("\n[test 3] Verifying LLM saw bootstrap content...");

assert("LLM response is non-empty", fullResponse.length > 0);
assert(`LLM response contains secret (${SECRET})`, fullResponse.includes(SECRET));

const doneEvent = events.find((e) => e.kind === "done");
assert(
  "run completed successfully",
  doneEvent?.kind === "done" && doneEvent.output.stopReason === "completed",
);

// Verify hydrator state
const hydrationResult = hydrator.getHydrationResult();
assert("hydrator resolved 3 sources", hydrationResult?.sources.length === 3);
assert("hydrator content contains secret", hydrationResult?.content.includes(SECRET) === true);
assert(
  "hydrator content contains agent-specific text",
  hydrationResult?.content.includes("agent-specific mode") === true,
);

// ---------------------------------------------------------------------------
// 6. Cleanup + report
// ---------------------------------------------------------------------------

await rm(tempDir, { recursive: true, force: true });

printReport();

const failed = results.filter((r) => !r.passed).length;
if (failed > 0) {
  process.exit(1);
}

console.log("\n[e2e] BOOTSTRAP E2E VALIDATION PASSED");
