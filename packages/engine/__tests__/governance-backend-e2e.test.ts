/**
 * E2E test for GovernanceBackend ISP-split interface (#265) through
 * createKoi + createPiAdapter with real Anthropic API calls.
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 * Run: E2E_TESTS=1 bun test packages/engine/__tests__/governance-backend-e2e.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentId,
  ComplianceRecord,
  ConstraintQuery,
  EngineEvent,
  EngineOutput,
  GovernanceBackend,
  GovernanceVerdict,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  PolicyRequest,
  ToolRequest,
  TurnContext,
  Violation,
  ViolationFilter,
  ViolationPage,
} from "@koi/core";
import {
  DEFAULT_VIOLATION_QUERY_LIMIT,
  GOVERNANCE_ALLOW,
  VIOLATION_SEVERITY_ORDER,
} from "@koi/core";
import { createPiAdapter } from "@koi/engine-pi";
import { createKoi } from "../src/koi.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "anthropic:claude-haiku-4-5-20251001";

/** What the in-memory evaluator returns: allow, block model/tool calls, or throw. */
type BackendMode = "allow" | "block_model" | "block_tool" | "throw";

interface InMemoryBackendState {
  readonly evaluateCalls: ReadonlyArray<{
    readonly request: PolicyRequest;
    readonly verdict: GovernanceVerdict;
  }>;
  readonly complianceRecords: readonly ComplianceRecord[];
  readonly violations: readonly Violation[];
  readonly mode: BackendMode;
  readonly disposed: boolean;
}

/** In-memory GovernanceBackend with all ISP-split sub-interfaces. */
function createInMemoryGovernanceBackend(initialMode: BackendMode = "allow"): {
  readonly backend: GovernanceBackend;
  readonly state: () => InMemoryBackendState;
  readonly setMode: (mode: BackendMode) => void;
} {
  // let-bound for internal mutation (hidden behind closure)
  let mode = initialMode;
  let disposed = false;
  const evaluateCalls: Array<{ request: PolicyRequest; verdict: GovernanceVerdict }> = [];
  const complianceRecords: ComplianceRecord[] = [];
  const storedViolations: Array<
    Violation & { readonly agentId: AgentId; readonly rule: string; readonly recordedAt: number }
  > = [];

  const backend: GovernanceBackend = {
    evaluator: {
      evaluate(request: PolicyRequest): GovernanceVerdict {
        if (disposed) {
          throw new Error("GovernanceBackend: evaluate() called after dispose()");
        }
        if (mode === "throw") {
          throw new Error("GovernanceBackend: intentional throw for fail-closed test");
        }

        // let justified: verdict depends on mode + request kind
        let verdict: GovernanceVerdict;

        if (mode === "block_model" && request.kind === "model_call") {
          const violations: Violation[] = [
            {
              rule: "no-model-calls-in-test",
              severity: "critical",
              message: `Model call blocked by governance backend (kind=${request.kind}, agent=${request.agentId})`,
              context: { kind: request.kind, agentId: request.agentId },
            },
          ];
          verdict = { ok: false, violations };
        } else if (mode === "block_tool" && request.kind === "tool_call") {
          const violations: Violation[] = [
            {
              rule: "no-tool-calls-in-test",
              severity: "warning",
              message: `Tool call blocked by governance backend (tool=${String(request.payload.toolName ?? "unknown")})`,
              context: { kind: request.kind, toolName: request.payload.toolName },
            },
          ];
          verdict = { ok: false, violations };
        } else {
          verdict = GOVERNANCE_ALLOW;
        }

        evaluateCalls.push({ request, verdict });
        return verdict;
      },
    },

    constraints: {
      checkConstraint(query: ConstraintQuery): boolean {
        if (disposed) {
          throw new Error("GovernanceBackend: checkConstraint() called after dispose()");
        }
        // Constraint kind "allow-all" always passes; any other kind is blocked
        return query.kind === "allow-all";
      },
    },

    compliance: {
      recordCompliance(record: ComplianceRecord): ComplianceRecord {
        if (disposed) {
          throw new Error("GovernanceBackend: recordCompliance() called after dispose()");
        }
        complianceRecords.push(record);

        // Store violations from deny verdicts for getViolations()
        if (!record.verdict.ok) {
          for (const v of record.verdict.violations) {
            storedViolations.push({
              ...v,
              agentId: record.request.agentId,
              rule: v.rule,
              recordedAt: record.evaluatedAt,
            });
          }
        }

        return record;
      },
    },

    violations: {
      getViolations(filter: ViolationFilter): ViolationPage {
        // let justified: filtering requires progressive narrowing
        let filtered = [...storedViolations];

        if (filter.agentId !== undefined) {
          filtered = filtered.filter((v) => v.agentId === filter.agentId);
        }
        if (filter.severity !== undefined) {
          const minIdx = VIOLATION_SEVERITY_ORDER.indexOf(filter.severity);
          filtered = filtered.filter((v) => {
            const idx = VIOLATION_SEVERITY_ORDER.indexOf(v.severity);
            return idx >= minIdx;
          });
        }
        if (filter.rule !== undefined) {
          filtered = filtered.filter((v) => v.rule === filter.rule);
        }
        if (filter.since !== undefined) {
          filtered = filtered.filter((v) => v.recordedAt >= filter.since!);
        }
        if (filter.until !== undefined) {
          filtered = filtered.filter((v) => v.recordedAt < filter.until!);
        }

        const limit = filter.limit ?? DEFAULT_VIOLATION_QUERY_LIMIT;
        const items = filtered.slice(0, limit);

        return { items, total: filtered.length };
      },
    },

    dispose(): void {
      disposed = true;
    },
  };

  return {
    backend,
    state: () => ({
      evaluateCalls: [...evaluateCalls],
      complianceRecords: [...complianceRecords],
      violations: [...storedViolations],
      mode,
      disposed,
    }),
    setMode: (m: BackendMode) => {
      mode = m;
    },
  };
}

