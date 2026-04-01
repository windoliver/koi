#!/usr/bin/env bun
/**
 * E2E test script for @koi/forge Phase 2.5 features:
 *   Feature 1 — Usage recording (recordBrickUsage)
 *   Feature 2 — Content integrity verification (verifyBrickIntegrity, loadAndVerify)
 *
 * Validates the full cycle with a real Claude API call:
 *   1. Claude forges a tool via forge_tool
 *   2. We record usage N times → observe usage count incrementing
 *   3. We verify content integrity of the forged brick (pass)
 *   4. We tamper the brick → verify integrity catches it (fail)
 *   5. loadAndVerify returns both brick and integrity result from store
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-forge-usage-integrity.ts
 */

import type { BrickArtifact, SandboxExecutor } from "../packages/kernel/core/src/index.js";
import { createAdversarialVerifiers } from "../packages/meta/forge/src/adversarial-verifiers.js";
import { createDefaultForgeConfig } from "../packages/meta/forge/src/config.js";
import { loadAndVerify, verifyBrickIntegrity } from "../packages/meta/forge/src/integrity.js";
import { createInMemoryForgeStore } from "../packages/meta/forge/src/memory-store.js";
import { createForgeToolTool } from "../packages/meta/forge/src/tools/forge-tool.js";
import type { ForgeDeps } from "../packages/meta/forge/src/tools/shared.js";
import type { ForgeResult } from "../packages/meta/forge/src/types.js";
import { recordBrickUsage } from "../packages/meta/forge/src/usage.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping usage/integrity E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting forge usage + integrity E2E tests...");
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

// ---------------------------------------------------------------------------
// Forge setup
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

const config = createDefaultForgeConfig({
  maxForgesPerSession: 50,
});

const verifiers = createAdversarialVerifiers(executor);

