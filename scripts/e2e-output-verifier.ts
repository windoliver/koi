#!/usr/bin/env bun

/**
 * E2E test script for @koi/middleware-output-verifier — validates the two-stage
 * output quality gate works end-to-end with real Anthropic API calls through the
 * full Koi middleware and runtime stack.
 *
 * Part A — composeModelChain (middleware chain, no Pi runtime overhead)
 *   1.  Deterministic pass   — nonEmpty + maxLength pass on real LLM output
 *   2.  Deterministic block  — always-block check throws KoiRuntimeError
 *   3.  Deterministic warn   — output delivered + onVeto fired
 *   4.  Judge pass           — real judge scores quality output >= threshold
 *   5.  Judge warn action    — unreachable threshold, warn fires, output delivered
 *   6.  Revise loop          — check fails first call, revision injected, passes second
 *   7.  Stats tracking       — vetoRate = 1/4 = 0.25 (Spotify 25% baseline)
 *   8.  setRubric            — rubric change takes effect on next judge call
 *
 * Part B — Full createKoi + Pi agent (end-to-end L1 runtime integration)
 *   9.  Pi + deterministic   — nonEmpty + maxLength through full runtime
 *  10.  Pi + judge           — real judge evaluates Pi output, stats tracked
 *
 * Usage:
 *   bun scripts/e2e-output-verifier.ts        (reads .env automatically)
 *   ANTHROPIC_API_KEY=sk-... bun scripts/e2e-output-verifier.ts
 *
 * Cost: ~$0.05–0.10 per run (~15–18 Haiku calls, minimal prompts).
 */

import { createPiAdapter } from "../packages/drivers/engine-pi/src/adapter.js";
import type {
  EngineEvent,
  InboundMessage,
  ModelHandler,
  ModelRequest,
  ModelResponse,
} from "../packages/kernel/core/src/index.js";
import { composeModelChain } from "../packages/kernel/engine/src/compose.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { KoiRuntimeError } from "../packages/lib/errors/dist/index.js";
import { createMockTurnContext } from "../packages/lib/test-utils/src/index.js";
import {
  BUILTIN_CHECKS,
  createOutputVerifierMiddleware,
} from "../packages/middleware/middleware-output-verifier/src/index.js";
import type {
  DeterministicCheck,
  VerifierVetoEvent,
} from "../packages/middleware/middleware-output-verifier/src/types.js";

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting output-verifier E2E tests...\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

const results: TestResult[] = []; // let justified: test accumulator

function assert(name: string, condition: boolean, detail?: string): void {
  results.push({ name, passed: condition, detail });
  const tag = condition ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${tag}  ${name}`);
  if (detail !== undefined && !condition) console.log(`         ${detail}`);
}

function makeMessage(text: string): InboundMessage {
  return {
    senderId: "e2e-user",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

function createAnthropicTerminal(): ModelHandler {
  return async (request: ModelRequest): Promise<ModelResponse> => {
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

function createJudgeTerminal(): (prompt: string, signal?: AbortSignal) => Promise<string> {
  return async (prompt: string, signal?: AbortSignal): Promise<string> => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY as string,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic judge API error ${response.status}: ${errorText}`);
    }

    const json = (await response.json()) as {
      readonly content: readonly { readonly type: string; readonly text: string }[];
    };

    return json.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
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

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = []; // let justified: test accumulator
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

const TIMEOUT_MS = 30_000;
const PI_MODEL = "anthropic:claude-haiku-4-5-20251001";
const ctx = createMockTurnContext();
const terminal = createAnthropicTerminal();

// =============================================================================
// PART A: composeModelChain tests
// =============================================================================

// ---------------------------------------------------------------------------
// Test 1 — Deterministic pass: nonEmpty + maxLength on real LLM output
// ---------------------------------------------------------------------------

console.log("[test 1] Deterministic checks pass — nonEmpty + maxLength (happy path)");

const vetoEvents1: VerifierVetoEvent[] = [];
const handle1 = createOutputVerifierMiddleware({
  deterministic: [BUILTIN_CHECKS.nonEmpty("block"), BUILTIN_CHECKS.maxLength(5_000, "warn")],
  onVeto: (e) => vetoEvents1.push(e),
});

