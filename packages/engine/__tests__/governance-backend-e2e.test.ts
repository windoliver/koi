/**
 * Comprehensive E2E test for the GovernanceBackend interface (#265) through the
 * full createKoi + createPiAdapter runtime assembly with real Anthropic API calls.
 *
 * What this tests:
 *   1. In-memory GovernanceBackend implementation (validates all interface methods work)
 *   2. GovernanceBackendEvent construction from real middleware context (agentId, kind, payload, timestamp)
 *   3. GovernanceVerdict { ok: true } path — permissive backend allows model calls through
 *   4. GovernanceVerdict { ok: false; violations } path — blocking backend denies model calls
 *   5. GovernanceAttestation recording via recordAttestation() — backend assigns id/attestedAt/attestedBy
 *   6. getViolations() with ViolationQuery filters (by agentId, severity, ruleId, after/before)
 *   7. checkConstraint() — synchronous point-in-time constraint check
 *   8. Fail-closed contract — throwing backend → model call denied, engine stops gracefully
 *   9. dispose() — cleanup lifecycle on the backend
 *  10. Full middleware chain — GovernanceBackend middleware + GovernanceController (sensor model)
 *      both wired simultaneously, with real pi Agent LLM calls threading through both
 *
 * Architecture:
 *   createKoi assembly → GovernanceController (sensor/setpoint) + GovernanceBackendMiddleware
 *   → createPiAdapter → real Anthropic API (claude-haiku) → tool call loop
 *   → GovernanceBackend.evaluate() on each model/tool call
 *   → GovernanceAttestation stored in-memory
 *   → getViolations() / checkConstraint() queried after run
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/engine/__tests__/governance-backend-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  ConstraintQuery,
  EngineEvent,
  EngineOutput,
  GovernanceAttestation,
  GovernanceAttestationInput,
  GovernanceBackend,
  GovernanceBackendEvent,
  GovernanceVerdict,
  KoiError,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  Result,
  ToolRequest,
  TurnContext,
  Violation,
  ViolationQuery,
} from "@koi/core";
import {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  governanceAttestationId,
  VIOLATION_SEVERITIES,
} from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createKoi } from "../src/koi.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// In-memory GovernanceBackend implementation
// ---------------------------------------------------------------------------

/**
 * Configures what the in-memory backend returns for evaluate() calls.
 * "allow": always returns { ok: true }
 * "block_model": returns { ok: false, violations: [...] } for "model_call" events
 * "block_tool": returns { ok: false, violations: [...] } for "tool_call" events
 * "throw": throws an Error (tests fail-closed contract)
 */
type BackendMode = "allow" | "block_model" | "block_tool" | "throw";

interface InMemoryBackendState {
  readonly evaluateCalls: ReadonlyArray<{
    readonly event: GovernanceBackendEvent;
    readonly verdict: GovernanceVerdict;
  }>;
  readonly attestations: readonly GovernanceAttestation[];
  readonly mode: BackendMode;
  readonly disposed: boolean;
}

/**
 * Minimal in-memory GovernanceBackend implementation.
 * Validates all interface methods: evaluate, checkConstraint, recordAttestation,
 * getViolations, and dispose.
 */