function makeDeps(): ForgeDeps {
  return {
    store,
    executor,
    verifiers,
    config,
    context: {
      agentId: "e2e-usage-integrity-agent",
      depth: 0,
      sessionId: `e2e-${Date.now()}`,
      forgesThisSession: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Claude API — minimal agent loop (reused from e2e-forge.ts pattern)
// ---------------------------------------------------------------------------

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface ApiMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly ContentBlock[];
}

interface ApiResponse {
  readonly id: string;
  readonly content: readonly ContentBlock[];
  readonly stop_reason: string;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

const MODEL = "claude-sonnet-4-5-20250929";

const forgeTool = createForgeToolTool(makeDeps());

async function callClaude(
  messages: readonly ApiMessage[],
  systemPrompt: string,
): Promise<ApiResponse> {
  const toolDefs = [
    {
      name: forgeTool.descriptor.name,
      description: forgeTool.descriptor.description,
      input_schema: forgeTool.descriptor.inputSchema,
    },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      tools: toolDefs,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API error (${response.status}): ${body}`);
  }

  return response.json() as Promise<ApiResponse>;
}

async function runAgentLoop(
  userMessage: string,
  systemPrompt: string,
  maxTurns = 5,
): Promise<{
  readonly toolCalls: readonly { readonly name: string; readonly result: unknown }[];
  readonly finalText: string;
}> {
  const messages: ApiMessage[] = [{ role: "user", content: userMessage }];
  const toolCalls: { name: string; result: unknown }[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callClaude(messages, systemPrompt);

    const toolUseBlocks = response.content.filter(
      (
        b,
      ): b is ContentBlock & {
        readonly type: "tool_use";
        readonly id: string;
        readonly name: string;
        readonly input: Record<string, unknown>;
      } => b.type === "tool_use",
    );

    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find((b) => b.type === "text");
      return { toolCalls, finalText: textBlock?.text ?? "" };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      let result: unknown;
      try {
        result = await forgeTool.execute(block.input);
      } catch (err: unknown) {
        result = {
          ok: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
      toolCalls.push({ name: block.name, result });
      toolResults.push({
        type: "tool_result",
        // @ts-expect-error — tool_result content block has tool_use_id
        tool_use_id: block.id,
        // @ts-expect-error — tool_result content block has content string
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { toolCalls, finalText: "(max turns reached)" };
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
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a tool-forging agent. You have access to forge_tool which creates a new executable tool. Required fields:
- name (string, 3-50 chars, alphanumeric/dash/underscore, starts with letter)
- description (string)
- inputSchema (object with "type" field)
- implementation (string of JS code that handles empty input gracefully)

IMPORTANT: The implementation is tested with an empty {} input — it MUST handle missing fields gracefully.
When asked to forge something, call forge_tool with valid arguments. Be precise.`;

// ═══════════════════════════════════════════════════════════════════════════
// Test 1: Forge a tool via Claude (real LLM call)
// ═══════════════════════════════════════════════════════════════════════════

console.log("[test 1] Forge a tool via Claude (real LLM call)");

let forgedBrickId: string | undefined;

try {
  const { toolCalls } = await withTimeout(
    () =>
      runAgentLoop(
        "Forge a tool called 'add-numbers' that adds two numbers. Implementation: const a = Number(input.a) || 0; const b = Number(input.b) || 0; return { sum: a + b }; — inputSchema should accept 'a' and 'b' number fields.",
        SYSTEM_PROMPT,
      ),
    60_000,
    "Test 1",
  );

  const forgeCall = toolCalls.find((c) => c.name === "forge_tool");
  assert("Claude called forge_tool", forgeCall !== undefined);

  if (forgeCall !== undefined) {
    const result = forgeCall.result as { readonly ok: boolean; readonly value?: ForgeResult };
    assert("forge_tool succeeded", result.ok === true, JSON.stringify(result).slice(0, 300));
    if (result.ok && result.value !== undefined) {
      forgedBrickId = result.value.id;
      assert("forged brick has ID", forgedBrickId?.startsWith("brick_") ?? false);
      assert("forged brick has sandbox policy", result.value.policy.sandbox === true);
      console.log(`    Brick ID: ${forgedBrickId}`);
    }
  }
} catch (err: unknown) {
  assert("Test 1 completed", false, err instanceof Error ? err.message : String(err));
}

if (forgedBrickId === undefined) {
  console.error("\n[e2e] Cannot continue — no brick forged. Exiting.");
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 2: Verify content integrity of the fresh brick (should pass)
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[test 2] Verify content integrity of freshly forged brick");

try {
  const loadResult = await store.load(forgedBrickId);
  assert("brick loaded from store", loadResult.ok === true);

  if (loadResult.ok) {
    const integrity = verifyBrickIntegrity(loadResult.value);
    assert("integrity check passes for untampered brick", integrity.ok === true);
    if (integrity.ok) {
      console.log(`    Hash: ${integrity.hash.slice(0, 16)}...`);
    }
  }
} catch (err: unknown) {
  assert("Test 2 completed", false, err instanceof Error ? err.message : String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 3: Tamper the brick → integrity check should fail
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[test 3] Tamper brick content → integrity check detects it");

try {
  const loadResult = await store.load(forgedBrickId);
  assert("brick loaded for tampering test", loadResult.ok === true);

  if (loadResult.ok && loadResult.value.kind === "tool") {
    // Create a tampered copy (modified implementation, same contentHash)
    const tampered: BrickArtifact = {
      ...loadResult.value,
      implementation: "return { hacked: true };",
    };
    const integrity = verifyBrickIntegrity(tampered);
    assert("integrity check FAILS for tampered brick", integrity.ok === false);
    if (!integrity.ok) {
      console.log(`    Expected: ${integrity.expectedHash.slice(0, 16)}...`);
      console.log(`    Actual:   ${integrity.actualHash.slice(0, 16)}...`);
    }
  }
} catch (err: unknown) {
  assert("Test 3 completed", false, err instanceof Error ? err.message : String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 4: Record usage 5 times → usage count increments
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[test 4] Record 5 usages → usage count increments");

try {
  const before = await store.load(forgedBrickId);
  assert("brick loaded", before.ok === true);
  assert("brick starts at usageCount 0", before.ok === true && before.value.usageCount === 0);

  for (let i = 0; i < 5; i++) {
    const r = await recordBrickUsage(store, forgedBrickId, config);
    assert(`usage ${i + 1} recorded`, r.ok === true && r.value.kind === "recorded");
  }

  const after = await store.load(forgedBrickId);
  assert("usageCount is 5 after 5 recordings", after.ok === true && after.value.usageCount === 5);
} catch (err: unknown) {
  assert("Test 4 completed", false, err instanceof Error ? err.message : String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 5: loadAndVerify — passes for untampered, fails for tampered
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[test 5] loadAndVerify convenience function");

try {
  // Untampered — should pass
  const result = await loadAndVerify(store, forgedBrickId);
  assert("loadAndVerify returns ok", result.ok === true);
  if (result.ok) {
    assert("integrity passes for store brick", result.value.integrity.ok === true);
    assert("brick id matches", result.value.brick.id === forgedBrickId);
  }

  // Nonexistent — should return ForgeError
  const missing = await loadAndVerify(store, "brick_nonexistent_999");
  assert("loadAndVerify returns error for missing brick", missing.ok === false);
  if (!missing.ok) {
    assert("error stage is store", missing.error.stage === "store");
    assert("error code is LOAD_FAILED", missing.error.code === "LOAD_FAILED");
  }
} catch (err: unknown) {
  assert("Test 5 completed", false, err instanceof Error ? err.message : String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// Test 6: recordBrickUsage with nonexistent brick → error
// ═══════════════════════════════════════════════════════════════════════════

console.log("\n[test 6] recordBrickUsage error handling");

try {
  const result = await recordBrickUsage(store, "brick_does_not_exist", config);
  assert("returns error for nonexistent brick", result.ok === false);
  if (!result.ok) {
    assert("error stage is store", result.error.stage === "store");
    assert("error code is LOAD_FAILED", result.error.code === "LOAD_FAILED");
  }
} catch (err: unknown) {
  assert("Test 6 completed", false, err instanceof Error ? err.message : String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"═".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  \x1b[31mFAIL\x1b[0m  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All forge usage + integrity E2E tests passed!");
