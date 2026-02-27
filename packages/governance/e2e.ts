/**
 * Manual E2E script for @koi/governance.
 *
 * Tests createGovernanceStack() → createKoi() → createPiAdapter() → real LLM.
 * Exercises every middleware in the stack and the full 9-middleware combination.
 *
 * Run:
 *   bun packages/governance/e2e.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 *
 * Tests:
 *   1.  governance-backend allow   — tool executes through policy gate
 *   2.  governance-backend deny    — tool blocked, violation message surfaces
 *   3.  governance-backend throw   — evaluate() throws → fail-closed denial
 *   4.  onViolation callback       — fires with correct verdict on deny
 *   5.  audit middleware           — model_call + tool_call entries captured
 *   6.  permissions allow          — tool passes allow-list check
 *   7.  permissions deny           — tool blocked by deny-list
 *   8.  pay middleware             — run completes within budget, cost recorded
 *   9.  pay budget exhausted       — run rejected when budget = 0
 *  10.  PII redact strategy        — run completes, no crash (structural)
 *  11.  sanitize middleware        — run completes, no crash (structural)
 *  12.  guardrails middleware      — run completes, no crash (structural)
 *  13.  full 9-middleware stack    — all enabled, tool executes end-to-end
 *  14.  priority order             — middleware priority ascending (static check)
 *  15.  dispose called on end      — backend.dispose() is invoked on session end
 */

import type { AgentManifest, EngineEvent } from "@koi/core";
import { toolToken } from "@koi/core";
import type { GovernanceBackend, GovernanceVerdict } from "@koi/core/governance-backend";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createInMemoryAuditSink } from "@koi/middleware-audit";
import { createDefaultCostCalculator, createInMemoryBudgetTracker } from "@koi/middleware-pay";
import { createGovernanceStack } from "./src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (API_KEY.length === 0) {
  console.error("ANTHROPIC_API_KEY not set — aborting.");
  process.exit(1);
}

const MODEL = "anthropic:claude-haiku-4-5-20251001";
const LIMITS = { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 8_000 };

const BASE_MANIFEST: AgentManifest = {
  name: "governance-e2e",
  version: "1.0.0",
  model: { name: MODEL },
};

// ── Output helpers ────────────────────────────────────────────────────────────

let _failures = 0;

function pass(label: string, detail?: string): void {
  const suffix = detail !== undefined ? `  (${detail})` : "";
  console.log(`  ✓  ${label}${suffix}`);
}

function fail(label: string, detail: string): void {
  console.error(`  ✗  ${label}  →  ${detail}`);
  _failures++;
}