const chain1 = composeModelChain([handle1.middleware], terminal);
const response1 = await withTimeout(
  () =>
    chain1(ctx, {
      messages: [makeMessage("Reply with exactly: VERIFIER_OK")],
      maxTokens: 64,
      temperature: 0,
    }),
  TIMEOUT_MS,
  "Test 1",
);

console.log(`  LLM: "${response1.content.slice(0, 80)}"`);
assert("response is non-empty", response1.content.length > 0);
assert("no veto events on clean response", vetoEvents1.length === 0, `Got ${vetoEvents1.length}`);
const s1 = handle1.getStats();
assert("totalChecks=1", s1.totalChecks === 1, `Got ${s1.totalChecks}`);
assert("vetoed=0, vetoRate=0", s1.vetoed === 0 && s1.vetoRate === 0);

// Also smoke-test describeCapabilities shape here
const cap1 = handle1.middleware.describeCapabilities?.(ctx);
assert("describeCapabilities label='output-gate'", cap1?.label === "output-gate");
assert("describeCapabilities has description", typeof cap1?.description === "string");

// ---------------------------------------------------------------------------
// Test 2 — Deterministic block: always-block check throws KoiRuntimeError
// ---------------------------------------------------------------------------

console.log("\n[test 2] Deterministic block — throws KoiRuntimeError + fires onVeto");

const vetoEvents2: VerifierVetoEvent[] = [];
const alwaysBlock: DeterministicCheck = {
  name: "policy-block",
  check: () => "Blocked by policy",
  action: "block",
};
const handle2 = createOutputVerifierMiddleware({
  deterministic: [alwaysBlock],
  onVeto: (e) => vetoEvents2.push(e),
});
const chain2 = composeModelChain([handle2.middleware], terminal);

let blockThrown = false; // let justified: toggled in catch
let blockCode: string | undefined;
try {
  await withTimeout(
    () => chain2(ctx, { messages: [makeMessage("Say anything.")], maxTokens: 64, temperature: 0 }),
    TIMEOUT_MS,
    "Test 2",
  );
} catch (e: unknown) {
  if (e instanceof KoiRuntimeError) {
    blockThrown = true;
    blockCode = e.code;
  }
}

assert("block throws KoiRuntimeError", blockThrown);
assert("error code is VALIDATION", blockCode === "VALIDATION", `Got: ${blockCode}`);
assert("onVeto fired once", vetoEvents2.length === 1, `Got ${vetoEvents2.length}`);
assert("veto source=deterministic", vetoEvents2[0]?.source === "deterministic");
assert("veto action=block", vetoEvents2[0]?.action === "block");
assert("veto checkName=policy-block", vetoEvents2[0]?.checkName === "policy-block");
assert("veto checkReason present", typeof vetoEvents2[0]?.checkReason === "string");
const s2 = handle2.getStats();
assert("block: vetoed=1", s2.vetoed === 1, `Got ${s2.vetoed}`);
assert("block: warned=0", s2.warned === 0, `Got ${s2.warned}`);
assert("block: vetoRate=1.0", s2.vetoRate === 1.0, `Got ${s2.vetoRate}`);

// ---------------------------------------------------------------------------
// Test 3 — Deterministic warn: output delivered + onVeto fired
// ---------------------------------------------------------------------------

console.log("\n[test 3] Deterministic warn — output delivered + onVeto fired");

const vetoEvents3: VerifierVetoEvent[] = [];
const alwaysWarn: DeterministicCheck = {
  name: "advisory-flag",
  check: () => "Suspicious pattern detected",
  action: "warn",
};
const handle3 = createOutputVerifierMiddleware({
  deterministic: [alwaysWarn],
  onVeto: (e) => vetoEvents3.push(e),
});
const chain3 = composeModelChain([handle3.middleware], terminal);
const response3 = await withTimeout(
  () => chain3(ctx, { messages: [makeMessage("Say: WARN_PASS")], maxTokens: 32, temperature: 0 }),
  TIMEOUT_MS,
  "Test 3",
);

