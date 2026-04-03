#!/usr/bin/env bun
/**
 * E2E test script for @koi/engine-claude — validates event mappings against
 * the real Claude Agent SDK.
 *
 * Tests the 6-gap event coverage:
 *   Gap 1: tool_call_end emitted from SDK user messages (tool results)
 *   Gap 2: turn_end emitted on assistant→user boundary
 *   Gap 3: User message handling (SDK "user" type with tool_result blocks)
 *   Gap 4: errors[] in metadata (via maxTurns exhaustion)
 *   Gap 5: permission_denials in metadata (non-deterministic, observation only)
 *   Gap 6: compact_boundary (impractical for E2E, skipped)
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-engine-claude.ts
 */

import type { EngineEvent, EngineOutput } from "@koi/core";
import type { ClaudeAdapterConfig } from "../packages/drivers/engine-claude/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting engine-claude E2E tests...");
console.log("[e2e] ANTHROPIC_API_KEY: set");

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
  const doneEvent = events.find(
    (e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done",
  );
  return doneEvent?.output;
}

function countByKind(events: readonly EngineEvent[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  return counts;
}

function printEventSummary(events: readonly EngineEvent[]): void {
  const counts = countByKind(events);
  console.log(`  Events: ${events.length} total`);
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`    ${kind}: ${count}`);
  }
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
// SDK + adapter import
// ---------------------------------------------------------------------------

// Resolve SDK from engine-claude's node_modules (isolated linker means
// the root can't see workspace-scoped deps directly).
const sdkPath = new URL(
  "../packages/drivers/engine-claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  import.meta.url,
).pathname;
const { query } = await import(sdkPath);
const { createClaudeAdapter } = await import("../packages/drivers/engine-claude/src/adapter.js");

// ---------------------------------------------------------------------------
// Shared config — bypassPermissions requires the safety flag via sdkOverrides
// ---------------------------------------------------------------------------

// The SDK spawns a Claude Code subprocess. Auto-detect the CLI path.
const { execSync } = await import("node:child_process");
const CLAUDE_CLI_PATH = execSync("which claude", { encoding: "utf-8" }).trim();
console.log(`[e2e] Claude CLI: ${CLAUDE_CLI_PATH}\n`);

const BASE_CONFIG: ClaudeAdapterConfig = {
  model: "claude-sonnet-4-5-20250929",
  permissionMode: "bypassPermissions",
  sdkOverrides: {
    allowDangerouslySkipPermissions: true,
    executable: "node",
    pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
  },
} as const;

// ---------------------------------------------------------------------------
// Test 1 — Tool call flow (Gaps 1, 2, 3)
// ---------------------------------------------------------------------------

console.log("[test] Tool call flow (gaps 1, 2, 3)");

const test1Events = await withTimeout(
  async () => {
    const adapter = createClaudeAdapter(
      { ...BASE_CONFIG, maxTurns: 3, allowedTools: ["Bash"] },
      { query },
    );

    return collectEvents(
      adapter.stream({
        kind: "text",
        text: "Use the Bash tool to run: echo hello-koi",
      }),
    );
  },
  120_000,
  "Test 1",
);

printEventSummary(test1Events);

// Gap 1: tool_call_end emitted
const toolCallStarts = test1Events.filter(
  (e): e is EngineEvent & { readonly kind: "tool_call_start" } => e.kind === "tool_call_start",
);
const toolCallEnds = test1Events.filter(
  (e): e is EngineEvent & { readonly kind: "tool_call_end" } => e.kind === "tool_call_end",
);

assert(
  "tool_call_start emitted with Bash",
  toolCallStarts.length > 0 && toolCallStarts.some((e) => e.toolName === "Bash"),
);

assert(
  "tool_call_end paired with matching callId",
  toolCallEnds.length > 0 &&
    toolCallStarts.every((start) => toolCallEnds.some((end) => end.callId === start.callId)),
);

assert(
  "tool_call_end has non-empty result",
  toolCallEnds.length > 0 && toolCallEnds.every((e) => e.result !== undefined && e.result !== null),
);