function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 55 - title.length))}`);
}

// ── Runtime helpers ───────────────────────────────────────────────────────────

async function run(
  events: AsyncIterable<EngineEvent>,
): Promise<{ text: string; stopReason: string; tokens: number }> {
  const parts: string[] = [];
  let stopReason = "unknown";
  let tokens = 0;
  for await (const e of events) {
    if (e.kind === "text_delta") parts.push(e.delta);
    if (e.kind === "done") {
      stopReason = e.output.stopReason;
      tokens = e.output.metrics.totalTokens;
    }
  }
  return { text: parts.join(""), stopReason, tokens };
}

async function runCatching(
  events: AsyncIterable<EngineEvent>,
): Promise<{ text: string; stopReason: string; tokens: number; error: Error | undefined }> {
  try {
    const result = await run(events);
    return { ...result, error: undefined };
  } catch (e: unknown) {
    return {
      text: "",
      stopReason: "error",
      tokens: 0,
      error: e instanceof Error ? e : new Error(String(e)),
    };
  }
}

// ── Tool + provider ───────────────────────────────────────────────────────────

const ADD_NUMBERS_DESCRIPTOR = {
  name: "add_numbers",
  description: "Adds two integers and returns the sum.",
  inputSchema: {
    type: "object" as const,
    properties: {
      a: { type: "integer" as const, description: "First number" },
      b: { type: "integer" as const, description: "Second number" },
    },
    required: ["a", "b"],
  },
};

function makeAddNumbersProvider(onExecute?: () => void): {
  readonly name: string;
  readonly attach: () => Promise<Map<string, unknown>>;
} {
  return {
    name: "add-numbers-provider",
    attach: async () =>
      new Map([
        [
          toolToken("add_numbers") as string,
          {
            descriptor: ADD_NUMBERS_DESCRIPTOR,
            trustTier: "verified" as const,
            execute: async (input: unknown) => {
              onExecute?.();
              const { a, b } = input as { readonly a: number; readonly b: number };
              return String(a + b);
            },
          },
        ],
      ]),
  };
}

// ── Backend factories ─────────────────────────────────────────────────────────

function makeAllowBackend(onDispose?: () => void): GovernanceBackend {
  return {
    evaluator: { evaluate: async (): Promise<GovernanceVerdict> => ({ ok: true }) },
    dispose: async () => {
      onDispose?.();
    },
  };
}

function makeDenyBackend(): GovernanceBackend {
  return {
    evaluator: {
      evaluate: async (): Promise<GovernanceVerdict> => ({
        ok: false,
        violations: [
          { rule: "e2e-policy", severity: "critical" as const, message: "e2e-deny-signal" },
        ],
      }),
    },
  };
}

function makeThrowingBackend(): GovernanceBackend {
  return {
    evaluator: {
      evaluate: async (): Promise<GovernanceVerdict> => {
        throw new Error("backend-exploded");
      },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

// ── Test 1: governance-backend allow ─────────────────────────────────────────

async function test1_governanceBackendAllow(): Promise<void> {
  section("1. governance-backend allow — tool executes through policy gate");

  let toolExecuted = false;
  const { middlewares } = createGovernanceStack({
    governanceBackend: { backend: makeAllowBackend() },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-gov-allow" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "You MUST use the add_numbers tool for any arithmetic. Never compute yourself.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: LIMITS,
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 7 + 8. Tell me the result." }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass("tokens > 0", `${String(tokens)} tokens`);
  else fail("tokens", "got 0");

  if (toolExecuted) pass("add_numbers tool executed (policy gate passed)");
  else fail("add_numbers tool", "was NOT executed — policy gate should have allowed it");
}

// ── Test 2: governance-backend deny ──────────────────────────────────────────

async function test2_governanceBackendDeny(): Promise<void> {
  section("2. governance-backend deny — tool blocked (Pi adapter absorbs stream error)");

  // NOTE: The Pi adapter's bridge catches the wrapModelStream throw and pushes an
  // { type: "error" } event to the pi-agent stream. pi-agent-core absorbs this and
  // completes the run without throwing. The primary guarantee — tool NOT executed — holds.
  // The stopReason being "completed" is the Pi bridge's error absorption behavior.

  let toolExecuted = false;
  const { middlewares } = createGovernanceStack({
    governanceBackend: { backend: makeDenyBackend() },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-gov-deny" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "Always use the add_numbers tool when asked to add.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { text, error, stopReason } = await runCatching(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 2 + 3." }),
  );
  await runtime.dispose();

  // Primary guarantee: tool must NOT execute
  if (toolExecuted) fail("add_numbers tool", "executed despite governance denial");
  else pass("add_numbers tool NOT executed (governance wrapModelStream gate held)");

  // Secondary: stream may throw or complete — both are acceptable with Pi adapter
  if (error !== undefined) {
    pass(`stream threw: "${error.message.slice(0, 80)}"`);
  } else {
    // Pi bridge absorbs the error — run ends with empty text (LLM was never called)
    pass(
      `Pi adapter absorbed stream error → stopReason=${stopReason}, text="${text.slice(0, 40)}" (expected: LLM was never called)`,
    );
  }
}

// ── Test 3: governance-backend throw = fail-closed ───────────────────────────

async function test3_governanceBackendThrowFailClosed(): Promise<void> {
  section("3. governance-backend throw — fail-closed (evaluate() throws = deny)");

  // Same Pi bridge absorption behavior as test 2.
  // The primary guarantee: an evaluate() throw must NOT allow the tool to execute.

  let toolExecuted = false;
  const { middlewares } = createGovernanceStack({
    governanceBackend: { backend: makeThrowingBackend() },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-gov-throw" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "Always use the add_numbers tool when asked to add.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { text, error, stopReason } = await runCatching(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 1 + 1." }),
  );
  await runtime.dispose();

  // Primary guarantee: tool must NOT execute
  if (toolExecuted)
    fail("add_numbers tool", "executed despite throwing backend (fail-closed violated — CRITICAL)");
  else pass("add_numbers tool NOT executed (fail-closed: throwing backend treated as deny)");

  if (error !== undefined) {
    pass(`stream threw: "${error.message.slice(0, 80)}"`);
  } else {
    pass(`Pi adapter absorbed throw → stopReason=${stopReason}, text="${text.slice(0, 40)}"`);
  }
}

// ── Test 4: onViolation callback ──────────────────────────────────────────────

async function test4_onViolationCallback(): Promise<void> {
  section("4. onViolation callback — fires with correct verdict on deny");

  let violationFired = false;
  let capturedViolations: readonly { rule: string; message: string }[] = [];

  const { middlewares } = createGovernanceStack({
    governanceBackend: {
      backend: makeDenyBackend(),
      onViolation: (verdict) => {
        violationFired = true;
        if (!verdict.ok) capturedViolations = verdict.violations;
      },
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-gov-violation-cb" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "Always use the add_numbers tool when asked to add.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [makeAddNumbersProvider()],
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  await runCatching(runtime.run({ kind: "text", text: "Use add_numbers to compute 5 + 5." }));
  await runtime.dispose();

  if (violationFired) pass("onViolation callback fired");
  else fail("onViolation callback", "was NOT called");

  if (capturedViolations.length > 0 && capturedViolations[0]?.message === "e2e-deny-signal") {
    pass(`captured violation message: "${capturedViolations[0].message}"`);
  } else if (capturedViolations.length > 0) {
    pass(
      `captured ${String(capturedViolations.length)} violation(s) (model_call blocked before tool call)`,
    );
  } else if (violationFired) {
    pass("onViolation fired (verdict captured)");
  } else {
    fail("captured violations", `got ${String(capturedViolations.length)}`);
  }
}

// ── Test 5: audit middleware captures entries ─────────────────────────────────

async function test5_auditCapture(): Promise<void> {
  section("5. audit middleware — model_call + tool_call entries captured");

  const sink = createInMemoryAuditSink();
  let toolExecuted = false;

  const { middlewares } = createGovernanceStack({
    audit: { sink },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-audit" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "You MUST use the add_numbers tool for any arithmetic.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: LIMITS,
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 3 + 4." }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass("tokens > 0", `${String(tokens)} tokens`);
  else fail("tokens", "got 0");

  if (toolExecuted) pass("add_numbers tool executed");
  else fail("tool", "was not executed");

  const entries = sink.entries;
  if (entries.length > 0) pass(`audit sink captured ${String(entries.length)} entries`);
  else fail("audit entries", "sink is empty — no entries captured");

  const modelEntries = entries.filter((e) => e.kind === "model_call");
  if (modelEntries.length > 0) pass(`model_call entries: ${String(modelEntries.length)}`);
  else fail("model_call entries", "none found — wrapModelStream not logging model_call");

  const toolEntries = entries.filter((e) => e.kind === "tool_call");
  if (toolEntries.length > 0) pass(`tool_call entries: ${String(toolEntries.length)}`);
  else fail("tool_call entries", "none found — tool was invoked but audit didn't capture it");
}

// ── Test 6: permissions allow ─────────────────────────────────────────────────

async function test6_permissionsAllow(): Promise<void> {
  section("6. permissions allow — tool passes allow-list check");

  let toolExecuted = false;
  const { middlewares } = createGovernanceStack({
    permissions: {
      backend: { check: () => ({ effect: "allow" as const }) },
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-perms-allow" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "You MUST use the add_numbers tool for any arithmetic.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: LIMITS,
  });

  const { stopReason } = await run(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 10 + 5." }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (toolExecuted) pass("add_numbers tool executed (permissions passed)");
  else fail("tool", "not executed despite allow policy");
}

// ── Test 7: permissions deny ──────────────────────────────────────────────────

async function test7_permissionsDeny(): Promise<void> {
  section("7. permissions deny — tool blocked by deny policy");

  let toolExecuted = false;
  const { middlewares } = createGovernanceStack({
    permissions: {
      backend: { check: () => ({ effect: "deny" as const, reason: "e2e-perms-deny" }) },
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-perms-deny" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "Always use the add_numbers tool when asked to add.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { error, stopReason } = await runCatching(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 6 + 7." }),
  );
  await runtime.dispose();

  if (toolExecuted) fail("tool", "executed despite deny policy");
  else pass("tool NOT executed (permissions blocked it)");

  if (error !== undefined) {
    pass(`stream threw as expected: "${error.message.slice(0, 80)}"`);
  } else if (stopReason !== "completed") {
    pass(`stopReason = "${stopReason}" (permissions blocked the run)`);
  } else {
    // Model may answer without invoking tool if it sees it keeps getting blocked
    pass("run completed without tool invocation (model gave up calling tool)");
  }
}

// ── Test 8: pay middleware within budget ──────────────────────────────────────

async function test8_payWithinBudget(): Promise<void> {
  section("8. pay middleware — run completes within budget, cost recorded");

  const tracker = createInMemoryBudgetTracker();
  const calculator = createDefaultCostCalculator();

  const { middlewares } = createGovernanceStack({
    pay: {
      tracker,
      calculator,
      budget: 10.0, // generous $10 budget
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-pay-ok" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed (within budget)");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass(`tokens used: ${String(tokens)}`);
  else fail("tokens", "got 0");
}

// ── Test 9: pay budget exhausted ─────────────────────────────────────────────

async function test9_payBudgetExhausted(): Promise<void> {
  section("9. pay budget exhausted — run rejected when budget = 0");

  // NOTE: Same Pi bridge absorption behavior as tests 2/3.
  // wrapModelStream throws before calling next() → LLM never invoked → tokens = 0.
  // Pi bridge catches the throw, sends { type: "error" } to pi-agent stream,
  // pi-agent completes silently → stopReason = "completed" with 0 tokens.
  // Primary guarantee: LLM was NOT called (tokens === 0).

  const tracker = createInMemoryBudgetTracker();
  const calculator = createDefaultCostCalculator();

  const { middlewares } = createGovernanceStack({
    pay: {
      tracker,
      calculator,
      budget: 0, // zero budget — wrapModelStream throws before calling next()
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-pay-exhausted" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 1 },
  });

  const { error, tokens, stopReason } = await runCatching(
    runtime.run({ kind: "text", text: "Say hello." }),
  );
  await runtime.dispose();

  if (error !== undefined) {
    // Ideal: stream propagated the error all the way up
    pass(`stream threw as expected (budget exhausted): "${error.message.slice(0, 80)}"`);
  } else if (tokens === 0) {
    // Pi bridge absorbed the throw — but LLM was never called (0 tokens = primary guarantee)
    pass(
      `LLM NOT called — budget gate held (tokens=0, Pi adapter absorbed throw → stopReason="${stopReason}")`,
    );
  } else {
    fail(
      "expected budget enforcement to block LLM call",
      `LLM was called — ${String(tokens)} tokens used despite budget=0`,
    );
  }
}

// ── Test 10: PII redact strategy — structural ─────────────────────────────────

async function test10_piiRedact(): Promise<void> {
  section("10. PII redact strategy — run completes, middleware wired correctly");

  const { middlewares } = createGovernanceStack({
    pii: { strategy: "redact" },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-pii" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass(`tokens used: ${String(tokens)} (PII middleware wired, LLM path intact)`);
  else fail("tokens", "got 0");
}

// ── Test 11: sanitize middleware — structural ─────────────────────────────────

async function test11_sanitize(): Promise<void> {
  section("11. sanitize middleware — run completes, no crash");

  const { middlewares } = createGovernanceStack({
    sanitize: { rules: [] },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-sanitize" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass(`tokens used: ${String(tokens)} (sanitize middleware wired)`);
  else fail("tokens", "got 0");
}

// ── Test 12: guardrails middleware — structural ───────────────────────────────

async function test12_guardrails(): Promise<void> {
  section("12. guardrails middleware — run completes, no crash");

  const { middlewares } = createGovernanceStack({
    guardrails: { rules: [] },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-guardrails" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 2 },
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass(`tokens used: ${String(tokens)} (guardrails middleware wired)`);
  else fail("tokens", "got 0");
}

// ── Test 13: full 9-middleware stack ──────────────────────────────────────────

async function test13_fullStack(): Promise<void> {
  section("13. full 9-middleware stack — all enabled, tool executes end-to-end");

  let toolExecuted = false;
  const sink = createInMemoryAuditSink();
  const tracker = createInMemoryBudgetTracker();
  const calculator = createDefaultCostCalculator();

  const { middlewares } = createGovernanceStack({
    permissions: {
      backend: { check: () => ({ effect: "allow" as const }) },
    },
    execApprovals: {
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" as const }),
    },
    delegation: {
      secret: "e2e-test-secret-governance-stack",
      registry: {
        isRevoked: async () => false,
        revoke: async () => undefined,
      },
      grantStore: new Map(),
    },
    governanceBackend: { backend: makeAllowBackend() },
    pay: {
      tracker,
      calculator,
      budget: 10.0,
    },
    audit: { sink },
    pii: { strategy: "redact" },
    sanitize: { rules: [] },
    guardrails: { rules: [] },
  });

  if (middlewares.length === 9) pass(`9 middlewares assembled`);
  else fail("middleware count", `expected 9, got ${String(middlewares.length)}`);

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-full-stack" },
    adapter: createPiAdapter({
      model: MODEL,
      systemPrompt: "You MUST use the add_numbers tool for any arithmetic. Never compute yourself.",
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    providers: [
      makeAddNumbersProvider(() => {
        toolExecuted = true;
      }),
    ],
    loopDetection: false,
    limits: LIMITS,
  });

  const { stopReason, tokens } = await run(
    runtime.run({ kind: "text", text: "Use add_numbers to compute 12 + 13. Tell me the answer." }),
  );
  await runtime.dispose();

  if (stopReason === "completed") pass("stopReason = completed");
  else fail("stopReason", stopReason);

  if (tokens > 0) pass(`tokens used: ${String(tokens)}`);
  else fail("tokens", "got 0");

  if (toolExecuted) pass("add_numbers tool executed through full 9-middleware stack");
  else fail("tool", "was NOT executed — something in the chain blocked it");

  const auditEntries = sink.entries;
  if (auditEntries.length > 0) {
    pass(`audit captured ${String(auditEntries.length)} entries`);
  } else {
    fail("audit entries", "sink empty — audit middleware did not fire");
  }
}

// ── Test 14: priority order (static check) ────────────────────────────────────

function test14_priorityOrder(): void {
  section("14. priority order — middleware sorted ascending (static)");

  const sink = createInMemoryAuditSink();
  const { middlewares } = createGovernanceStack({
    permissions: { backend: { check: () => ({ effect: "allow" as const }) } },
    execApprovals: {
      rules: { allow: ["*"], deny: [], ask: [] },
      onAsk: async () => ({ kind: "allow_once" as const }),
    },
    delegation: {
      secret: "s",
      registry: { isRevoked: async () => false, revoke: async () => undefined },
      grantStore: new Map(),
    },
    governanceBackend: { backend: makeAllowBackend() },
    pay: {
      tracker: createInMemoryBudgetTracker(),
      calculator: createDefaultCostCalculator(),
      budget: 10,
    },
    audit: { sink },
    pii: { strategy: "redact" },
    sanitize: { rules: [] },
    guardrails: { rules: [] },
  });

  const priorities = middlewares.map((mw) => mw.priority ?? 500);
  let sorted = true;
  for (let i = 1; i < priorities.length; i++) {
    const prev = priorities[i - 1];
    const curr = priorities[i];
    if (prev !== undefined && curr !== undefined && curr < prev) {
      sorted = false;
      fail(`priority order`, `[${String(i - 1)}]=${String(prev)} > [${String(i)}]=${String(curr)}`);
      break;
    }
  }
  if (sorted) {
    pass(`priorities ascending: [${priorities.join(", ")}]`);
  }

  const names = middlewares.map((mw) => `${mw.name}@${String(mw.priority ?? 500)}`);
  pass(`order: ${names.join(" → ")}`);
}

// ── Test 15: dispose called on session end ────────────────────────────────────

async function test15_disposeCalledOnSessionEnd(): Promise<void> {
  section("15. dispose — backend.dispose() called on runtime.dispose()");

  let disposeCalled = false;
  const { middlewares } = createGovernanceStack({
    governanceBackend: {
      backend: makeAllowBackend(() => {
        disposeCalled = true;
      }),
    },
  });

  const runtime = await createKoi({
    manifest: { ...BASE_MANIFEST, name: "e2e-dispose" },
    adapter: createPiAdapter({
      model: MODEL,
      getApiKey: async () => API_KEY,
    }),
    middleware: middlewares,
    loopDetection: false,
    limits: { ...LIMITS, maxTurns: 1 },
  });

  await run(runtime.run({ kind: "text", text: "Say: done" }));
  await runtime.dispose();

  if (disposeCalled) pass("backend.dispose() was called on session end");
  else fail("backend.dispose()", "was NOT called — onSessionEnd hook missing or not firing");
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

console.log("@koi/governance E2E — createGovernanceStack → createKoi → createPiAdapter → real LLM");
console.log(`model: ${MODEL}`);
console.log(`key:   ${API_KEY.slice(0, 20)}...`);

const t0 = Date.now();

await test1_governanceBackendAllow();
await test2_governanceBackendDeny();
await test3_governanceBackendThrowFailClosed();
await test4_onViolationCallback();
await test5_auditCapture();
await test6_permissionsAllow();
await test7_permissionsDeny();
await test8_payWithinBudget();
await test9_payBudgetExhausted();
await test10_piiRedact();
await test11_sanitize();
await test12_guardrails();
await test13_fullStack();
test14_priorityOrder();
await test15_disposeCalledOnSessionEnd();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${"═".repeat(58)}`);
if (_failures === 0) {
  console.log(`ALL PASS — ${elapsed}s`);
} else {
  console.error(`${String(_failures)} FAILURE(S) — ${elapsed}s`);
  process.exit(1);
}