/** Middleware: evaluate + record compliance for each model/tool call. Fail-closed. */
function createGovernanceBackendMiddleware(
  backend: GovernanceBackend,
  getAgentId: () => AgentId,
): KoiMiddleware {
  // let justified: mutable counter for unique request IDs
  let requestSeq = 0;

  function nextRequestId(): string {
    requestSeq += 1;
    return `gov-req-${requestSeq}`;
  }

  return {
    async wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: (req: ModelRequest) => AsyncIterable<ModelChunk>,
    ): Promise<AsyncIterable<ModelChunk>> {
      const policyRequest: PolicyRequest = {
        kind: "model_call",
        agentId: getAgentId(),
        payload: {
          model: request.model ?? "unknown",
          toolCount: request.tools?.length ?? 0,
        },
        timestamp: Date.now(),
      };

      const verdict = await backend.evaluator.evaluate(policyRequest);

      // Record compliance
      if (backend.compliance) {
        await backend.compliance.recordCompliance({
          requestId: nextRequestId(),
          request: policyRequest,
          verdict,
          evaluatedAt: Date.now(),
          policyFingerprint: "e2e-test-policy-v1",
        });
      }

      if (!verdict.ok) {
        throw new Error(
          `GovernanceBackend denied model call: ${verdict.violations.map((v) => v.message).join("; ")}`,
        );
      }

      return next(request);
    },

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: (req: ToolRequest) => ModelResponse | Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const policyRequest: PolicyRequest = {
        kind: "tool_call",
        agentId: getAgentId(),
        payload: { toolName: request.name },
        timestamp: Date.now(),
      };

      const verdict = await backend.evaluator.evaluate(policyRequest);

      if (backend.compliance) {
        await backend.compliance.recordCompliance({
          requestId: nextRequestId(),
          request: policyRequest,
          verdict,
          evaluatedAt: Date.now(),
          policyFingerprint: "e2e-test-policy-v1",
        });
      }

      if (!verdict.ok) {
        return {
          role: "tool" as const,
          content: [
            {
              kind: "text" as const,
              text: `GOVERNANCE DENIED: ${verdict.violations.map((v) => v.message).join("; ")}`,
            },
          ],
        };
      }

      return next(request);
    },
  };
}

/** Drain an AsyncIterable<EngineEvent> into an EngineOutput. */
async function drainEngine(stream: AsyncIterable<EngineEvent>): Promise<EngineOutput> {
  // let justified: accumulates output from generator
  let output: EngineOutput | undefined;
  for await (const event of stream) {
    if (event.kind === "output") {
      output = event.output;
    }
  }
  if (!output) {
    throw new Error("Engine stream ended without producing output");
  }
  return output;
}

