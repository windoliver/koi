import type { JsonObject } from "@koi/core";
import { agentId as toAgentId } from "@koi/core";
import type { GovernanceCheck } from "@koi/core/governance";
import type {
  GovernanceVerdict,
  PolicyRequest,
  PolicyRequestKind,
} from "@koi/core/governance-backend";
import { GOVERNANCE_ALLOW } from "@koi/core/governance-backend";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { createAlertTracker } from "./alert-tracker.js";
import type { GovernanceMiddlewareConfig } from "./config.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./config.js";
import { normalizeUsage } from "./normalize-usage.js";

export const GOVERNANCE_MIDDLEWARE_NAME = "koi:governance-core";
export const GOVERNANCE_MIDDLEWARE_PRIORITY = 150;

function joinMsgs(v: GovernanceVerdict): string {
  if (v.ok) return "";
  return v.violations.map((x) => x.message).join("; ");
}

function warnCompliance(e: unknown): void {
  console.warn("[koi:governance-core] compliance record failed", { cause: e });
}

/**
 * Redact sensitive tool_call payloads before handing them to compliance sinks.
 * Evaluators see the full PolicyRequest (required for rule-matching); audit
 * records receive only toolId + the shape of the input (keys only, no values)
 * to avoid durable leaks of bash commands, file contents, credentials, etc.
 */
function redactForAudit(req: PolicyRequest): PolicyRequest {
  if (req.kind !== "tool_call") return req;
  const payload = req.payload as { toolId?: unknown; input?: unknown };
  const inputKeys =
    typeof payload.input === "object" && payload.input !== null
      ? Object.keys(payload.input as Record<string, unknown>)
      : [];
  return {
    ...req,
    payload: {
      toolId: typeof payload.toolId === "string" ? payload.toolId : "unknown",
      inputKeys,
    },
  };
}