console.log(`  LLM: "${response3.content.slice(0, 80)}"`);
assert("warn: output was delivered (not blocked)", response3.content.length > 0);
assert("warn: onVeto fired once", vetoEvents3.length === 1, `Got ${vetoEvents3.length}`);
assert("warn: event action=warn", vetoEvents3[0]?.action === "warn");
assert("warn: event source=deterministic", vetoEvents3[0]?.source === "deterministic");
const s3 = handle3.getStats();
assert("warn: vetoed=0 (warn is NOT a veto)", s3.vetoed === 0, `Got ${s3.vetoed}`);
assert("warn: warned=1", s3.warned === 1, `Got ${s3.warned}`);
assert("warn: vetoRate=0", s3.vetoRate === 0, `Got ${s3.vetoRate}`);

// ---------------------------------------------------------------------------
// Test 4 — Judge pass: real judge evaluates quality output
// ---------------------------------------------------------------------------

console.log("\n[test 4] LLM-as-judge pass — real judge scores quality output >= threshold");

const vetoEvents4: VerifierVetoEvent[] = [];
const handle4 = createOutputVerifierMiddleware({
  judge: {
    rubric: [
      "Score the output 0.0–1.0.",
      "Give 0.8+ if it directly and correctly answers the question.",
      "Give 0.3 or less if the response is empty, nonsensical, or off-topic.",
    ].join("\n"),
    modelCall: createJudgeTerminal(),
    vetoThreshold: 0.5,
    action: "block",
    samplingRate: 1.0,
  },
  onVeto: (e) => vetoEvents4.push(e),
});
const chain4 = composeModelChain([handle4.middleware], terminal);
const response4 = await withTimeout(
  () =>
    chain4(ctx, {
      messages: [makeMessage("In one sentence: what is a quality gate in software delivery?")],
      maxTokens: 128,
      temperature: 0,
    }),
  TIMEOUT_MS * 2, // agent call + judge call
  "Test 4",
);

console.log(`  LLM: "${response4.content.slice(0, 120)}"`);
assert("judge pass: output delivered (score >= 0.5)", response4.content.length > 0);
assert("judge pass: no veto events", vetoEvents4.length === 0, `Got ${vetoEvents4.length}`);
const s4 = handle4.getStats();
assert("judge pass: judgedChecks=1", s4.judgedChecks === 1, `Got ${s4.judgedChecks}`);
assert("judge pass: vetoed=0", s4.vetoed === 0, `Got ${s4.vetoed}`);

// ---------------------------------------------------------------------------
// Test 5 — Judge warn action: unreachable threshold, warns but delivers
// ---------------------------------------------------------------------------

console.log("\n[test 5] LLM-as-judge warn action — fires event, output still delivered");

const vetoEvents5: VerifierVetoEvent[] = [];
const handle5 = createOutputVerifierMiddleware({
  judge: {
    rubric: [
      "You are an impossibly strict judge. Score 1.0 only for perfect scholarly prose.",
      "Score all other outputs 0.0–0.2. Common conversational replies score <= 0.1.",
    ].join("\n"),
    modelCall: createJudgeTerminal(),
    vetoThreshold: 0.99, // no real LLM output can reach this
    action: "warn", // warn so output is still delivered
    samplingRate: 1.0,
  },
  onVeto: (e) => vetoEvents5.push(e),
});
const chain5 = composeModelChain([handle5.middleware], terminal);
const response5 = await withTimeout(
  () => chain5(ctx, { messages: [makeMessage("Say hello.")], maxTokens: 32, temperature: 0 }),
  TIMEOUT_MS * 2,
  "Test 5",
);

console.log(`  LLM: "${response5.content.slice(0, 80)}"`);
assert("judge warn: output delivered despite low score", response5.content.length > 0);
assert("judge warn: onVeto fired once", vetoEvents5.length === 1, `Got ${vetoEvents5.length}`);
assert("judge warn: event source=judge", vetoEvents5[0]?.source === "judge");
assert("judge warn: event action=warn", vetoEvents5[0]?.action === "warn");
assert("judge warn: event.score is a number", typeof vetoEvents5[0]?.score === "number");
assert("judge warn: event.reasoning is present", typeof vetoEvents5[0]?.reasoning === "string");
const s5 = handle5.getStats();
assert("judge warn: warned=1 (NOT vetoed)", s5.warned === 1, `Got ${s5.warned}`);
assert("judge warn: vetoed=0", s5.vetoed === 0, `Got ${s5.vetoed}`);
assert("judge warn: judgedChecks=1", s5.judgedChecks === 1, `Got ${s5.judgedChecks}`);