describeE2E("GovernanceBackend E2E through createKoi + createPiAdapter", () => {
  test(
    "permissive evaluator: evaluate() called on every model call, compliance recorded with real LLM",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");

      // let justified: captured once agent is assembled
      let capturedAgentId: AgentId | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply with a single short sentence.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const agent = createKoi({
        name: "governance-e2e-permissive",
        adapter,
        middleware: [createGovernanceBackendMiddleware(backend, () => capturedAgentId!)],
      });

      capturedAgentId = agent.id;

      const output = await drainEngine(
        agent.stream({
          messages: [
            {
              role: "user",
              content: [{ kind: "text", text: "Say hello in exactly 5 words." }],
            },
          ],
        }),
      );

      const s = state();

      // evaluator was called at least once (model call)
      expect(s.evaluateCalls.length).toBeGreaterThanOrEqual(1);

      // Every evaluate call was for our agent
      for (const call of s.evaluateCalls) {
        expect(call.request.agentId).toBe(capturedAgentId);
        expect(call.request.timestamp).toBeGreaterThan(0);
        expect(["model_call", "tool_call"]).toContain(call.request.kind);
      }

      // Compliance records match evaluate calls
      expect(s.complianceRecords.length).toBe(s.evaluateCalls.length);
      for (const record of s.complianceRecords) {
        expect(record.requestId).toBeTruthy();
        expect(record.policyFingerprint).toBe("e2e-test-policy-v1");
        expect(record.evaluatedAt).toBeGreaterThan(0);
        expect(record.request.agentId).toBe(capturedAgentId);
      }

      // Agent produced output
      expect(output.messages.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  test(
    "blocking evaluator: evaluate() returns { ok: false } → model call denied, engine stops",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("block_model");

      // let justified: captured once agent is assembled
      let capturedAgentId: AgentId | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const agent = createKoi({
        name: "governance-e2e-blocking",
        adapter,
        middleware: [createGovernanceBackendMiddleware(backend, () => capturedAgentId!)],
      });

      capturedAgentId = agent.id;

      // The engine should complete (either with error or stopped) because
      // the middleware throws on deny verdict
      try {
        await drainEngine(
          agent.stream({
            messages: [
              {
                role: "user",
                content: [{ kind: "text", text: "Say hello." }],
              },
            ],
          }),
        );
      } catch {
        // Expected — middleware throws on deny
      }

      const s = state();

      // At least one evaluate call was made
      expect(s.evaluateCalls.length).toBeGreaterThanOrEqual(1);

      // The first model_call evaluate returned a deny verdict
      const modelCalls = s.evaluateCalls.filter((c) => c.request.kind === "model_call");
      expect(modelCalls.length).toBeGreaterThanOrEqual(1);
      expect(modelCalls[0]?.verdict.ok).toBe(false);
      if (!modelCalls[0]?.verdict.ok) {
        expect(modelCalls[0]?.verdict.violations.length).toBeGreaterThan(0);
        expect(modelCalls[0]?.verdict.violations[0]?.rule).toBe("no-model-calls-in-test");
      }

      // Compliance was recorded for the deny
      const denyRecords = s.complianceRecords.filter((r) => !r.verdict.ok);
      expect(denyRecords.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  test(
    "fail-closed contract: evaluate() throws → model call denied, agent does not proceed",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("throw");

      // let justified: captured once agent is assembled
      let capturedAgentId: AgentId | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const agent = createKoi({
        name: "governance-e2e-failclosed",
        adapter,
        middleware: [createGovernanceBackendMiddleware(backend, () => capturedAgentId!)],
      });

      capturedAgentId = agent.id;

      // The engine should fail because the middleware propagates the throw
      try {
        await drainEngine(
          agent.stream({
            messages: [
              {
                role: "user",
                content: [{ kind: "text", text: "Say hello." }],
              },
            ],
          }),
        );
      } catch {
        // Expected — evaluate() throws, middleware propagates
      }

      const s = state();

      // evaluate() was called but threw, so no evaluateCalls recorded
      // (the throw happens before the push)
      expect(s.evaluateCalls.length).toBe(0);

      // No compliance records (throw before recording)
      expect(s.complianceRecords.length).toBe(0);
    },
    TIMEOUT_MS,
  );

  test(
    "checkConstraint(): allow-all passes, other kinds are blocked",
    async () => {
      const { backend } = createInMemoryGovernanceBackend("allow");
      const { agentId } = await import("@koi/core");
      const testAgent = agentId("constraint-test-agent");

      // "allow-all" kind passes
      const allowed = await backend.constraints?.checkConstraint({
        kind: "allow-all",
        agentId: testAgent,
      });
      expect(allowed).toBe(true);

      // Any other kind is blocked
      const blocked = await backend.constraints?.checkConstraint({
        kind: "some-other-constraint",
        agentId: testAgent,
      });
      expect(blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "recordCompliance(): backend records and returns the compliance record",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");
      const { agentId } = await import("@koi/core");
      const testAgent = agentId("compliance-test-agent");

      const request: PolicyRequest = {
        kind: "model_call",
        agentId: testAgent,
        payload: { model: "test-model" },
        timestamp: Date.now(),
      };

      const record: ComplianceRecord = {
        requestId: "test-req-001",
        request,
        verdict: GOVERNANCE_ALLOW,
        evaluatedAt: Date.now(),
        policyFingerprint: "sha256:test-fingerprint",
      };

      const returned = await backend.compliance?.recordCompliance(record);

      // Record is returned as-is
      expect(returned.requestId).toBe("test-req-001");
      expect(returned.policyFingerprint).toBe("sha256:test-fingerprint");
      expect(returned.verdict.ok).toBe(true);
      expect(returned.request.agentId).toBe(testAgent);

      // Stored in state
      const s = state();
      expect(s.complianceRecords.length).toBe(1);
      expect(s.complianceRecords[0]?.requestId).toBe("test-req-001");
    },
    TIMEOUT_MS,
  );

  test(
    "getViolations(): filters work — by agentId, severity, rule, since/until, limit",
    async () => {
      const { backend } = createInMemoryGovernanceBackend("allow");
      const { agentId } = await import("@koi/core");

      const agentA = agentId("violation-agent-a");
      const agentB = agentId("violation-agent-b");
      const now = Date.now();

      // Record some deny verdicts to populate violation store
      const denyVerdicts: ReadonlyArray<{
        readonly agent: AgentId;
        readonly rule: string;
        readonly severity: "info" | "warning" | "critical";
        readonly at: number;
      }> = [
        { agent: agentA, rule: "cost-limit", severity: "critical", at: now - 5000 },
        { agent: agentA, rule: "rate-limit", severity: "warning", at: now - 4000 },
        { agent: agentB, rule: "cost-limit", severity: "critical", at: now - 3000 },
        { agent: agentA, rule: "cost-limit", severity: "info", at: now - 2000 },
        { agent: agentB, rule: "scope-violation", severity: "warning", at: now - 1000 },
      ];

      for (const v of denyVerdicts) {
        const request: PolicyRequest = {
          kind: "model_call",
          agentId: v.agent,
          payload: {},
          timestamp: v.at,
        };
        await backend.compliance?.recordCompliance({
          requestId: `viol-${v.rule}-${v.at}`,
          request,
          verdict: {
            ok: false,
            violations: [{ rule: v.rule, severity: v.severity, message: `${v.rule} violated` }],
          },
          evaluatedAt: v.at,
          policyFingerprint: "test-policy",
        });
      }

      // Filter by agentId
      const agentAPage = await backend.violations?.getViolations({ agentId: agentA });
      expect(agentAPage.items.length).toBe(3);

      // Filter by severity (at or above warning)
      const warningPage = await backend.violations?.getViolations({ severity: "warning" });
      expect(warningPage.items.length).toBe(4); // 2 critical + 2 warning

      // Filter by rule
      const costPage = await backend.violations?.getViolations({ rule: "cost-limit" });
      expect(costPage.items.length).toBe(3);

      // Filter by since/until
      const recentPage = await backend.violations?.getViolations({ since: now - 3500 });
      expect(recentPage.items.length).toBe(3); // last 3 entries

      // Filter with limit
      const limitPage = await backend.violations?.getViolations({ limit: 2 });
      expect(limitPage.items.length).toBe(2);
      expect(limitPage.total).toBe(5); // total before limit

      // Empty filter returns all
      const allPage = await backend.violations?.getViolations({});
      expect(allPage.items.length).toBe(5);

      // DEFAULT_VIOLATION_QUERY_LIMIT is accessible
      expect(DEFAULT_VIOLATION_QUERY_LIMIT).toBe(100);
    },
    TIMEOUT_MS,
  );

  test("VIOLATION_SEVERITY_ORDER: ordering from least to most severe", () => {
    expect(VIOLATION_SEVERITY_ORDER).toEqual(["info", "warning", "critical"]);

    // Verify ordering: info < warning < critical
    const infoIdx = VIOLATION_SEVERITY_ORDER.indexOf("info");
    const warningIdx = VIOLATION_SEVERITY_ORDER.indexOf("warning");
    const criticalIdx = VIOLATION_SEVERITY_ORDER.indexOf("critical");
    expect(infoIdx).toBeLessThan(warningIdx);
    expect(warningIdx).toBeLessThan(criticalIdx);
  });

  test(
    "dispose(): backend signals disposal; operations throw after dispose",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");
      const { agentId } = await import("@koi/core");
      const testAgent = agentId("dispose-test-agent");

      // Before dispose: operations succeed
      const preVerdict = await backend.evaluator.evaluate({
        kind: "model_call",
        agentId: testAgent,
        payload: {},
        timestamp: Date.now(),
      });
      expect(preVerdict.ok).toBe(true);

      // Dispose
      await backend.dispose?.();
      expect(state().disposed).toBe(true);

      // After dispose: evaluate throws
      expect(() =>
        backend.evaluator.evaluate({
          kind: "model_call",
          agentId: testAgent,
          payload: {},
          timestamp: Date.now(),
        }),
      ).toThrow("called after dispose()");

      // After dispose: checkConstraint throws
      expect(() =>
        backend.constraints?.checkConstraint({
          kind: "allow-all",
          agentId: testAgent,
        }),
      ).toThrow("called after dispose()");

      // After dispose: recordCompliance throws
      expect(() =>
        backend.compliance?.recordCompliance({
          requestId: "post-dispose",
          request: {
            kind: "model_call",
            agentId: testAgent,
            payload: {},
            timestamp: Date.now(),
          },
          verdict: GOVERNANCE_ALLOW,
          evaluatedAt: Date.now(),
          policyFingerprint: "test",
        }),
      ).toThrow("called after dispose()");
    },
    TIMEOUT_MS,
  );

  test(
    "GovernanceBackend middleware + GovernanceController coexist in same runtime",
    async () => {
      const { backend, state } = createInMemoryGovernanceBackend("allow");

      // let justified: captured once agent is assembled
      let capturedAgentId: AgentId | undefined;

      const adapter = createPiAdapter({
        model: E2E_MODEL,
        systemPrompt: "You are a concise test assistant. Reply with one short sentence.",
        getApiKey: async () => ANTHROPIC_KEY,
      });

      const agent = createKoi({
        name: "governance-e2e-coexist",
        adapter,
        middleware: [createGovernanceBackendMiddleware(backend, () => capturedAgentId!)],
        governance: {
          maxTurns: 5,
        },
      });

      capturedAgentId = agent.id;

      const output = await drainEngine(
        agent.stream({
          messages: [
            {
              role: "user",
              content: [{ kind: "text", text: "What is 2+2? Answer briefly." }],
            },
          ],
        }),
      );

      const s = state();

      // GovernanceBackend evaluator was called
      expect(s.evaluateCalls.length).toBeGreaterThanOrEqual(1);

      // Compliance was recorded
      expect(s.complianceRecords.length).toBeGreaterThanOrEqual(1);

      // Agent produced output (both governance layers active)
      expect(output.messages.length).toBeGreaterThanOrEqual(1);

      // All evaluations were allowed (mode="allow")
      for (const call of s.evaluateCalls) {
        expect(call.verdict.ok).toBe(true);
      }
    },
    TIMEOUT_MS,
  );

  test(
    "multiple violations per verdict: all violations recorded and queryable",
    async () => {
      const { backend } = createInMemoryGovernanceBackend("allow");
      const { agentId } = await import("@koi/core");
      const testAgent = agentId("multi-violation-agent");

      // Record a deny verdict with multiple violations
      const multiViolationVerdict: GovernanceVerdict = {
        ok: false,
        violations: [
          { rule: "budget-exceeded", severity: "critical", message: "Budget exceeded" },
          { rule: "rate-limit-hit", severity: "warning", message: "Rate limit hit" },
          { rule: "deprecated-api", severity: "info", message: "Using deprecated API" },
        ],
      };

      await backend.compliance?.recordCompliance({
        requestId: "multi-viol-001",
        request: {
          kind: "model_call",
          agentId: testAgent,
          payload: {},
          timestamp: Date.now(),
        },
        verdict: multiViolationVerdict,
        evaluatedAt: Date.now(),
        policyFingerprint: "multi-test",
      });

      // All 3 violations should be queryable
      const allPage = await backend.violations?.getViolations({
        agentId: testAgent,
      });
      expect(allPage.items.length).toBe(3);
      expect(allPage.total).toBe(3);

      // Filter to critical only
      const criticalPage = await backend.violations?.getViolations({
        agentId: testAgent,
        severity: "critical",
      });
      expect(criticalPage.items.length).toBe(1);
      expect(criticalPage.items[0]?.rule).toBe("budget-exceeded");

      // Filter to warning and above
      const warningPage = await backend.violations?.getViolations({
        agentId: testAgent,
        severity: "warning",
      });
      expect(warningPage.items.length).toBe(2); // critical + warning
    },
    TIMEOUT_MS,
  );
});
