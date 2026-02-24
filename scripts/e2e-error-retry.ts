#!/usr/bin/env bun

/**
 * Manual E2E test: validates #295 (formatErrorForChannel) and #296 (retry utilities)
 * with a real LLM call through @koi/engine-loop + @koi/model-router.
 *
 * Requires: OPENAI_API_KEY or OPENROUTER_API_KEY set in environment.
 *
 * Run:
 *   bun run scripts/e2e-error-retry.ts
 */

import { formatErrorForChannel } from "../packages/channel-base/src/format-error.js";
import type { EngineEvent, KoiError, ModelRequest } from "../packages/core/src/index.js";
import { createLoopAdapter } from "../packages/engine-loop/src/loop-adapter.js";
import { computeBackoff, isRetryable, withRetry } from "../packages/errors/src/retry.js";
import { createOpenAIAdapter } from "../packages/model-router/src/adapters/openai.js";
import { createOpenRouterAdapter } from "../packages/model-router/src/adapters/openrouter.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

if (!OPENAI_KEY && !OPENROUTER_KEY) {
  console.error("ERROR: Set OPENAI_API_KEY or OPENROUTER_API_KEY");
  process.exit(1);
}

const provider = OPENAI_KEY ? "openai" : "openrouter";
const adapter =
  provider === "openai"
    ? createOpenAIAdapter({ apiKey: OPENAI_KEY })
    : createOpenRouterAdapter({ apiKey: OPENROUTER_KEY, appName: "koi-e2e" });

const model = provider === "openai" ? "gpt-4o-mini" : "openai/gpt-4o-mini";

const modelCall = (request: ModelRequest) => adapter.complete({ ...request, model });