// ---------------------------------------------------------------------------
// Test 6 — Revise action: retry loop injects feedback, LLM passes on second try
// ---------------------------------------------------------------------------

console.log("\n[test 6] Revise action — retry loop: check fails → feedback injected → passes");

// NOTE: The revise loop calls next() multiple times within one wrapModelCall invocation.
// composeModelChain intentionally guards against this on the success path (by design).
// Test 6 therefore calls wrapModelCall directly (as unit tests do) to validate the
// revise mechanism without conflicting with the composition guard contract.

// let justified: tracks actual LLM call count across revision attempts
let callCount6 = 0;
const countingTerminal6: ModelHandler = async (request: ModelRequest): Promise<ModelResponse> => {
  callCount6++;
  return terminal(request);
};

const handle6 = createOutputVerifierMiddleware({
  // Check fails until LLM includes the marker. The revision message will instruct it to add it.
  deterministic: [
    {
      name: "needs-gate-marker",
      check: (c) => c.includes("GATE_PASS") || "Response must include the text GATE_PASS",
      action: "revise",
    },
  ],
});

// Call wrapModelCall directly — bypasses composeModelChain's single-next() guard.
// The wrapModelCall hook is always defined for this middleware.
const wrapModelCall6 = handle6.middleware.wrapModelCall;
if (wrapModelCall6 === undefined)
  throw new Error("wrapModelCall not defined on handle6 middleware");

// Initial prompt doesn't mention GATE_PASS — LLM won't include it on first attempt.
// The revision feedback ("must include GATE_PASS") instructs LLM to add it on retry.
const response6 = await withTimeout(
  () =>
    wrapModelCall6(
      ctx,
      {
        messages: [makeMessage("Describe a cloud in one sentence.")],
        maxTokens: 128,
        temperature: 0,
      },
      countingTerminal6,
    ),
  TIMEOUT_MS * 2,
  "Test 6",
);

console.log(`  LLM calls: ${callCount6}, Final: "${response6.content.slice(0, 120)}"`);
assert(
  "revise: LLM called at least twice (retry loop fired)",
  callCount6 >= 2,
  `Called ${callCount6} times`,
);
assert(
  "revise: final response contains GATE_PASS",
  response6.content.includes("GATE_PASS"),
  `Response: "${response6.content.slice(0, 100)}"`,
);
const s6 = handle6.getStats();
assert("revise: totalChecks=1 (one wrapModelCall)", s6.totalChecks === 1, `Got ${s6.totalChecks}`);
assert("revise: vetoed=1 (revise counts as veto)", s6.vetoed === 1, `Got ${s6.vetoed}`);

// ---------------------------------------------------------------------------
// Test 7 — Stats: vetoRate = 1/4 = 0.25 (Spotify 25% baseline example)
// ---------------------------------------------------------------------------

console.log("\n[test 7] Stats tracking — vetoRate baseline across 4 calls");

// let justified: shared counter drives conditional block logic
let callNum7 = 0;
const handle7 = createOutputVerifierMiddleware({
  deterministic: [
    {
      name: "every-fourth",
      check: () => {
        callNum7++;
        return callNum7 % 4 !== 0 || "Blocked on every 4th call";
      },
      action: "block",
    },
  ],
});
const chain7 = composeModelChain([handle7.middleware], terminal);
const tiny = { messages: [makeMessage("Say 'ok'.")], maxTokens: 16, temperature: 0 };

for (let i = 0; i < 3; i++) {
  await withTimeout(() => chain7(ctx, tiny), TIMEOUT_MS, `Test 7 call ${i + 1}`);
}
let blocked7 = false; // let justified: toggled in catch
try {
  await withTimeout(() => chain7(ctx, tiny), TIMEOUT_MS, "Test 7 block call");
} catch (_e: unknown) {
  blocked7 = true;
}