export function createGovernanceMiddleware(config: GovernanceMiddlewareConfig): KoiMiddleware {
  const { backend, controller, cost, onAlert, onViolation, onUsage } = config;
  const alertTracker = createAlertTracker({
    thresholds: config.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS,
  });

  let requestCounter = 0;
  function nextRequestId(request: PolicyRequest, kind: PolicyRequestKind): string {
    requestCounter += 1;
    return `${request.agentId}:${kind}:${request.timestamp}:${requestCounter}`;
  }

  /**
   * Fire-and-forget compliance record with sync-safe error handling.
   * `Promise.resolve(fn())` evaluates fn() eagerly — a synchronous throw
   * escapes before `.catch` attaches. Using `.then(() => fn())` moves the
   * call into the promise chain so both sync and async failures are caught.
   */
  function emitCompliance(
    request: PolicyRequest,
    kind: PolicyRequestKind,
    verdict: GovernanceVerdict,
  ): void {
    const compliance = backend.compliance;
    if (compliance === undefined) return;
    void Promise.resolve()
      .then(() =>
        compliance.recordCompliance({
          requestId: nextRequestId(request, kind),
          request: redactForAudit(request),
          verdict,
          evaluatedAt: Date.now(),
          policyFingerprint: GOVERNANCE_MIDDLEWARE_NAME,
        }),
      )
      .catch(warnCompliance);
  }

  async function gate(
    ctx: TurnContext,
    kind: PolicyRequestKind,
    payload: JsonObject,
  ): Promise<void> {
    let check: GovernanceCheck;
    try {
      check = await controller.checkAll();
    } catch (e) {
      throw KoiRuntimeError.from("PERMISSION", "Governance controller check failed", {
        cause: e,
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
        },
      });
    }
    if (!check.ok) {
      const synth: GovernanceVerdict = {
        ok: false,
        violations: [{ rule: check.variable, severity: "critical", message: check.reason }],
      };
      const synthReq: PolicyRequest = {
        kind,
        agentId: toAgentId(ctx.session.agentId),
        payload,
        timestamp: Date.now(),
      };
      onViolation?.(synth, synthReq);
      throw KoiRuntimeError.from("RATE_LIMIT", `Governance setpoint exceeded: ${check.variable}`, {
        retryable: check.retryable,
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
          variable: check.variable,
        },
      });
    }

    const request: PolicyRequest = {
      kind,
      agentId: toAgentId(ctx.session.agentId),
      payload,
      timestamp: Date.now(),
    };

    const scope = backend.evaluator.scope;
    if (scope !== undefined && !scope.includes(kind)) {
      return; // evaluator declares no interest in this kind; allow
    }

    let verdict: GovernanceVerdict;
    try {
      verdict = await backend.evaluator.evaluate(request);
    } catch (e) {
      throw KoiRuntimeError.from("PERMISSION", "Governance backend evaluation failed", {
        cause: e,
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
        },
      });
    }

    if (!verdict.ok) {
      onViolation?.(verdict, request);
      emitCompliance(request, kind, verdict);
      throw KoiRuntimeError.from("PERMISSION", joinMsgs(verdict), {
        context: {
          agentId: ctx.session.agentId,
          sessionId: ctx.session.sessionId,
          kind,
          violations: verdict.violations.map((v) => ({
            rule: v.rule,
            severity: v.severity,
          })),
        },
      });
    }

    emitCompliance(request, kind, GOVERNANCE_ALLOW);
  }

  async function recordModelUsage(ctx: TurnContext, response: ModelResponse): Promise<void> {
    if (response.usage === undefined) return;
    const usage = normalizeUsage(response.usage, response.metadata);
    const costUsd = cost.calculate(response.model, usage.inputTokens, usage.outputTokens);
    await recordTokenEvent(ctx, response.model, usage.inputTokens, usage.outputTokens, costUsd);
    onUsage?.({ model: response.model, usage, costUsd });
  }

  async function recordTokenEvent(
    ctx: TurnContext,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number,
  ): Promise<void> {
    await controller.record({
      kind: "token_usage",
      count: inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      costUsd,
    });
    const snap = await controller.snapshot();
    alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);

    // DESIGN NOTE — advisory post-call overshoot (intentional, not a bug):
    //
    // Enforcement semantics: setpoint limits are enforced at the NEXT pre-gate
    // (fail-closed). The current call's response is returned even if it
    // pushed the accumulator past the threshold — up to one call's worth of
    // overshoot is admitted. We do NOT throw here.
    //
    // Why advisory here instead of hard-blocking:
    // 1. The provider already consumed the tokens and billed the account,
    //    so throwing away the response wastes real spend without recovering
    //    the budget.
    // 2. True hard containment requires either worst-case reservation before
    //    dispatch (needs a `max_output_tokens` on ModelRequest we don't have)
    //    or session poisoning (out of scope for a single-call middleware —
    //    lives in the host wiring onViolation).
    // 3. Callers needing strict caps: (a) size limits so one-call max cost
    //    << remaining budget, or (b) terminate the session from onViolation.
    //
    // Consequence: trust `cost_usd` as a rolling-cap guardrail, not a
    // penny-accurate hard ceiling. Covered by the "spend limit enforced via
    // cost_usd setpoint" test.
    const postCheck = await controller.checkAll();
    if (!postCheck.ok) {
      onViolation?.(
        {
          ok: false,
          violations: [
            {
              rule: postCheck.variable,
              severity: "critical",
              message: `Overshoot: ${postCheck.reason}`,
            },
          ],
        },
        {
          kind: "model_call",
          agentId: toAgentId(ctx.session.agentId),
          payload: { model, overshoot: true },
          timestamp: Date.now(),
        },
      );
    }
  }

  return {
    name: GOVERNANCE_MIDDLEWARE_NAME,
    priority: GOVERNANCE_MIDDLEWARE_PRIORITY,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment {
      return {
        label: "governance",
        description: "Policy gate + setpoint enforcement active",
      };
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      // Record a turn event so controllers tracking `turn_count` advance.
      // The middleware is the stable boundary where "a turn begins" is
      // observable; engine-side emission exists on the roadmap but is not
      // wired yet, so recording here keeps turn-count enforcement functional
      // under the runtime's default wiring.
      //
      // Fail closed: if the controller cannot accept the turn event, we
      // cannot trust subsequent `checkAll()` reads of `turn_count`, so the
      // turn must not proceed. Silently swallowing would let a degraded
      // controller bypass turn-count containment.
      try {
        await controller.record({ kind: "turn" });
      } catch (e) {
        throw KoiRuntimeError.from("PERMISSION", "Governance turn record failed", {
          cause: e,
          context: {
            agentId: ctx.session.agentId,
            sessionId: ctx.session.sessionId,
          },
        });
      }
      try {
        const snap = await controller.snapshot();
        alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
      } catch (e) {
        // Snapshot/alert is observability-only — safe to warn and continue.
        console.warn("[koi:governance-core] snapshot failed in onBeforeTurn", { cause: e });
      }
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      alertTracker.cleanup(ctx.sessionId);
    },

    async wrapModelCall(ctx: TurnContext, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      const response = await next(request);
      await recordModelUsage(ctx, response);
      return response;
    },

    async *wrapModelStream(ctx: TurnContext, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      // Stream usage accounting:
      // - `usage` chunks are additive (providers emit deltas per segment)
      // - `error` chunks may carry authoritative totals (override delta sum)
      // - `done` carries the authoritative ModelResponse.usage (wins over both)
      // Fallback path (finally) flushes accumulated deltas only when no
      // terminal chunk arrived — aborted iterations, thrown errors, etc.
      let accumulatedInputTokens = 0;
      let accumulatedOutputTokens = 0;
      let errorUsageInputTokens: number | undefined;
      let errorUsageOutputTokens: number | undefined;
      let doneResponse: ModelResponse | undefined;
      const model = request.model ?? "unknown";
      try {
        for await (const chunk of next(request)) {
          yield chunk;
          if (chunk.kind === "usage") {
            accumulatedInputTokens += chunk.inputTokens;
            accumulatedOutputTokens += chunk.outputTokens;
          } else if (chunk.kind === "error") {
            if (chunk.usage !== undefined) {
              errorUsageInputTokens = chunk.usage.inputTokens;
              errorUsageOutputTokens = chunk.usage.outputTokens;
            }
          } else if (chunk.kind === "done") {
            doneResponse = chunk.response;
          }
        }
      } finally {
        // Precedence: done > error.usage > accumulated deltas.
        if (doneResponse !== undefined) {
          await recordModelUsage(ctx, doneResponse);
        } else {
          const inputTokens = errorUsageInputTokens ?? accumulatedInputTokens;
          const outputTokens = errorUsageOutputTokens ?? accumulatedOutputTokens;
          if (inputTokens > 0 || outputTokens > 0) {
            const costUsd = cost.calculate(model, inputTokens, outputTokens);
            await recordTokenEvent(ctx, model, inputTokens, outputTokens, costUsd);
            onUsage?.({
              model,
              usage: {
                inputTokens,
                outputTokens,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
              },
              costUsd,
            });
          }
        }
      }
    },

    async wrapToolCall(ctx: TurnContext, request, next) {
      await gate(ctx, "tool_call", { toolId: request.toolId, input: request.input });
      // Record tool outcome so the controller's `error_rate` variable has
      // samples to count against its threshold.
      //
      // Fail closed on record failures: `error_rate` is a safety signal,
      // and a degraded controller/recorder means subsequent checkAll() reads
      // stale state. If we cannot trust the outcome log, we must stop
      // admitting new tool calls. The outcome is still rethrown below so
      // callers see the original tool result/error as well.
      const toolName = request.toolId;
      let outcomeError: unknown;
      let toolError: unknown;
      let hasToolError = false;
      let result: Awaited<ReturnType<typeof next>> | undefined;
      try {
        result = await next(request);
        try {
          await controller.record({ kind: "tool_success", toolName });
        } catch (e) {
          outcomeError = e;
        }
      } catch (err) {
        hasToolError = true;
        toolError = err;
        try {
          await controller.record({ kind: "tool_error", toolName });
        } catch (e) {
          outcomeError = e;
        }
      }
      if (outcomeError !== undefined) {
        throw KoiRuntimeError.from("PERMISSION", "Governance tool outcome record failed", {
          cause: outcomeError,
          context: {
            agentId: ctx.session.agentId,
            sessionId: ctx.session.sessionId,
            toolName,
          },
        });
      }
      if (hasToolError) throw toolError;
      return result as Awaited<ReturnType<typeof next>>;
    },
  };
}
