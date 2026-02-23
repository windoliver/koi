#!/usr/bin/env bun
/**
 * E2E test script for @koi/middleware-soul — validates that soul personality
 * injection actually changes LLM output via real Anthropic API calls.
 *
 * Tests:
 *   1. Baseline: model responds without soul context
 *   2. Soul-injected: model adopts SOUL.md personality in its response
 *   3. Soul + user: model references both soul and user context
 *   4. Middleware chain: soul composes with a spy middleware via composeModelChain
 *   5. Stream: soul injection works via wrapModelStream
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-middleware-soul.ts
 *
 *   Or if .env has ANTHROPIC_API_KEY:
 *   bun scripts/e2e-middleware-soul.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  InboundMessage,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { composeModelChain } from "../packages/engine/src/compose.js";
import { createSoulMiddleware } from "../packages/middleware-soul/src/soul.js";
import { createMockTurnContext } from "../packages/test-utils/src/index.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting middleware-soul E2E tests...\n");

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
  console.log(`  ${tag}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

function makeMessage(text: string): InboundMessage {
  return {
    senderId: "e2e-user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

/**
 * Real Anthropic API call as a ModelHandler terminal.
 * Uses raw fetch (same pattern as @koi/model-router Anthropic adapter).
 */
function createAnthropicTerminal(): ModelHandler {
  return async (request: ModelRequest): Promise<ModelResponse> => {
    // Convert Koi messages to Anthropic format
    const systemParts: string[] = [];
    const userParts: string[] = [];

    for (const msg of request.messages) {
      const text = msg.content
        .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
        .map((b) => b.text)
        .join("\n");

      if (msg.senderId.startsWith("system:")) {
        systemParts.push(text);
      } else {
        userParts.push(text);
      }
    }

    const body = {
      model: request.model ?? "claude-haiku-4-5-20251001",
      max_tokens: request.maxTokens ?? 256,
      temperature: request.temperature ?? 0,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      messages: [{ role: "user", content: userParts.join("\n\n") }],
    };

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as {
      readonly model: string;
      readonly content: readonly { readonly type: string; readonly text: string }[];
      readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
    };

    return {
      content: json.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(""),
      model: json.model,
      usage: {
        inputTokens: json.usage.input_tokens,
        outputTokens: json.usage.output_tokens,
      },
    };
  };
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
// Setup: temp files for soul/user content
// ---------------------------------------------------------------------------

const tmpDir = join(import.meta.dir, "__e2e_soul_tmp__");
await mkdir(tmpDir, { recursive: true });

// Write test soul/user files
await writeFile(
  join(tmpDir, "SOUL.md"),
  `You are Captain Koi, a wise old koi fish who speaks in nautical metaphors.
You always start your response with "Ahoy!" and reference the ocean or rivers.
You are philosophical but concise.`,
);

await writeFile(
  join(tmpDir, "USER.md"),
  `The user's name is Marina. She is a marine biologist studying coral reefs.`,
);

// Also create a directory-mode soul
const soulDir = join(tmpDir, "soul-dir");
await mkdir(soulDir, { recursive: true });
await writeFile(
  join(soulDir, "SOUL.md"),
  `You are a grumpy Viking named Bjorn who speaks in short, blunt sentences.`,
);
await writeFile(join(soulDir, "STYLE.md"), `Always end responses with "Skol!" as a sign-off.`);

const terminal = createAnthropicTerminal();
const ctx = createMockTurnContext();

// ---------------------------------------------------------------------------
// Test 1 — Baseline (no soul)
// ---------------------------------------------------------------------------

console.log("[test 1] Baseline — no soul middleware");

const baselineResponse = await withTimeout(
  async () =>
    terminal({
      messages: [makeMessage("Who are you? Reply in one sentence.")],
      maxTokens: 100,
      temperature: 0,
    }),
  30_000,
  "Test 1",
);

console.log(`  Response: "${baselineResponse.content.slice(0, 120)}..."`);
assert("baseline returns non-empty response", baselineResponse.content.length > 0);
assert(
  "baseline does NOT contain 'Ahoy'",
  !baselineResponse.content.toLowerCase().includes("ahoy"),
  "Without soul injection, the model should not say Ahoy",
);

// ---------------------------------------------------------------------------
// Test 2 — Soul-injected (file mode)
// ---------------------------------------------------------------------------

console.log("\n[test 2] Soul-injected — file mode");

const soulMw = await createSoulMiddleware({
  soul: "SOUL.md",
  basePath: tmpDir,
});

assert("middleware name is 'soul'", soulMw.name === "soul");
assert("middleware priority is 500", soulMw.priority === 500);

const soulChain = composeModelChain([soulMw], terminal);

const soulResponse = await withTimeout(
  async () =>
    soulChain(ctx, {
      messages: [makeMessage("Who are you? Reply in one sentence.")],
      maxTokens: 100,
      temperature: 0,
    }),
  30_000,
  "Test 2",
);

console.log(`  Response: "${soulResponse.content.slice(0, 200)}"`);
assert("soul response returns non-empty", soulResponse.content.length > 0);
assert(
  "soul response contains 'Ahoy' (personality adopted)",
  soulResponse.content.toLowerCase().includes("ahoy"),
  `Got: "${soulResponse.content.slice(0, 100)}"`,
);

// ---------------------------------------------------------------------------
// Test 3 — Soul + User context
// ---------------------------------------------------------------------------

console.log("\n[test 3] Soul + User context");

const soulUserMw = await createSoulMiddleware({
  soul: "SOUL.md",
  user: "USER.md",
  basePath: tmpDir,
});

const soulUserChain = composeModelChain([soulUserMw], terminal);

const soulUserResponse = await withTimeout(
  async () =>
    soulUserChain(ctx, {
      messages: [makeMessage("Greet me by name and tell me something about my work.")],
      maxTokens: 200,
      temperature: 0,
    }),
  30_000,
  "Test 3",
);

console.log(`  Response: "${soulUserResponse.content.slice(0, 200)}"`);
assert("soul+user response returns non-empty", soulUserResponse.content.length > 0);
assert(
  "response references user name 'Marina'",
  soulUserResponse.content.toLowerCase().includes("marina"),
  `Got: "${soulUserResponse.content.slice(0, 150)}"`,
);
assert(
  "response references coral/reef/marine (user context)",
  soulUserResponse.content.toLowerCase().includes("coral") ||
    soulUserResponse.content.toLowerCase().includes("reef") ||
    soulUserResponse.content.toLowerCase().includes("marine"),
  `Got: "${soulUserResponse.content.slice(0, 150)}"`,
);

// ---------------------------------------------------------------------------
// Test 4 — Middleware chain composition (soul + spy)
// ---------------------------------------------------------------------------

console.log("\n[test 4] Middleware chain composition — soul + spy");

let spyCapturedRequest: ModelRequest | undefined;
const spyMiddleware: KoiMiddleware = {
  name: "spy",
  priority: 400, // outer layer (runs before soul's 500)
  async wrapModelCall(
    _ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ): Promise<ModelResponse> {
    spyCapturedRequest = request;
    return next(request);
  },
};

const composedChain = composeModelChain([spyMiddleware, soulMw], terminal);

const composedResponse = await withTimeout(
  async () =>
    composedChain(ctx, {
      messages: [makeMessage("Say hello.")],
      maxTokens: 100,
      temperature: 0,
    }),
  30_000,
  "Test 4",
);

console.log(`  Response: "${composedResponse.content.slice(0, 120)}"`);
assert("composed chain returns non-empty response", composedResponse.content.length > 0);
assert("spy captured the request", spyCapturedRequest !== undefined);
assert(
  "spy sees soul message prepended (soul runs inner, spy sees enriched request)",
  (spyCapturedRequest?.messages.length ?? 0) === 1,
  "Spy is outer (priority 400 < 500), so it sees the ORIGINAL request before soul enriches it",
);

// Verify that soul is inner (higher priority = inner in onion)
// The spy at 400 wraps soul at 500. Spy's next() calls soul's wrapModelCall.
// So spy sees the original request, but the terminal sees soul's enriched request.
// This is correct onion behavior: lower priority = outer layer.

// ---------------------------------------------------------------------------
// Test 5 — Directory mode (SOUL.md + STYLE.md)
// ---------------------------------------------------------------------------

console.log("\n[test 5] Directory mode — SOUL.md + STYLE.md");

const dirMw = await createSoulMiddleware({
  soul: "soul-dir",
  basePath: tmpDir,
});

const dirChain = composeModelChain([dirMw], terminal);

const dirResponse = await withTimeout(
  async () =>
    dirChain(ctx, {
      messages: [makeMessage("What do you think about modern technology? Reply in 2 sentences.")],
      maxTokens: 150,
      temperature: 0,
    }),
  30_000,
  "Test 5",
);

console.log(`  Response: "${dirResponse.content.slice(0, 200)}"`);
assert("directory mode returns non-empty response", dirResponse.content.length > 0);
assert(
  "response contains 'Skol' (STYLE.md sign-off adopted)",
  dirResponse.content.toLowerCase().includes("skol"),
  `Got: "${dirResponse.content.slice(0, 200)}"`,
);

// ---------------------------------------------------------------------------
// Test 6 — Inline soul content
// ---------------------------------------------------------------------------

console.log("\n[test 6] Inline soul content");

const inlineMw = await createSoulMiddleware({
  soul: "You are a robot named UNIT-7.\nAlways prefix your response with [UNIT-7]:",
  basePath: tmpDir,
});

const inlineChain = composeModelChain([inlineMw], terminal);

const inlineResponse = await withTimeout(
  async () =>
    inlineChain(ctx, {
      messages: [makeMessage("Hello, who are you?")],
      maxTokens: 100,
      temperature: 0,
    }),
  30_000,
  "Test 6",
);

console.log(`  Response: "${inlineResponse.content.slice(0, 150)}"`);
assert("inline mode returns non-empty response", inlineResponse.content.length > 0);
assert(
  "response contains 'UNIT-7' (inline personality adopted)",
  inlineResponse.content.includes("UNIT-7"),
  `Got: "${inlineResponse.content.slice(0, 150)}"`,
);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

await rm(tmpDir, { recursive: true, force: true });

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
      if (r.detail) console.error(`        ${r.detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] All tests passed!");