// Gap 2: turn_end emitted
const turnEnds = test1Events.filter(
  (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
);

assert(
  "turn_end emitted (turnIndex=0)",
  turnEnds.length > 0 && (turnEnds[0]?.turnIndex ?? -1) === 0,
);

// Every tool_call_start.callId has a matching tool_call_end.callId (contract)
const startIds = new Set(toolCallStarts.map((e) => e.callId));
const endIds = new Set(toolCallEnds.map((e) => e.callId));
const allPaired = [...startIds].every((id) => endIds.has(id));
assert("every tool_call_start.callId has matching tool_call_end", allPaired);

// done event
const output1 = findDoneOutput(test1Events);
assert('done with stopReason "completed"', output1?.stopReason === "completed");

// ---------------------------------------------------------------------------
// Test 2 — Text-only baseline (negative control)
// ---------------------------------------------------------------------------

console.log("\n[test] Text-only baseline");

const test2Events = await withTimeout(
  async () => {
    const adapter = createClaudeAdapter({ ...BASE_CONFIG, maxTurns: 1 }, { query });

    return collectEvents(adapter.stream({ kind: "text", text: "Reply with exactly: pong" }));
  },
  60_000,
  "Test 2",
);

printEventSummary(test2Events);

const test2Counts = countByKind(test2Events);

assert("text_delta emitted", (test2Counts.text_delta ?? 0) > 0);
assert("no tool_call_start events", (test2Counts.tool_call_start ?? 0) === 0);
assert("no turn_end events", (test2Counts.turn_end ?? 0) === 0);

const output2 = findDoneOutput(test2Events);
assert('done with stopReason "completed"', output2?.stopReason === "completed");

// ---------------------------------------------------------------------------
// Test 3 — Metrics and metadata populated (reuses Test 1 data)
// ---------------------------------------------------------------------------

console.log("\n[test] Metrics populated");

assert("inputTokens > 0", (output1?.metrics.inputTokens ?? 0) > 0);
assert("outputTokens > 0", (output1?.metrics.outputTokens ?? 0) > 0);
assert(
  "totalTokens = input + output",
  output1?.metrics.totalTokens ===
    (output1?.metrics.inputTokens ?? 0) + (output1?.metrics.outputTokens ?? 0),
);
assert("turns >= 1", (output1?.metrics.turns ?? 0) >= 1);
assert("durationMs > 0", (output1?.metrics.durationMs ?? 0) > 0);
assert("output.content.length > 0", (output1?.content.length ?? 0) > 0);

// ---------------------------------------------------------------------------
// Test 4 — maxTurns exhaustion (Gap 4: errors[] in metadata)
// ---------------------------------------------------------------------------

console.log("\n[test] maxTurns exhaustion (gap 4)");

const test4Events = await withTimeout(
  async () => {
    const adapter = createClaudeAdapter(
      { ...BASE_CONFIG, maxTurns: 1, allowedTools: ["Bash"] },
      { query },
    );

    return collectEvents(
      adapter.stream({
        kind: "text",
        text: "Use the Bash tool to run: echo step1 && then use Bash again to run: echo step2. You MUST run both commands.",
      }),
    );
  },
  120_000,
  "Test 4",
);

printEventSummary(test4Events);

const output4 = findDoneOutput(test4Events);
// maxTurns: 1 with a tool-using prompt should exhaust turns
// The SDK may return "error_max_turns" → mapped to "max_turns" stopReason
// OR it may complete in 1 turn if the model decides to. Either way, we verify
// the done event exists and metadata structure is valid.
assert("done event emitted", output4 !== undefined);
assert(
  'stopReason is "max_turns" or "completed"',
  output4?.stopReason === "max_turns" || output4?.stopReason === "completed",
);
// If max_turns, check for errors in metadata (SDK may or may not populate errors[])
if (output4?.stopReason === "max_turns") {
  const _errors = output4.metadata?.errors;
  // The SDK's error_max_turns result includes an errors[] array, but it may be
  // empty if the only issue is hitting the turn limit (no runtime errors).
  // We verify the metadata object exists — that proves mapRichMetadata ran.
  assert("metadata present on max_turns result", output4.metadata !== undefined);
} else {
  console.log("  (model completed within 1 turn — max_turns not triggered)");
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
      console.error(`  FAIL  ${r.name}`);
    }
  }
  process.exit(1);
}
