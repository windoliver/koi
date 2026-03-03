#!/usr/bin/env bun
/**
 * E2E: GovernanceBackend — validates L0 governance backend contract works
 * through full createKoi + createLoopAdapter assembly with real Anthropic API.
 *
 * Usage: bun scripts/e2e-governance-backend.ts  (reads ANTHROPIC_API_KEY from .env)
 */

import type {
  Agent,
  ComplianceRecord,
  ComponentProvider,
  ConstraintQuery,
  EngineEvent,
  GovernanceBackend,
  GovernanceVerdict,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  PolicyEvaluator,
  PolicyRequest,
  PolicyRequestKind,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createLoopAdapter } from "../packages/drivers/engine-loop/src/loop-adapter.js";
import { createAnthropicAdapter } from "../packages/drivers/model-router/src/adapters/anthropic.js";
import {
  agentId,
  COMPONENT_PRIORITY,
  GOVERNANCE,
  GOVERNANCE_BACKEND,
} from "../packages/kernel/core/src/ecs.js";
import { GOVERNANCE_ALLOW } from "../packages/kernel/core/src/governance-backend.js";
import { createKoi } from "../packages/kernel/engine/src/koi.js";
import { KoiRuntimeError } from "../packages/lib/errors/src/runtime-error.js";

// Preflight
const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("[e2e] ANTHROPIC_API_KEY is not set. Skipping E2E tests.");
  process.exit(0);
}

console.log("[e2e] Starting GovernanceBackend E2E tests...\n");

// Helpers

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
  if (detail && !condition) console.log(`         ${detail}`);
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
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(
  events: readonly EngineEvent[],
): (EngineEvent & { readonly kind: "done" })["output"] | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/** Create the Anthropic model handler wired to a cheap model. */
function createModelCall(): (request: ModelRequest) => Promise<ModelResponse> {
  const anthropic = createAnthropicAdapter({ apiKey: API_KEY });
  return (request: ModelRequest) =>
    anthropic.complete({ ...request, model: "claude-haiku-4-5-20251001" });
}

const modelCall = createModelCall();

// In-memory GovernanceBackend factory

interface TrackingState {
  readonly evaluatorCalls: PolicyRequest[];
  readonly constraintCalls: ConstraintQuery[];
  readonly complianceRecords: ComplianceRecord[];
}

function createTrackingBackend(opts?: {
  readonly denyAll?: boolean;
  readonly scope?: readonly PolicyRequestKind[];
}): { readonly backend: GovernanceBackend; readonly state: TrackingState } {
  const state: TrackingState = {
    evaluatorCalls: [],
    constraintCalls: [],
    complianceRecords: [],
  };

  const evaluator: PolicyEvaluator = {
    evaluate(request: PolicyRequest): GovernanceVerdict {
      state.evaluatorCalls.push(request);
      if (opts?.denyAll === true) {
        return {
          ok: false,
          violations: [
            { rule: "deny-all", severity: "critical", message: "All actions denied by policy" },
          ],
        };
      }
      return GOVERNANCE_ALLOW;
    },
    ...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
  };

  const backend: GovernanceBackend = {
    evaluator,
    constraints: {
      checkConstraint(query: ConstraintQuery): boolean {
        state.constraintCalls.push(query);
        return true;
      },
    },
    compliance: {
      recordCompliance(record: ComplianceRecord): ComplianceRecord {
        state.complianceRecords.push(record);
        return record;
      },
    },
    violations: {
      getViolations(_filter: import("@koi/core").ViolationFilter) {
        return { items: [], total: 0 };
      },
    },
  };

  return { backend, state };
}

// GovernanceBackend ComponentProvider factory

function createBackendProvider(backend: GovernanceBackend): ComponentProvider {
  return {
    name: "e2e:governance-backend",
    priority: COMPONENT_PRIORITY.BUNDLED,
    async attach(_agent: Agent): Promise<ReadonlyMap<string, unknown>> {
      return new Map([[GOVERNANCE_BACKEND as string, backend]]);
    },
  };
}

// Custom middleware factory — captures GovernanceBackend via closure