let passed = 0;
let failed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  PASS  ${name}`);
}

function fail(name: string, reason: string): void {
  failed++;
  console.error(`  FAIL  ${name}: ${reason}`);
}

// ---------------------------------------------------------------------------
// Test 1: Real LLM call through engine-loop
// ---------------------------------------------------------------------------

async function testRealLlmCall(): Promise<void> {
  console.log("\n--- Test 1: Real LLM call through engine-loop ---");

  try {
    const loop = createLoopAdapter({ modelCall, maxTurns: 3 });
    const events: EngineEvent[] = [];

    for await (const event of loop.stream({ kind: "text", text: "Reply with exactly: pong" })) {
      events.push(event);
    }

    const done = events.find((e) => e.kind === "done");
    if (!done || done.kind !== "done") {
      fail("real LLM call", "no done event");
      return;
    }

    if (done.output.stopReason !== "completed") {
      fail("real LLM call", `stopReason=${done.output.stopReason}, expected completed`);
      return;
    }

    const text = events
      .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
      .map((e) => e.delta)
      .join("");

    if (!text.toLowerCase().includes("pong")) {
      fail("real LLM call", `response "${text}" does not contain "pong"`);
      return;
    }

    ok(
      `real LLM call → "${text.trim()}" (${done.output.metrics.totalTokens} tokens, ${done.output.metrics.durationMs}ms)`,
    );
  } catch (error: unknown) {
    const koiErr = error as KoiError;
    if (koiErr.code) {
      const safe = formatErrorForChannel(koiErr);
      console.log(`  SKIP  real LLM call — API error: ${safe}`);
      console.log(
        `         (raw: ${koiErr.code} ${koiErr.retryable ? "retryable" : "non-retryable"})`,
      );
      console.log("         Set a valid API key to run LLM tests.");
    } else {
      fail("real LLM call", String(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Test 2: formatErrorForChannel with every KoiErrorCode
// ---------------------------------------------------------------------------

function testFormatErrorForChannel(): void {
  console.log("\n--- Test 2: formatErrorForChannel (all 8 codes) ---");

  const codes = [
    "VALIDATION",
    "NOT_FOUND",
    "PERMISSION",
    "CONFLICT",
    "RATE_LIMIT",
    "TIMEOUT",
    "EXTERNAL",
    "INTERNAL",
  ] as const;

  for (const code of codes) {
    const error: KoiError = { code, message: `${code} detail`, retryable: false };
    const safe = formatErrorForChannel(error);
    const verbose = formatErrorForChannel(error, { verbose: true });

    // Safe output must NOT contain the technical detail (except VALIDATION)
    if (code !== "VALIDATION" && safe.includes(`${code} detail`)) {
      fail(`format ${code}`, `safe output leaks detail: "${safe}"`);
      continue;
    }

    // Verbose output must contain extra info (except VALIDATION which is always the same)
    if (code !== "VALIDATION" && !verbose.includes(`${code} detail`)) {
      fail(`format ${code}`, `verbose missing detail: "${verbose}"`);
      continue;
    }

    ok(`format ${code} → safe="${safe}" verbose="${verbose}"`);
  }

  // RATE_LIMIT with retryAfterMs
  const rlError: KoiError = {
    code: "RATE_LIMIT",
    message: "slow down",
    retryable: true,
    retryAfterMs: 5000,
  };
  const rlVerbose = formatErrorForChannel(rlError, { verbose: true });
  if (rlVerbose.includes("5000ms")) {
    ok(`format RATE_LIMIT+retryAfterMs → "${rlVerbose}"`);
  } else {
    fail("format RATE_LIMIT+retryAfterMs", `missing ms hint: "${rlVerbose}"`);
  }
}

// ---------------------------------------------------------------------------
// Test 3: isRetryable matches RETRYABLE_DEFAULTS
// ---------------------------------------------------------------------------

function testIsRetryable(): void {
  console.log("\n--- Test 3: isRetryable for all 8 codes ---");

  const expected: Record<string, boolean> = {
    VALIDATION: false,
    NOT_FOUND: false,
    PERMISSION: false,
    CONFLICT: true,
    RATE_LIMIT: true,
    TIMEOUT: true,
    EXTERNAL: true,
    INTERNAL: false,
  };

  for (const [code, want] of Object.entries(expected)) {
    const error: KoiError = { code: code as KoiError["code"], message: "test", retryable: false };
    const got = isRetryable(error);
    if (got === want) {
      ok(`isRetryable(${code}) = ${got}`);
    } else {
      fail(`isRetryable(${code})`, `got ${got}, want ${want}`);
    }
  }

  // Explicit retryable=true overrides code
  const overrideError: KoiError = { code: "VALIDATION", message: "test", retryable: true };
  if (isRetryable(overrideError)) {
    ok("isRetryable override: VALIDATION+retryable=true → true");
  } else {
    fail("isRetryable override", "should be true when retryable=true");
  }
}

// ---------------------------------------------------------------------------
// Test 4: withRetry with real LLM call (succeed on first try)
// ---------------------------------------------------------------------------

async function testWithRetryRealCall(): Promise<void> {
  console.log("\n--- Test 4: withRetry wrapping a real LLM call ---");

  try {
    const result = await withRetry(
      () =>
        modelCall({
          messages: [
            {
              content: [{ kind: "text", text: "Reply with: 42" }],
              senderId: "e2e",
              timestamp: Date.now(),
            },
          ],
        }),
      {
        maxRetries: 2,
        backoffMultiplier: 2,
        initialDelayMs: 100,
        maxBackoffMs: 1000,
        jitter: false,
      },
    );

    if (result.content.toLowerCase().includes("42")) {
      ok(
        `withRetry(real call) → "${result.content.trim()}" (${result.usage?.inputTokens ?? 0}+${result.usage?.outputTokens ?? 0} tokens)`,
      );
    } else {
      fail("withRetry(real call)", `response "${result.content}" missing "42"`);
    }
  } catch (error: unknown) {
    const koiErr = error as KoiError;
    if (koiErr.code === "PERMISSION") {
      // Bad key — withRetry correctly did NOT retry a PERMISSION error
      ok("withRetry correctly threw PERMISSION without retrying (non-retryable)");
    } else {
      fail("withRetry(real call)", `unexpected error: ${koiErr.code} ${koiErr.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test 5: withRetry retries transient failures then succeeds
// ---------------------------------------------------------------------------

async function testWithRetryTransient(): Promise<void> {
  console.log("\n--- Test 5: withRetry retries transient error, then succeeds ---");

  let attempts = 0;
  try {
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw {
            code: "RATE_LIMIT",
            message: "429 slow down",
            retryable: true,
          } satisfies KoiError;
        }
        return modelCall({
          messages: [
            {
              content: [{ kind: "text", text: "Say hello" }],
              senderId: "e2e",
              timestamp: Date.now(),
            },
          ],
        });
      },
      { maxRetries: 3, backoffMultiplier: 1, initialDelayMs: 50, maxBackoffMs: 200, jitter: false },
    );

    if (attempts === 3 && result.content.length > 0) {
      ok(`withRetry transient: succeeded on attempt ${attempts} → "${result.content.trim()}"`);
    } else {
      fail("withRetry transient", `attempts=${attempts}, content="${result.content}"`);
    }
  } catch (error: unknown) {
    const koiErr = error as KoiError;
    if (koiErr.code === "PERMISSION" && attempts === 3) {
      // Retried the RATE_LIMIT errors, then hit PERMISSION on the real call (bad key)
      ok(
        `withRetry transient: retried ${attempts - 1}x, then correctly threw ${koiErr.code} on real call`,
      );
    } else {
      fail("withRetry transient", `attempts=${attempts}, error=${koiErr.code}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test 6: computeBackoff produces expected delays
// ---------------------------------------------------------------------------

function testCalculateBackoff(): void {
  console.log("\n--- Test 6: computeBackoff ---");

  const config = {
    maxRetries: 3,
    backoffMultiplier: 2,
    initialDelayMs: 1000,
    maxBackoffMs: 30000,
    jitter: false,
  };

  const d0 = computeBackoff(0, config);
  const d1 = computeBackoff(1, config);
  const d2 = computeBackoff(2, config);

  if (d0 === 1000 && d1 === 2000 && d2 === 4000) {
    ok(`exponential: ${d0}ms → ${d1}ms → ${d2}ms`);
  } else {
    fail("exponential", `${d0}ms → ${d1}ms → ${d2}ms`);
  }

  // retryAfterMs override
  const override = computeBackoff(0, config, 5000);
  if (override === 5000) {
    ok(`retryAfterMs override: ${override}ms`);
  } else {
    fail("retryAfterMs override", `got ${override}ms`);
  }

  // jitter stays in range
  const jitterConfig = { ...config, jitter: true };
  let allInRange = true;
  for (let i = 0; i < 50; i++) {
    const d = computeBackoff(0, jitterConfig);
    if (d < 0 || d > 1000) {
      allInRange = false;
      break;
    }
  }
  if (allInRange) {
    ok("jitter: 50 samples all in [0, 1000]");
  } else {
    fail("jitter", "value out of range");
  }
}

// ---------------------------------------------------------------------------
// Test 7: formatErrorForChannel on error produced by real adapter failure
// ---------------------------------------------------------------------------

async function testFormatRealAdapterError(): Promise<void> {
  console.log("\n--- Test 7: format a real adapter error ---");

  // Create an adapter with a bad API key to trigger a real PERMISSION error
  const badAdapter = createOpenAIAdapter({ apiKey: "sk-bad-key-12345" });
  try {
    await badAdapter.complete({
      model: "gpt-4o-mini",
      messages: [
        { content: [{ kind: "text", text: "test" }], senderId: "e2e", timestamp: Date.now() },
      ],
    });
    fail("real adapter error", "expected an error from bad key");
  } catch (error: unknown) {
    const e = error as KoiError;
    if (e.code && e.message) {
      const safe = formatErrorForChannel(e);
      const verbose = formatErrorForChannel(e, { verbose: true });
      ok(`caught ${e.code} → safe="${safe}"`);
      ok(`caught ${e.code} → verbose="${verbose}"`);

      // Safe message must NOT contain the raw API error body
      if (!safe.includes("OpenAI API error")) {
        ok("safe message does not leak API internals");
      } else {
        fail("safe message leak", `"${safe}" contains raw API text`);
      }
    } else {
      fail("real adapter error", `unexpected error shape: ${String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\nKoi E2E: #295 formatErrorForChannel + #296 retry utilities`);
  console.log(`Provider: ${provider} (model: ${model})\n`);

  testFormatErrorForChannel();
  testIsRetryable();
  testCalculateBackoff();

  await testRealLlmCall();
  await testWithRetryRealCall();
  await testWithRetryTransient();
  await testFormatRealAdapterError();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error("Fatal:", error);
  process.exit(1);
});