function createInMemoryGovernanceBackend(initialMode: BackendMode = "allow"): {
  readonly backend: GovernanceBackend;
  readonly state: () => InMemoryBackendState;
  readonly setMode: (mode: BackendMode) => void;
} {
  // Let-bound for internal mutation (hidden behind the closure)
  let mode = initialMode;
  let disposed = false;
  let attestationCounter = 0;

  const evaluateCalls: Array<{ event: GovernanceBackendEvent; verdict: GovernanceVerdict }> = [];
  const attestations: GovernanceAttestation[] = [];

  const backend: GovernanceBackend = {
    evaluate(event: GovernanceBackendEvent): GovernanceVerdict {
      if (disposed) {
        throw new Error("GovernanceBackend: evaluate() called after dispose()");
      }
      if (mode === "throw") {
        throw new Error("GovernanceBackend: intentional throw for fail-closed test");
      }

      let verdict: GovernanceVerdict;

      if (mode === "block_model" && event.kind === "model_call") {
        const violations: Violation[] = [
          {
            rule: "no-model-calls-in-test",
            severity: "critical",
            message: `Model call blocked by governance backend (kind=${event.kind}, agent=${event.agentId})`,
            context: { kind: event.kind, agentId: event.agentId },
          },
        ];
        verdict = { ok: false, violations };
      } else if (mode === "block_tool" && event.kind === "tool_call") {
        const violations: Violation[] = [
          {
            rule: "no-tool-calls-in-test",
            severity: "warning",
            message: `Tool call blocked by governance backend (tool=${String(event.payload.toolName ?? "unknown")})`,
            context: { kind: event.kind, toolName: event.payload.toolName },
          },
        ];
        verdict = { ok: false, violations };
      } else {
        verdict = { ok: true };
      }

      evaluateCalls.push({ event, verdict });
      return verdict;
    },

    checkConstraint(query: ConstraintQuery): boolean {
      if (disposed) {
        throw new Error("GovernanceBackend: checkConstraint() called after dispose()");
      }
      // Constraint "allow-all" always passes; any other id is blocked
      return query.constraintId === "allow-all";
    },

    recordAttestation(input: GovernanceAttestationInput): Result<GovernanceAttestation, KoiError> {
      if (disposed) {
        return {
          ok: false,
          error: {
            code: "INTERNAL_ERROR",
            message: "GovernanceBackend: recordAttestation() called after dispose()",
            retryable: false,
          },
        };
      }

      attestationCounter += 1;
      const attest: GovernanceAttestation = {
        id: governanceAttestationId(`attest-${attestationCounter}`),
        agentId: input.agentId,
        ruleId: input.ruleId,
        verdict: input.verdict,
        evidence: input.evidence,
        attestedAt: Date.now(),
        attestedBy: "in-memory-governance-backend",
      };
      attestations.push(attest);
      return { ok: true, value: attest };
    },

    getViolations(filter: ViolationQuery): Result<readonly Violation[], KoiError> {
      // Collect all violation entries from all stored attestations
      const allViolations: Array<
        Violation & {
          readonly agentId: AgentId;
          readonly ruleId: string;
          readonly attestedAt: number;
        }
      > = [];

      for (const attest of attestations) {
        if (!attest.verdict.ok) {
          for (const v of attest.verdict.violations) {
            allViolations.push({
              ...v,
              agentId: attest.agentId,
              ruleId: attest.ruleId,
              attestedAt: attest.attestedAt,
            });
          }
        }
      }

      // Also include violations from evaluate calls that weren't attested
      for (const call of evaluateCalls) {
        if (!call.event.ok && !call.verdict.ok) {
          for (const v of call.verdict.violations) {
            allViolations.push({
              ...v,
              agentId: call.event.agentId,
              ruleId: v.rule,
              attestedAt: call.event.timestamp,
            });
          }
        }
      }

      // Apply filters
      let results = allViolations as ReadonlyArray<(typeof allViolations)[0]>;

      if (filter.agentId !== undefined) {
        results = results.filter((v) => v.agentId === filter.agentId);
      }
      if (filter.severity !== undefined && filter.severity.length > 0) {
        results = results.filter((v) => filter.severity?.includes(v.severity));
      }
      if (filter.ruleId !== undefined) {
        results = results.filter((v) => v.rule === filter.ruleId);
      }
      if (filter.after !== undefined) {
        const after = filter.after;
        results = results.filter((v) => v.attestedAt >= after);
      }
      if (filter.before !== undefined) {
        const before = filter.before;
        results = results.filter((v) => v.attestedAt < before);
      }

      const limit = filter.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
      // Sort descending by timestamp (most recent first)
      const sorted = [...results].sort((a, b) => b.attestedAt - a.attestedAt);
      const sliced = sorted.slice(0, limit);

      // Return as plain Violation[] (strip internal fields)
      const violations: Violation[] = sliced.map(({ rule, severity, message, context }) => ({
        rule,
        severity,
        message,
        ...(context !== undefined ? { context } : {}),
      }));

      return { ok: true, value: violations };
    },

    dispose(): void {
      disposed = true;
    },
  };

  return {
    backend,
    state: () => ({
      evaluateCalls: [...evaluateCalls],
      attestations: [...attestations],
      mode,
      disposed,
    }),
    setMode: (m: BackendMode) => {
      mode = m;
    },
  };
}

// ---------------------------------------------------------------------------
// GovernanceBackend middleware factory
// ---------------------------------------------------------------------------