const s7 = handle7.getStats();
assert("stats: totalChecks=4", s7.totalChecks === 4, `Got ${s7.totalChecks}`);
assert("stats: vetoed=1 (one block)", s7.vetoed === 1, `Got ${s7.vetoed}`);
assert("stats: warned=0", s7.warned === 0, `Got ${s7.warned}`);
assert("stats: vetoRate=0.25", s7.vetoRate === 0.25, `Got ${s7.vetoRate}`);
assert("stats: 4th call was blocked", blocked7);

// Also verify reset() works
handle7.reset();
const s7r = handle7.getStats();
assert(
  "reset: all counters zeroed",
  s7r.totalChecks === 0 && s7r.vetoed === 0 && s7r.vetoRate === 0,
);

// ---------------------------------------------------------------------------
// Test 8 — setRubric: dynamic rubric change takes effect on next call
// ---------------------------------------------------------------------------

console.log("\n[test 8] setRubric — dynamic rubric update reflected in judge prompts");

const capturedPrompts8: string[] = []; // let justified: captures judge prompts
const handle8 = createOutputVerifierMiddleware({
  judge: {
    rubric: "ORIGINAL_RUBRIC: Be kind and concise.",
    modelCall: async (prompt) => {
      capturedPrompts8.push(prompt);
      return JSON.stringify({ score: 1.0, reasoning: "ok" });
    },
    vetoThreshold: 0.5,
    action: "warn",
  },
});
const chain8 = composeModelChain([handle8.middleware], terminal);
const req8 = { messages: [makeMessage("Say hello.")], maxTokens: 16, temperature: 0 };

await withTimeout(() => chain8(ctx, req8), TIMEOUT_MS, "Test 8 first call");
handle8.setRubric("UPDATED_RUBRIC: Be extremely precise.");
await withTimeout(() => chain8(ctx, req8), TIMEOUT_MS, "Test 8 second call");

assert(
  "setRubric: first call uses original rubric",
  capturedPrompts8[0]?.includes("ORIGINAL_RUBRIC") === true,
  `First prompt excerpt: "${capturedPrompts8[0]?.slice(0, 80)}"`,
);
assert(
  "setRubric: second call uses updated rubric",
  capturedPrompts8[1]?.includes("UPDATED_RUBRIC") === true,
  `Second prompt excerpt: "${capturedPrompts8[1]?.slice(0, 80)}"`,
);
assert(
  "setRubric: original rubric NOT in second prompt",
  capturedPrompts8[1]?.includes("ORIGINAL_RUBRIC") === false,
);

// =============================================================================
// PART B: Full createKoi + Pi agent tests
// =============================================================================

// ---------------------------------------------------------------------------
// Test 9 — Full Pi + deterministic: nonEmpty + maxLength through L1 runtime
// ---------------------------------------------------------------------------

console.log("\n[test 9] Full createKoi + Pi — deterministic nonEmpty + maxLength");

const vetoEvents9: VerifierVetoEvent[] = [];
const handle9 = createOutputVerifierMiddleware({
  deterministic: [BUILTIN_CHECKS.nonEmpty("block"), BUILTIN_CHECKS.maxLength(10_000, "warn")],
  onVeto: (e) => vetoEvents9.push(e),
});

const piAdapter9 = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: "You are a concise assistant. Reply with a single short sentence.",
  getApiKey: async () => API_KEY,
});
const runtime9 = await createKoi({
  manifest: { name: "e2e-verifier-det", version: "0.0.1", model: { name: PI_MODEL } },
  adapter: piAdapter9,
  middleware: [handle9.middleware],
  limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS * 2, maxTokens: 10_000 },
});

