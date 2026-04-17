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
      // Emit compliance for setpoint denies so operators can audit
      // quota/runaway incidents. Policy denies below already do this —
      // asymmetry here would leave budget trips invisible in audit logs.
      emitCompliance(synthReq, kind, synth);
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

  /**
   * Non-authoritative wrapper: accounting failures after a successful model
   * call must not discard the response. The provider already consumed tokens
   * and billed the account; surfacing the record error would lose real work
   * and potentially trigger double-billing on retry. Fire onViolation so the
   * host can poison future admission, warn-log, and return.
   */
  function recordModelUsageSoft(ctx: TurnContext, response: ModelResponse, model: string): void {
    recordModelUsage(ctx, response).catch((cause) => {
      console.warn("[koi:governance-core] model accounting failed post-call", { cause, model });
      onViolation?.(
        {
          ok: false,
          violations: [
            {
              rule: "accounting.degraded",
              severity: "critical",
              message: "Model accounting failed — future enforcement state is stale",
            },
          ],
        },
        {
          kind: "model_call",
          agentId: toAgentId(ctx.session.agentId),
          payload: { model, accountingDegraded: true },
          timestamp: Date.now(),
        },
      );
    });
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
      // Observability-only: snapshot and alert at turn start. Turn recording
      // moved to `onAfterTurn` to avoid an off-by-one — the controller trips
      // when `turnCount >= maxTurns`, so recording before any gated call
      // would block the Nth turn at its first model/tool call instead of
      // after N completed turns (e.g., `maxTurns:1` would deny turn 1).
      try {
        const snap = await controller.snapshot();
        alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
      } catch (e) {
        console.warn("[koi:governance-core] snapshot failed in onBeforeTurn", { cause: e });
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Record the turn after it completes so `turnCount` represents
      // consumed turns. Next turn's pre-gate checks `turnCount >= maxTurns`
      // and denies once the budget is spent.
      //
      // Fail closed: if we cannot record, subsequent pre-gate reads of
      // `turn_count` are stale and admission control is bypassed. Throw so
      // the host sees the degradation.
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
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      alertTracker.cleanup(ctx.sessionId);
    },

    async wrapModelCall(ctx: TurnContext, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      const response = await next(request);
      // Non-authoritative: the provider already returned a valid response
      // and consumed tokens. Accounting failures surface via onViolation,
      // not by discarding the caller's completed work.
      recordModelUsageSoft(ctx, response, request.model ?? "unknown");
      return response;
    },

    async *wrapModelStream(ctx: TurnContext, request: ModelRequest, next) {
      await gate(ctx, "model_call", { model: request.model ?? "unknown" });
      // Stream usage accounting:
      // - `usage` chunks are additive (providers emit deltas per segment)
      // - `error` chunks may carry authoritative totals (override delta sum)
      // - `done` carries the authoritative ModelResponse.usage (wins over both)
      //
      // Terminal recording is non-authoritative: the provider already
      // consumed tokens and emitted the terminal chunk. Accounting failures
      // must not discard that chunk — we fire onViolation for the host to
      // poison the session and warn-log, but always deliver the chunk.
      let accumulatedInputTokens = 0;
      let accumulatedOutputTokens = 0;
      let errorUsageInputTokens: number | undefined;
      let errorUsageOutputTokens: number | undefined;
      let terminalRecorded = false;
      const model = request.model ?? "unknown";
      const recordDeltaSoft = (inputTokens: number, outputTokens: number): void => {
        if (inputTokens <= 0 && outputTokens <= 0) return;
        const costUsd = cost.calculate(model, inputTokens, outputTokens);
        recordTokenEvent(ctx, model, inputTokens, outputTokens, costUsd).catch((cause) => {
          console.warn("[koi:governance-core] stream accounting failed", { cause, model });
          onViolation?.(
            {
              ok: false,
              violations: [
                {
                  rule: "accounting.degraded",
                  severity: "critical",
                  message: "Stream accounting failed — future enforcement state is stale",
                },
              ],
            },
            {
              kind: "model_call",
              agentId: toAgentId(ctx.session.agentId),
              payload: { model, accountingDegraded: true },
              timestamp: Date.now(),
            },
          );
        });
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
      };
      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "usage") {
            accumulatedInputTokens += chunk.inputTokens;
            accumulatedOutputTokens += chunk.outputTokens;
            yield chunk;
          } else if (chunk.kind === "error") {
            if (chunk.usage !== undefined) {
              errorUsageInputTokens = chunk.usage.inputTokens;
              errorUsageOutputTokens = chunk.usage.outputTokens;
            }
            recordDeltaSoft(
              errorUsageInputTokens ?? accumulatedInputTokens,
              errorUsageOutputTokens ?? accumulatedOutputTokens,
            );
            terminalRecorded = true;
            yield chunk;
          } else if (chunk.kind === "done") {
            recordModelUsageSoft(ctx, chunk.response, model);
            terminalRecorded = true;
            yield chunk;
          } else {
            yield chunk;
          }
        }
      } finally {
        // Fallback: only fires when no terminal chunk was seen (aborted
        // iteration, mid-stream throw). Charges accumulated deltas so
        // containment still works.
        if (!terminalRecorded) {
          recordDeltaSoft(
            errorUsageInputTokens ?? accumulatedInputTokens,
            errorUsageOutputTokens ?? accumulatedOutputTokens,
          );
        }
      }
    },

    async wrapToolCall(ctx: TurnContext, request, next) {
      await gate(ctx, "tool_call", { toolId: request.toolId, input: request.input });
      // Record tool outcome so the controller's `error_rate` variable has
      // samples to count against its threshold.
      //
      // Outcome-record failures do NOT reclassify the tool call. The side
      // effect has already happened — surfacing PERMISSION here would lie
      // to the caller about whether the action executed and invite duplicate
      // deletes/writes on retry. Instead, fire onViolation so the host can
      // poison the session (block future calls until accounting recovers)
      // and warn-log for observability. The real tool result/error is always
      // returned.
      const toolName = request.toolId;
      const fireRecordFailure = (cause: unknown): void => {
        console.warn("[koi:governance-core] tool outcome record failed", { cause, toolName });
        onViolation?.(
          {
            ok: false,
            violations: [
              {
                rule: "accounting.degraded",
                severity: "critical",
                message: "Tool outcome recording failed — future enforcement state is stale",
              },
            ],
          },
          {
            kind: "tool_call",
            agentId: toAgentId(ctx.session.agentId),
            payload: { toolId: toolName, accountingDegraded: true },
            timestamp: Date.now(),
          },
        );
      };
      try {
        const result = await next(request);
        try {
          await controller.record({ kind: "tool_success", toolName });
        } catch (e) {
          fireRecordFailure(e);
        }
        return result;
      } catch (err) {
        try {
          await controller.record({ kind: "tool_error", toolName });
        } catch (e) {
          fireRecordFailure(e);
        }
        throw err;
      }
    },
  };
}