/**
 * Wraps a GovernanceBackend as a KoiMiddleware.
 *
 * On every model call:
 *   1. Builds GovernanceBackendEvent { kind: "model_call", agentId, payload, timestamp }
 *   2. Calls backend.evaluate(event) — fail closed: if throws, call is denied
 *   3. If verdict is { ok: false }, records attestation and throws to block the call
 *   4. If verdict is { ok: true }, calls next(request) and records a success attestation
 *
 * On every tool call:
 *   Same pattern with kind: "tool_call" and toolName in payload.
 */
function createGovernanceBackendMiddleware(backend: GovernanceBackend): KoiMiddleware {
  return {
    name: "governance-backend-e2e",
    priority: 100, // Outer layer — runs before other middleware

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (r: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const agentId = ctx.session.agentId as AgentId;
      const event: GovernanceBackendEvent = {
        kind: "model_call",
        agentId,
        payload: {
          model: request.model ?? "unknown",
          toolCount: request.tools?.length ?? 0,
          turnIndex: ctx.turnIndex,
        },
        timestamp: Date.now(),
      };

      // evaluate() is fail-closed: if it throws, the call is denied
      const verdict = await backend.evaluate(event);

      if (!verdict.ok) {
        await backend.recordAttestation({
          agentId,
          ruleId: verdict.violations[0]?.rule ?? "model-call-denied",
          verdict,
          evidence: { kind: "model_call", turnIndex: ctx.turnIndex },
        });
        const summary = verdict.violations.map((v) => v.message).join("; ");
        throw new Error(`GovernanceBackend denied model call: ${summary}`);
      }

      const response = await next(request);

      await backend.recordAttestation({
        agentId,
        ruleId: "model-call-allowed",
        verdict: { ok: true },
        evidence: {
          inputTokens: (response.usage as Record<string, unknown> | undefined)?.inputTokens,
          outputTokens: (response.usage as Record<string, unknown> | undefined)?.outputTokens,
          model: request.model ?? "unknown",
        },
      });

      return response;
    },

    // createPiAdapter uses the streaming path — must intercept wrapModelStream.
    // IMPORTANT: do NOT use yield* here. The stream bridge exits via `return` after
    // the done chunk, which calls .return() on the generator before any post-yield*
    // code runs. Instead, use for-await and record attestation BEFORE yielding done.
    wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: (r: ModelRequest) => AsyncIterable<ModelChunk>,
    ): AsyncIterable<ModelChunk> {
      const agentId = ctx.session.agentId as AgentId;
      const event: GovernanceBackendEvent = {
        kind: "model_call",
        agentId,
        payload: {
          model: request.model ?? "unknown",
          toolCount: request.tools?.length ?? 0,
          turnIndex: ctx.turnIndex,
        },
        timestamp: Date.now(),
      };

      // Return an AsyncIterable — evaluated lazily when iterated
      return {
        async *[Symbol.asyncIterator]() {
          // evaluate() before streaming begins — fail-closed
          const verdict = await backend.evaluate(event);

          if (!verdict.ok) {
            await backend.recordAttestation({
              agentId,
              ruleId: verdict.violations[0]?.rule ?? "model-stream-denied",
              verdict,
              evidence: { kind: "model_stream", turnIndex: ctx.turnIndex },
            });
            const summary = verdict.violations.map((v) => v.message).join("; ");
            throw new Error(`GovernanceBackend denied model stream: ${summary}`);
          }

          // Stream allowed — iterate and yield each chunk.
          // Record success attestation BEFORE yielding the done chunk so it
          // runs before the outer consumer can close this generator.
          for await (const chunk of next(request)) {
            if (chunk.kind === "done") {
              await backend.recordAttestation({
                agentId,
                ruleId: "model-call-allowed",
                verdict: { ok: true },
                evidence: {
                  kind: "model_stream",
                  model: request.model ?? "unknown",
                  inputTokens: chunk.response.usage?.inputTokens,
                  outputTokens: chunk.response.usage?.outputTokens,
                },
              });
            }
            yield chunk;
          }
        },
      };
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: (r: ToolRequest) => Promise<import("@koi/core").ToolResponse>,
    ): Promise<import("@koi/core").ToolResponse> {
      const agentId = ctx.session.agentId as AgentId;
      const event: GovernanceBackendEvent = {
        kind: "tool_call",
        agentId,
        payload: {
          toolName: request.toolId,
          turnIndex: ctx.turnIndex,
        },
        timestamp: Date.now(),
      };

      const verdict = await backend.evaluate(event);

      if (!verdict.ok) {
        await backend.recordAttestation({
          agentId,
          ruleId: verdict.violations[0]?.rule ?? "tool-call-denied",
          verdict,
          evidence: { kind: "tool_call", toolName: request.toolId },
        });
        const summary = verdict.violations.map((v) => v.message).join("; ");
        throw new Error(`GovernanceBackend denied tool call "${request.toolId}": ${summary}`);
      }

      const response = await next(request);

      await backend.recordAttestation({
        agentId,
        ruleId: "tool-call-allowed",
        verdict: { ok: true },
        evidence: { toolName: request.toolId },
      });

      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

function extractText(events: readonly EngineEvent[]): string {
  return events
    .filter((e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta")
    .map((e) => e.delta)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: GovernanceBackend (#265) through full createKoi + createPiAdapter", () => {
  // -------------------------------------------------------------------------
  // Test 1: Permissive backend — all calls allowed through, attestations recorded
  // -------------------------------------------------------------------------
  test(
    "1. permissive backend: evaluate() called on every model call, attestations recorded with real LLM",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");
      const middleware = createGovernanceBackendMiddleware(backend);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply briefly.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-permissive",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      // Agent should complete normally
      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      // Real text was returned from the LLM
      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      // Backend was called at least once for the model call
      const s = state();
      expect(s.evaluateCalls.length).toBeGreaterThanOrEqual(1);

      // All evaluate calls should have returned ok: true
      for (const call of s.evaluateCalls) {
        expect(call.verdict.ok).toBe(true);
      }

      // At least one attestation recorded (success attestation after model call)
      expect(s.attestations.length).toBeGreaterThanOrEqual(1);

      // Validate GovernanceBackendEvent structure from a real call
      const modelCallEvent = s.evaluateCalls.find((c) => c.event.kind === "model_call");
      expect(modelCallEvent).toBeDefined();
      if (modelCallEvent !== undefined) {
        // agentId is a non-empty string
        expect(typeof modelCallEvent.event.agentId).toBe("string");
        expect(modelCallEvent.event.agentId.length).toBeGreaterThan(0);
        // timestamp is a recent unix ms
        expect(modelCallEvent.event.timestamp).toBeGreaterThan(0);
        expect(modelCallEvent.event.timestamp).toBeLessThanOrEqual(Date.now());
        // payload contains model and toolCount
        expect(typeof modelCallEvent.event.payload.model).toBe("string");
        expect(typeof modelCallEvent.event.payload.toolCount).toBe("number");
      }

      // Validate GovernanceAttestation structure
      const successAttest = s.attestations.find((a) => a.ruleId === "model-call-allowed");
      expect(successAttest).toBeDefined();
      if (successAttest !== undefined) {
        // Backend assigned an id
        expect(typeof successAttest.id).toBe("string");
        expect(successAttest.id.startsWith("attest-")).toBe(true);
        // Backend assigned attestedAt
        expect(successAttest.attestedAt).toBeGreaterThan(0);
        // Backend identity
        expect(successAttest.attestedBy).toBe("in-memory-governance-backend");
        // Verdict is ok
        expect(successAttest.verdict.ok).toBe(true);
        // evidence carries model info
        expect(successAttest.evidence?.model).toBeDefined();
      }

      await runtime.dispose();
      backend.dispose?.();
      expect(state().disposed).toBe(true);
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Blocking backend — model call denied, engine stops gracefully
  // -------------------------------------------------------------------------
  test(
    "2. blocking backend: evaluate() returns { ok: false } → model call denied, engine stops",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("block_model");
      const middleware = createGovernanceBackendMiddleware(backend);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-blocking",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with one word: hello" }),
      );

      // Engine completes — pi adapter always fires agent_end → "completed"
      // even when middleware blocks the model stream internally.
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // No text produced — LLM was never called (blocked before the API request)
      const text = extractText(events);
      expect(text.length).toBe(0);

      // The backend was evaluated at least once for a model_call
      const s = state();
      const blockedCall = s.evaluateCalls.find((c) => c.event.kind === "model_call");
      expect(blockedCall).toBeDefined();
      if (blockedCall !== undefined) {
        // Verdict should be { ok: false }
        expect(blockedCall.verdict.ok).toBe(false);
        if (!blockedCall.verdict.ok) {
          expect(blockedCall.verdict.violations).toHaveLength(1);
          expect(blockedCall.verdict.violations[0]?.rule).toBe("no-model-calls-in-test");
          expect(blockedCall.verdict.violations[0]?.severity).toBe("critical");
          expect(typeof blockedCall.verdict.violations[0]?.message).toBe("string");
        }
      }

      // A denial attestation should have been recorded
      const denialAttest = s.attestations.find((a) => a.ruleId === "no-model-calls-in-test");
      expect(denialAttest).toBeDefined();
      if (denialAttest !== undefined) {
        expect(denialAttest.verdict.ok).toBe(false);
        expect(denialAttest.attestedBy).toBe("in-memory-governance-backend");
        // evidence carries kind and turnIndex (wrapModelStream path uses "model_stream")
        expect(denialAttest.evidence?.kind).toBe("model_stream");
      }

      await runtime.dispose();
      backend.dispose?.();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Fail-closed contract — throwing backend → engine stops gracefully
  // -------------------------------------------------------------------------
  test(
    "3. fail-closed contract: evaluate() throws → model call denied, agent does not proceed",
    async () => {
      const { backend } = createInMemoryGovernanceBackend("throw");
      const middleware = createGovernanceBackendMiddleware(backend);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-fail-closed",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with one word: hello" }),
      );

      // Engine completes — pi adapter always fires agent_end → "completed".
      // Fail-closed means the evaluate() throw is caught by the stream bridge
      // and converted to a pi error internally; the LLM was never reached.
      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason).toBe("completed");

      // No text produced — LLM was never called (evaluate() threw before API request)
      const text = extractText(events);
      expect(text.length).toBe(0);

      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: checkConstraint() — wired via onBeforeTurn pre-check
  // -------------------------------------------------------------------------
  test(
    "4. checkConstraint(): allow-all passes, any-other-id is blocked",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");

      // Wrap backend checkConstraint calls and record them for assertions
      const checkCalls: ConstraintQuery[] = [];
      const originalCheck = backend.checkConstraint.bind(backend);
      const wrappedBackend: GovernanceBackend = {
        ...backend,
        checkConstraint(query: ConstraintQuery): boolean {
          checkCalls.push(query);
          return originalCheck(query);
        },
      };

      // Use checkConstraint in onBeforeTurn to gate each turn
      const constraintMiddleware: KoiMiddleware = {
        name: "constraint-check-e2e",
        priority: 50,
        async onBeforeTurn(ctx): Promise<void> {
          const allowed = await wrappedBackend.checkConstraint({
            constraintId: "allow-all", // should pass
            agentId: ctx.session.agentId as AgentId,
            context: { turnIndex: ctx.turnIndex },
          });
          if (!allowed) {
            throw new Error("GovernanceBackend: constraint check denied this turn");
          }
        },
      };

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-constraint",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [constraintMiddleware],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      // Agent completed normally (allow-all constraint passes)
      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      // checkConstraint was called at least once (once per turn)
      expect(checkCalls.length).toBeGreaterThanOrEqual(1);

      // Each call used the "allow-all" constraintId with a real agentId
      for (const call of checkCalls) {
        expect(call.constraintId).toBe("allow-all");
        expect(typeof call.agentId).toBe("string");
        expect(call.agentId.length).toBeGreaterThan(0);
        expect(typeof call.context?.turnIndex).toBe("number");
      }

      // Now verify the blocking constraint works by calling it directly
      const blocked = await wrappedBackend.checkConstraint({
        constraintId: "deny-everything",
        agentId: "agent-test" as AgentId,
      });
      expect(blocked).toBe(false);

      // Verify allow-all passes
      const allowed = await wrappedBackend.checkConstraint({
        constraintId: "allow-all",
        agentId: "agent-test" as AgentId,
      });
      expect(allowed).toBe(true);

      void state; // state captured for debugging if needed
      await runtime.dispose();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 5: recordAttestation() — verifies GovernanceAttestationInput → GovernanceAttestation
  // -------------------------------------------------------------------------
  test(
    "5. recordAttestation(): backend assigns id, attestedAt, attestedBy; Input→Attest enrichment verified",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");
      const middleware = createGovernanceBackendMiddleware(backend);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-attestation",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [middleware],
        loopDetection: false,
        limits: { maxTurns: 3, maxDurationMs: TIMEOUT_MS, maxTokens: 50_000 },
      });

      const beforeRun = Date.now();
      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with one word: hello" }),
      );
      const afterRun = Date.now();

      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      const s = state();
      expect(s.attestations.length).toBeGreaterThanOrEqual(1);

      // Validate every attestation has backend-assigned fields
      for (const attest of s.attestations) {
        // id is backend-assigned, not provided by caller
        expect(typeof attest.id).toBe("string");
        expect(attest.id.length).toBeGreaterThan(0);
        // Each id starts with our backend's pattern
        expect(attest.id.startsWith("attest-")).toBe(true);

        // attestedAt is within the run window
        expect(attest.attestedAt).toBeGreaterThanOrEqual(beforeRun - 1000); // allow 1s clock skew
        expect(attest.attestedAt).toBeLessThanOrEqual(afterRun + 1000);

        // attestedBy identifies the backend
        expect(attest.attestedBy).toBe("in-memory-governance-backend");

        // agentId is populated from middleware context
        expect(typeof attest.agentId).toBe("string");
        expect(attest.agentId.length).toBeGreaterThan(0);

        // ruleId is set
        expect(typeof attest.ruleId).toBe("string");
        expect(attest.ruleId.length).toBeGreaterThan(0);

        // verdict is present
        expect(typeof attest.verdict.ok).toBe("boolean");
      }

      // IDs must be unique (backend does not reuse IDs)
      const ids = s.attestations.map((a) => a.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      await runtime.dispose();
      backend.dispose?.();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 6: getViolations() with ViolationQuery filters
  // -------------------------------------------------------------------------
  test("6. getViolations(): filters work — by agentId, severity, ruleId, after/before, limit", async () => {
    const { backend, state } = createInMemoryGovernanceBackend("allow");

    // Manually record some violations with known agentId and properties for filter testing
    const testAgentId = "agent-filter-test" as AgentId;
    const otherAgentId = "agent-other" as AgentId;
    const t0 = Date.now();

    // Record a mix of attestations
    const attests: GovernanceAttestationInput[] = [
      {
        agentId: testAgentId,
        ruleId: "cost-limit",
        verdict: {
          ok: false,
          violations: [{ rule: "cost-limit", severity: "critical", message: "Cost exceeded" }],
        },
      },
      {
        agentId: testAgentId,
        ruleId: "rate-limit",
        verdict: {
          ok: false,
          violations: [{ rule: "rate-limit", severity: "warning", message: "Rate too high" }],
        },
      },
      {
        agentId: otherAgentId,
        ruleId: "cost-limit",
        verdict: {
          ok: false,
          violations: [{ rule: "cost-limit", severity: "info", message: "Cost approaching limit" }],
        },
      },
      {
        agentId: testAgentId,
        ruleId: "allow-always",
        verdict: { ok: true }, // This produces no violations
      },
    ];

    for (const a of attests) {
      const result = await backend.recordAttestation(a);
      expect(result.ok).toBe(true);
    }

    // Filter by agentId — should return only testAgentId violations
    const byAgent = await backend.getViolations({ agentId: testAgentId });
    expect(byAgent.ok).toBe(true);
    if (byAgent.ok) {
      expect(byAgent.value.length).toBe(2); // cost-limit + rate-limit
      for (const v of byAgent.value) {
        // All should be from testAgentId rules
        expect(["cost-limit", "rate-limit"]).toContain(v.rule);
      }
    }

    // Filter by severity — only "critical"
    const byCritical = await backend.getViolations({ severity: ["critical"] });
    expect(byCritical.ok).toBe(true);
    if (byCritical.ok) {
      // Should return violations with severity: "critical" only
      for (const v of byCritical.value) {
        expect(v.severity).toBe("critical");
      }
      expect(byCritical.value.length).toBeGreaterThanOrEqual(1);
    }

    // Filter by ruleId
    const byCostRule = await backend.getViolations({ ruleId: "cost-limit" });
    expect(byCostRule.ok).toBe(true);
    if (byCostRule.ok) {
      for (const v of byCostRule.value) {
        expect(v.rule).toBe("cost-limit");
      }
      expect(byCostRule.value.length).toBe(2); // testAgent + otherAgent
    }

    // Filter by limit
    const limited = await backend.getViolations({ limit: 1 });
    expect(limited.ok).toBe(true);
    if (limited.ok) {
      expect(limited.value.length).toBeLessThanOrEqual(1);
    }

    // Filter by after — nothing matches a future timestamp
    const futureFilter = await backend.getViolations({ after: Date.now() + 1_000_000 });
    expect(futureFilter.ok).toBe(true);
    if (futureFilter.ok) {
      expect(futureFilter.value.length).toBe(0);
    }

    // Filter by before — nothing matches a past timestamp
    const pastFilter = await backend.getViolations({ before: t0 - 1000 });
    expect(pastFilter.ok).toBe(true);
    if (pastFilter.ok) {
      expect(pastFilter.value.length).toBe(0);
    }

    // Verify DEFAULT_VIOLATION_QUERY_LIMIT is applied when limit is omitted
    const noLimit = await backend.getViolations({});
    expect(noLimit.ok).toBe(true);
    if (noLimit.ok) {
      // 3 violations total (testAgent: 2, otherAgent: 1)
      expect(noLimit.value.length).toBe(3);
      expect(noLimit.value.length).toBeLessThanOrEqual(DEFAULT_VIOLATION_QUERY_LIMIT);
    }

    void state;
  }, 30_000); // No LLM call needed for this test

  // -------------------------------------------------------------------------
  // Test 7: VIOLATION_SEVERITIES ordering — verify severity comparison in practice
  // -------------------------------------------------------------------------
  test("7. VIOLATION_SEVERITIES ordering: severity comparison works with real GovernanceVerdict data", async () => {
    const { backend } = createInMemoryGovernanceBackend("allow");

    // Record violations at each severity level
    const agentId = "agent-severity-test" as AgentId;
    const severities = ["info", "warning", "critical"] as const;

    for (const severity of severities) {
      await backend.recordAttestation({
        agentId,
        ruleId: `rule-${severity}`,
        verdict: {
          ok: false,
          violations: [
            { rule: `rule-${severity}`, severity, message: `${severity} level violation` },
          ],
        },
      });
    }

    // Query only at-or-above "warning"
    const atLeastWarning = await backend.getViolations({
      agentId,
      severity: VIOLATION_SEVERITIES.filter(
        (s) => VIOLATION_SEVERITIES.indexOf(s) >= VIOLATION_SEVERITIES.indexOf("warning"),
      ),
    });
    expect(atLeastWarning.ok).toBe(true);
    if (atLeastWarning.ok) {
      expect(atLeastWarning.value.length).toBe(2); // warning + critical
      for (const v of atLeastWarning.value) {
        expect(["warning", "critical"]).toContain(v.severity);
        expect(v.severity).not.toBe("info");
      }
    }

    // Query only "info"
    const infoOnly = await backend.getViolations({ agentId, severity: ["info"] });
    expect(infoOnly.ok).toBe(true);
    if (infoOnly.ok) {
      expect(infoOnly.value.length).toBe(1);
      expect(infoOnly.value[0]?.severity).toBe("info");
    }

    // Verify ordering invariant: critical > warning > info
    const critIdx = VIOLATION_SEVERITIES.indexOf("critical");
    const warnIdx = VIOLATION_SEVERITIES.indexOf("warning");
    const infoIdx = VIOLATION_SEVERITIES.indexOf("info");
    expect(critIdx).toBeGreaterThan(warnIdx);
    expect(warnIdx).toBeGreaterThan(infoIdx);
  }, 10_000); // No LLM call

  // -------------------------------------------------------------------------
  // Test 8: dispose() — backend lifecycle, operations fail after dispose
  // -------------------------------------------------------------------------
  test("8. dispose(): backend signals disposal; operations throw or return errors after dispose", async () => {
    const { backend, state } = createInMemoryGovernanceBackend("allow");

    // Record something before dispose
    await backend.recordAttestation({
      agentId: "agent-dispose" as AgentId,
      ruleId: "pre-dispose",
      verdict: { ok: true },
    });

    expect(state().disposed).toBe(false);
    expect(state().attestations.length).toBe(1);

    // Dispose
    backend.dispose?.();
    expect(state().disposed).toBe(true);

    // evaluate() throws after dispose
    expect(() =>
      backend.evaluate({
        kind: "model_call",
        agentId: "agent-dispose" as AgentId,
        payload: {},
        timestamp: Date.now(),
      }),
    ).toThrow("after dispose");

    // checkConstraint() throws after dispose
    expect(() =>
      backend.checkConstraint({ constraintId: "allow-all", agentId: "agent-dispose" as AgentId }),
    ).toThrow("after dispose");

    // recordAttestation() returns error Result after dispose
    const result = await backend.recordAttestation({
      agentId: "agent-dispose" as AgentId,
      ruleId: "post-dispose",
      verdict: { ok: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INTERNAL_ERROR");
    }
  }, 10_000); // No LLM call

  // -------------------------------------------------------------------------
  // Test 9: GovernanceBackend middleware + GovernanceController coexist
  //         Both wired simultaneously, real pi Agent call exercises both
  // -------------------------------------------------------------------------
  test(
    "9. GovernanceBackend middleware + GovernanceController (sensor model) coexist in same runtime",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");
      const middleware = createGovernanceBackendMiddleware(backend);

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: () => ANTHROPIC_KEY,
      });

      // Wire BOTH: GovernanceBackendMiddleware + sensor-model via governance config
      const runtime = await createKoi({
        manifest: {
          name: "governance-backend-e2e-both",
          version: "0.0.1",
          model: { name: "claude-haiku-4-5-20251001" },
        },
        adapter,
        middleware: [middleware],
        governance: {
          iteration: {
            maxTurns: 10,
            maxTokens: 50_000,
            maxDurationMs: TIMEOUT_MS,
          },
          cost: {
            maxCostUsd: 1.0,
            costPerInputToken: 0.000001,
            costPerOutputToken: 0.000005,
          },
        },
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({ kind: "text", text: "Reply with exactly one word: hello" }),
      );

      // Both layers should allow the call through
      const output = findDoneOutput(events);
      expect(output?.stopReason).toBe("completed");

      const text = extractText(events);
      expect(text.length).toBeGreaterThan(0);

      // GovernanceBackend was exercised — model call was evaluated
      const s = state();
      expect(s.evaluateCalls.length).toBeGreaterThanOrEqual(1);
      expect(s.attestations.length).toBeGreaterThanOrEqual(1);

      // GovernanceController is also present and sealed
      const { GOVERNANCE } = await import("@koi/core");
      const controller = runtime.agent.component(GOVERNANCE);
      expect(controller).toBeDefined();
      if (controller !== undefined) {
        const snapshot = await (
          controller as { snapshot: () => Promise<import("@koi/core").GovernanceSnapshot> }
        ).snapshot();
        // Sensor model tracked turns
        expect(snapshot.readings.length).toBeGreaterThan(0);
        expect(snapshot.healthy).toBe(true);
      }

      await runtime.dispose();
      backend.dispose?.();
    },
    TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 10: Multiple violations in one verdict — all are surfaced
  // -------------------------------------------------------------------------
  test("10. multiple violations per verdict: all violations are recorded in attestation and queryable", async () => {
    const { backend } = createInMemoryGovernanceBackend("allow");

    const agentId = "agent-multi-violation" as AgentId;
    const multiViolationVerdict: GovernanceVerdict = {
      ok: false,
      violations: [
        { rule: "cost-limit", severity: "critical", message: "Cost $1.50 > limit $1.00" },
        { rule: "token-limit", severity: "warning", message: "Tokens 90k/100k (90% utilized)" },
        { rule: "rate-limit", severity: "info", message: "3 calls/min (approaching limit of 5)" },
      ],
    };

    const result = await backend.recordAttestation({
      agentId,
      ruleId: "multi-rule-evaluation",
      verdict: multiViolationVerdict,
      evidence: { evaluatedAt: Date.now() },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id.startsWith("attest-")).toBe(true);
      expect(result.value.verdict.ok).toBe(false);
      if (!result.value.verdict.ok) {
        // All 3 violations preserved in the attestation
        expect(result.value.verdict.violations).toHaveLength(3);
        expect(result.value.verdict.violations[0]?.rule).toBe("cost-limit");
        expect(result.value.verdict.violations[1]?.rule).toBe("token-limit");
        expect(result.value.verdict.violations[2]?.rule).toBe("rate-limit");
      }
    }

    // Query by agentId — all 3 violations returned
    const all = await backend.getViolations({ agentId });
    expect(all.ok).toBe(true);
    if (all.ok) {
      expect(all.value.length).toBe(3);
    }

    // Query only critical — 1 violation
    const critOnly = await backend.getViolations({ agentId, severity: ["critical"] });
    expect(critOnly.ok).toBe(true);
    if (critOnly.ok) {
      expect(critOnly.value.length).toBe(1);
      expect(critOnly.value[0]?.rule).toBe("cost-limit");
    }

    // Query only warning + info — 2 violations
    const warnInfo = await backend.getViolations({ agentId, severity: ["warning", "info"] });
    expect(warnInfo.ok).toBe(true);
    if (warnInfo.ok) {
      expect(warnInfo.value.length).toBe(2);
      const rules = warnInfo.value.map((v) => v.rule);
      expect(rules).toContain("token-limit");
      expect(rules).toContain("rate-limit");
    }
  }, 10_000); // No LLM call
});