try {
  const events9 = await Promise.race([
    collectEvents(runtime9.run({ kind: "text", text: "What is 2 + 2? Answer in one word." })),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Test 9 timed out")), TIMEOUT_MS * 2),
    ),
  ]);

  const doneEvent9 = events9.find((e) => e.kind === "done");
  assert("pi+det: done event present", doneEvent9 !== undefined);
  if (doneEvent9?.kind === "done") {
    assert(
      "pi+det: stopReason=completed",
      doneEvent9.output.stopReason === "completed",
      `Got: ${doneEvent9.output.stopReason}`,
    );
  }
  assert(
    "pi+det: no veto events on clean output",
    vetoEvents9.length === 0,
    `Got ${vetoEvents9.length}`,
  );
  const s9 = handle9.getStats();
  assert("pi+det: totalChecks >= 1", s9.totalChecks >= 1, `Got ${s9.totalChecks}`);
  assert("pi+det: vetoed=0", s9.vetoed === 0, `Got ${s9.vetoed}`);
  console.log(`  Pi completed: ${events9.length} events, ${s9.totalChecks} model checks`);
} finally {
  await runtime9.dispose?.();
}

// ---------------------------------------------------------------------------
// Test 10 — Full Pi + judge: real judge evaluates Pi output end-to-end
// ---------------------------------------------------------------------------

console.log("\n[test 10] Full createKoi + Pi + judge — end-to-end quality gate");

const vetoEvents10: VerifierVetoEvent[] = [];
const handle10 = createOutputVerifierMiddleware({
  deterministic: [BUILTIN_CHECKS.nonEmpty("block")],
  judge: {
    rubric: [
      "Score the output 0.0–1.0.",
      "Give 0.8+ if it directly and correctly answers the question.",
      "Give below 0.5 if the answer is wrong, empty, or off-topic.",
    ].join("\n"),
    modelCall: createJudgeTerminal(),
    vetoThreshold: 0.5,
    action: "warn", // warn so the run always completes — tests the judge fires
    samplingRate: 1.0,
  },
  onVeto: (e) => vetoEvents10.push(e),
});

const piAdapter10 = createPiAdapter({
  model: PI_MODEL,
  systemPrompt: "You are a knowledgeable assistant. Answer factually and concisely.",
  getApiKey: async () => API_KEY,
});
const runtime10 = await createKoi({
  manifest: { name: "e2e-verifier-judge", version: "0.0.1", model: { name: PI_MODEL } },
  adapter: piAdapter10,
  middleware: [handle10.middleware],
  limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS * 3, maxTokens: 10_000 },
});

try {
  const events10 = await Promise.race([
    collectEvents(runtime10.run({ kind: "text", text: "Name the capital of France." })),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Test 10 timed out")), TIMEOUT_MS * 3),
    ),
  ]);

  const doneEvent10 = events10.find((e) => e.kind === "done");
  assert("pi+judge: done event present", doneEvent10 !== undefined);
  if (doneEvent10?.kind === "done") {
    assert(
      "pi+judge: stopReason=completed",
      doneEvent10.output.stopReason === "completed",
      `Got: ${doneEvent10.output.stopReason}`,
    );
  }

  const s10 = handle10.getStats();
  assert(
    "pi+judge: judgedChecks >= 1 (judge ran)",
    s10.judgedChecks >= 1,
    `Got ${s10.judgedChecks}`,
  );
  // Capital of France is Paris — judge should score >= 0.5 → no veto
  assert("pi+judge: vetoed=0 (correct answer scored well)", s10.vetoed === 0, `Got ${s10.vetoed}`);
  assert("pi+judge: warned=0 (score >= 0.5)", s10.warned === 0, `Got ${s10.warned}`);

  console.log(
    `  Pi+judge: ${events10.length} events, judgedChecks=${s10.judgedChecks}, vetoRate=${s10.vetoRate}`,
  );
} finally {
  await runtime10.dispose?.();
}

// =============================================================================
// Summary
// =============================================================================

const passed = results.filter((r) => r.passed).length;
const total = results.length;
const allPassed = passed === total;

console.log(`\n${"─".repeat(60)}`);
console.log(`[e2e] Results: ${passed}/${total} passed`);
console.log("─".repeat(60));

if (!allPassed) {
  console.error("\n[e2e] Failed assertions:");
  for (const r of results) {
    if (!r.passed) {
      console.error(`  FAIL  ${r.name}`);
      if (r.detail !== undefined) console.error(`        ${r.detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] ALL OUTPUT-VERIFIER E2E TESTS PASSED!");