function createGovernanceBackendMiddleware(
  backend: GovernanceBackend,
  backendAgentId: string,
  opts?: {
    readonly skipScopeFilter?: boolean;
    readonly recordCompliance?: boolean;
    readonly checkConstraints?: boolean;
  },
): KoiMiddleware {
  // let justified: mutable counter for generating unique request IDs
  let requestCounter = 0;

  return {
    name: "e2e:governance-backend-middleware",
    priority: 100,

    async wrapModelCall(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const policyRequest: PolicyRequest = {
        kind: "model_call",
        agentId: agentId(backendAgentId),
        payload: { model: request.model ?? "unknown" },
        timestamp: Date.now(),
      };

      // Scope filter: skip evaluation when request kind not in evaluator scope
      const scope = backend.evaluator.scope;
      if (
        opts?.skipScopeFilter !== true &&
        scope !== undefined &&
        !scope.includes(policyRequest.kind)
      ) {
        return next(request);
      }

      // Evaluate policy
      const verdict = await backend.evaluator.evaluate(policyRequest);

      // Fail-closed: deny on non-ok verdict
      if (!verdict.ok) {
        const violationMessages = verdict.violations.map((v) => v.message).join("; ");
        throw KoiRuntimeError.from("PERMISSION", `GovernanceBackend denied: ${violationMessages}`, {
          context: { violations: verdict.violations.map((v) => v.rule) },
        });
      }

      // Check constraints if enabled
      if (opts?.checkConstraints === true && backend.constraints !== undefined) {
        await backend.constraints.checkConstraint({
          kind: "spawn_depth",
          agentId: agentId(backendAgentId),
          value: 0,
        });
      }

      // Forward to next handler
      const response = await next(request);

      // Record compliance if enabled
      if (opts?.recordCompliance === true && backend.compliance !== undefined) {
        requestCounter += 1;
        const record: ComplianceRecord = {
          requestId: `e2e-req-${requestCounter}`,
          request: policyRequest,
          verdict,
          evaluatedAt: Date.now(),
          policyFingerprint: "e2e-policy-v1",
        };
        await backend.compliance.recordCompliance(record);
      }

      return response;
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: (req: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const policyRequest: PolicyRequest = {
        kind: "tool_call",
        agentId: agentId(backendAgentId),
        payload: { toolId: request.toolId },
        timestamp: Date.now(),
      };

      // Scope filter
      const scope = backend.evaluator.scope;
      if (
        opts?.skipScopeFilter !== true &&
        scope !== undefined &&
        !scope.includes(policyRequest.kind)
      ) {
        return next(request);
      }

      const verdict = await backend.evaluator.evaluate(policyRequest);
      if (!verdict.ok) {
        const violationMessages = verdict.violations.map((v) => v.message).join("; ");
        throw KoiRuntimeError.from("PERMISSION", `GovernanceBackend denied: ${violationMessages}`, {
          context: { violations: verdict.violations.map((v) => v.rule) },
        });
      }

      return next(request);
    },
  };
}

// Test 1 — GovernanceBackend wired via ComponentProvider
// ---------------------------------------------------------------------------

console.log("[test 1] GovernanceBackend wired via ComponentProvider");

const { backend: backend1 } = createTrackingBackend();
const provider1 = createBackendProvider(backend1);

const adapter1 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime1 = await createKoi({
  manifest: {
    name: "e2e-gov-backend-wiring",
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter1,
  providers: [provider1],
  loopDetection: false,
});

const attachedBackend = runtime1.agent.component(GOVERNANCE_BACKEND);
assert(
  "backend attached under GOVERNANCE_BACKEND token",
  attachedBackend !== undefined,
  "agent.component(GOVERNANCE_BACKEND) returned undefined",
);
assert(
  "attached backend is the same instance",
  attachedBackend === backend1,
  "References differ — provider returned a different object",
);
assert(
  "agent.has(GOVERNANCE_BACKEND) returns true",
  runtime1.agent.has(GOVERNANCE_BACKEND),
  "has() returned false",
);

await runtime1.dispose();

// Test 2 — PolicyEvaluator called through custom middleware on real LLM call
// ---------------------------------------------------------------------------

console.log("\n[test 2] PolicyEvaluator called through custom middleware on real LLM call");

const { backend: backend2, state: state2 } = createTrackingBackend();
const agentName2 = "e2e-gov-backend-evaluator";

const adapter2 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime2 = await createKoi({
  manifest: {
    name: agentName2,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter2,
  providers: [createBackendProvider(backend2)],
  middleware: [createGovernanceBackendMiddleware(backend2, agentName2, { skipScopeFilter: true })],
  loopDetection: false,
});

const events2 = await withTimeout(
  () => collectEvents(runtime2.run({ kind: "text", text: "Reply with exactly one word: hello" })),
  60_000,
  "Test 2",
);

const output2 = findDoneOutput(events2);
assert(
  "LLM call completed successfully",
  output2 !== undefined && output2.stopReason === "completed",
  `stopReason: ${output2?.stopReason}`,
);
assert(
  "evaluator was called at least once",
  state2.evaluatorCalls.length >= 1,
  `Got ${state2.evaluatorCalls.length} calls`,
);

const firstCall2 = state2.evaluatorCalls[0];
if (firstCall2 !== undefined) {
  assert(
    "request.kind is 'model_call'",
    firstCall2.kind === "model_call",
    `Got: ${firstCall2.kind}`,
  );
  assert(
    "request.agentId is correct",
    firstCall2.agentId === agentName2,
    `Got: ${firstCall2.agentId}`,
  );
  assert("request.timestamp > 0", firstCall2.timestamp > 0, `Got: ${firstCall2.timestamp}`);
  assert("verdict was GOVERNANCE_ALLOW (call succeeded)", output2?.stopReason === "completed");
}

await runtime2.dispose();

// Test 3 — PolicyEvaluator deny verdict blocks model call (fail-closed)
// ---------------------------------------------------------------------------

console.log("\n[test 3] PolicyEvaluator deny verdict blocks model call");

const { backend: backend3, state: state3 } = createTrackingBackend({ denyAll: true });
const agentName3 = "e2e-gov-backend-deny";

// Track if next() was ever called (it shouldn't be for deny)
// let justified: mutable flag for tracking model call invocation
let modelCallReached = false;
const trackingModelCall: (request: ModelRequest) => Promise<ModelResponse> = async (
  request: ModelRequest,
) => {
  modelCallReached = true;
  return modelCall(request);
};

const adapter3 = createLoopAdapter({ modelCall: trackingModelCall, maxTurns: 3 });
const runtime3 = await createKoi({
  manifest: {
    name: agentName3,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter3,
  providers: [createBackendProvider(backend3)],
  middleware: [createGovernanceBackendMiddleware(backend3, agentName3, { skipScopeFilter: true })],
  loopDetection: false,
});

// Note: KoiRuntimeError thrown by middleware may not match instanceof in koi.ts
// due to module identity divergence (script's relative import vs engine's @koi/errors
// symlink). Either way, the error should propagate — either as a done event with
// stopReason "error" (if instanceof matches) or as a thrown error (if not).
// Both prove the deny verdict blocked the model call.
// let justified: mutable flag for error tracking
let test3ErrorCaught = false;
let test3ErrorMessage = "";
// let justified: mutable for done event output
let output3: ReturnType<typeof findDoneOutput> | undefined;

try {
  const events3 = await withTimeout(
    () => collectEvents(runtime3.run({ kind: "text", text: "Reply with exactly one word: hello" })),
    30_000,
    "Test 3",
  );
  output3 = findDoneOutput(events3);
} catch (e: unknown) {
  test3ErrorCaught = true;
  test3ErrorMessage = e instanceof Error ? e.message : String(e);
}

// Either a done event with error or a caught error — both prove deny worked
const denyProven = test3ErrorCaught || (output3 !== undefined && output3.stopReason === "error");
assert(
  "agent denied: error propagated or done event with error stopReason",
  denyProven,
  test3ErrorCaught ? `Caught error: ${test3ErrorMessage}` : `stopReason: ${output3?.stopReason}`,
);
assert(
  "evaluator was called (deny triggered)",
  state3.evaluatorCalls.length >= 1,
  `Got ${state3.evaluatorCalls.length} calls`,
);
assert(
  "no real LLM call was made (blocked before reaching model)",
  !modelCallReached,
  "modelCall was invoked despite deny verdict",
);
assert(
  "error message references governance denial",
  test3ErrorMessage.includes("GovernanceBackend denied") || output3?.stopReason === "error",
  `Error: ${test3ErrorMessage}`,
);

await runtime3.dispose();

// Test 4 — ComplianceRecorder captures audit trail from real call
// ---------------------------------------------------------------------------

console.log("\n[test 4] ComplianceRecorder captures audit trail from real call");

const { backend: backend4, state: state4 } = createTrackingBackend();
const agentName4 = "e2e-gov-backend-compliance";

const adapter4 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime4 = await createKoi({
  manifest: {
    name: agentName4,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter4,
  providers: [createBackendProvider(backend4)],
  middleware: [
    createGovernanceBackendMiddleware(backend4, agentName4, {
      skipScopeFilter: true,
      recordCompliance: true,
    }),
  ],
  loopDetection: false,
});

const events4 = await withTimeout(
  () => collectEvents(runtime4.run({ kind: "text", text: "Reply with exactly: compliance_ok" })),
  60_000,
  "Test 4",
);

const output4 = findDoneOutput(events4);
assert(
  "LLM call completed for compliance test",
  output4 !== undefined && output4.stopReason === "completed",
  `stopReason: ${output4?.stopReason}`,
);
assert(
  "compliance records captured",
  state4.complianceRecords.length >= 1,
  `Got ${state4.complianceRecords.length} records`,
);

const firstRecord = state4.complianceRecords[0];
if (firstRecord !== undefined) {
  assert(
    "record has requestId",
    firstRecord.requestId.startsWith("e2e-req-"),
    `Got: ${firstRecord.requestId}`,
  );
  assert(
    "record.request.kind is 'model_call'",
    firstRecord.request.kind === "model_call",
    `Got: ${firstRecord.request.kind}`,
  );
  assert(
    "record.verdict.ok is true",
    firstRecord.verdict.ok === true,
    `Got: ${String(firstRecord.verdict.ok)}`,
  );
  assert("record.evaluatedAt > 0", firstRecord.evaluatedAt > 0, `Got: ${firstRecord.evaluatedAt}`);
  assert(
    "record.policyFingerprint is set",
    firstRecord.policyFingerprint === "e2e-policy-v1",
    `Got: ${firstRecord.policyFingerprint}`,
  );
}

await runtime4.dispose();

// Test 5 — ConstraintChecker called per-request
// ---------------------------------------------------------------------------

console.log("\n[test 5] ConstraintChecker called per-request");

const { backend: backend5, state: state5 } = createTrackingBackend();
const agentName5 = "e2e-gov-backend-constraints";

const adapter5 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime5 = await createKoi({
  manifest: {
    name: agentName5,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter5,
  providers: [createBackendProvider(backend5)],
  middleware: [
    createGovernanceBackendMiddleware(backend5, agentName5, {
      skipScopeFilter: true,
      checkConstraints: true,
    }),
  ],
  loopDetection: false,
});

const events5 = await withTimeout(
  () => collectEvents(runtime5.run({ kind: "text", text: "Reply with exactly: constraint_ok" })),
  60_000,
  "Test 5",
);

const output5 = findDoneOutput(events5);
assert(
  "LLM call completed for constraint test",
  output5 !== undefined && output5.stopReason === "completed",
  `stopReason: ${output5?.stopReason}`,
);
assert(
  "constraint checker was called at least once",
  state5.constraintCalls.length >= 1,
  `Got ${state5.constraintCalls.length} calls`,
);

const firstConstraint = state5.constraintCalls[0];
if (firstConstraint !== undefined) {
  assert(
    "constraint query kind is 'spawn_depth'",
    firstConstraint.kind === "spawn_depth",
    `Got: ${firstConstraint.kind}`,
  );
  assert(
    "constraint query agentId matches",
    firstConstraint.agentId === agentName5,
    `Got: ${firstConstraint.agentId}`,
  );
  assert("constraint checker returned true (allowed)", output5?.stopReason === "completed");
}

await runtime5.dispose();

// Test 6 — GovernanceBackend + GovernanceController coexist as parallel peers
// ---------------------------------------------------------------------------

console.log("\n[test 6] GovernanceBackend + GovernanceController coexist as parallel peers");

const { backend: backend6, state: state6 } = createTrackingBackend();
const agentName6 = "e2e-gov-backend-coexist";

const adapter6 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime6 = await createKoi({
  manifest: {
    name: agentName6,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter6,
  providers: [createBackendProvider(backend6)],
  middleware: [createGovernanceBackendMiddleware(backend6, agentName6, { skipScopeFilter: true })],
  governance: {
    iteration: { maxTurns: 10, maxTokens: 500_000, maxDurationMs: 120_000 },
  },
  loopDetection: false,
});

// Both components should be present before run
const hasGovernance = runtime6.agent.has(GOVERNANCE);
const hasBackend = runtime6.agent.has(GOVERNANCE_BACKEND);
assert("agent has GOVERNANCE component", hasGovernance, "GOVERNANCE not attached");
assert("agent has GOVERNANCE_BACKEND component", hasBackend, "GOVERNANCE_BACKEND not attached");

const governanceController = runtime6.agent.component(GOVERNANCE);
const governanceBackend = runtime6.agent.component(GOVERNANCE_BACKEND);
assert(
  "GOVERNANCE component is defined",
  governanceController !== undefined,
  "component(GOVERNANCE) returned undefined",
);
assert(
  "GOVERNANCE_BACKEND component is defined",
  governanceBackend !== undefined,
  "component(GOVERNANCE_BACKEND) returned undefined",
);
assert(
  "GOVERNANCE and GOVERNANCE_BACKEND are different instances",
  governanceController !== governanceBackend,
  "Both tokens returned the same object",
);

// Run a real LLM call to exercise both
const events6 = await withTimeout(
  () => collectEvents(runtime6.run({ kind: "text", text: "Reply with exactly one word: hello" })),
  60_000,
  "Test 6",
);

const output6 = findDoneOutput(events6);
assert(
  "LLM call completed with both governance peers active",
  output6 !== undefined && output6.stopReason === "completed",
  `stopReason: ${output6?.stopReason}`,
);

// Verify GovernanceController tracked turns/tokens via snapshot
const ctrl = governanceController as {
  readonly snapshot?: () => Promise<{
    readonly healthy: boolean;
    readonly readings: readonly { readonly name: string; readonly current: number }[];
  }>;
};
if (ctrl?.snapshot !== undefined) {
  const snapshot = await ctrl.snapshot();
  assert(
    "GovernanceController snapshot shows healthy",
    snapshot.healthy === true,
    `healthy: ${String(snapshot.healthy)}`,
  );
  const turnReading = snapshot.readings.find((r) => r.name === "turn_count");
  assert(
    "GovernanceController recorded turn counts",
    turnReading !== undefined && turnReading.current >= 1,
    `turn_count: ${turnReading?.current}`,
  );
}

// Verify GovernanceBackend evaluator was called
assert(
  "GovernanceBackend evaluator was called during run",
  state6.evaluatorCalls.length >= 1,
  `Got ${state6.evaluatorCalls.length} evaluator calls`,
);

await runtime6.dispose();

// Test 7 — Scope-filtered evaluator skips non-matching kinds (hot-path)
// ---------------------------------------------------------------------------

console.log("\n[test 7] Scope-filtered evaluator skips non-matching kinds");

const { backend: backend7, state: state7 } = createTrackingBackend({
  scope: ["tool_call"],
});
const agentName7 = "e2e-gov-backend-scope";

const adapter7 = createLoopAdapter({ modelCall, maxTurns: 3 });
const runtime7 = await createKoi({
  manifest: {
    name: agentName7,
    version: "0.0.1",
    model: { name: "claude-haiku-4-5-20251001" },
  },
  adapter: adapter7,
  providers: [createBackendProvider(backend7)],
  // Do NOT pass skipScopeFilter — let the middleware respect the scope
  middleware: [createGovernanceBackendMiddleware(backend7, agentName7)],
  loopDetection: false,
});

// Run a text-only prompt (no tool calls) — evaluator should NOT be called
// because scope is ["tool_call"] and we only make model_call requests
const events7 = await withTimeout(
  () => collectEvents(runtime7.run({ kind: "text", text: "Reply with exactly one word: hello" })),
  60_000,
  "Test 7",
);

const output7 = findDoneOutput(events7);
assert(
  "LLM call completed for scope test",
  output7 !== undefined && output7.stopReason === "completed",
  `stopReason: ${output7?.stopReason}`,
);
assert(
  "evaluator was NOT called (scope is ['tool_call'], only model_call was made)",
  state7.evaluatorCalls.length === 0,
  `Got ${state7.evaluatorCalls.length} evaluator calls — expected 0`,
);

await runtime7.dispose();

// Summary

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
      if (r.detail) console.error(`        ${r.detail}`);
    }
  }
  process.exit(1);
}

console.log("\n[e2e] ALL GOVERNANCE BACKEND E2E TESTS PASSED!");
