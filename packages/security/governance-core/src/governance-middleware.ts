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
      if (backend.compliance !== undefined) {
        void Promise.resolve(
          backend.compliance.recordCompliance({
            requestId: nextRequestId(request, kind),
            request: redactForAudit(request),
            verdict,
            evaluatedAt: Date.now(),
            policyFingerprint: GOVERNANCE_MIDDLEWARE_NAME,
          }),
        ).catch(warnCompliance);
      }
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

    if (backend.compliance !== undefined) {
      void Promise.resolve(
        backend.compliance.recordCompliance({
          requestId: nextRequestId(request, kind),
          request: redactForAudit(request),
          verdict: GOVERNANCE_ALLOW,
          evaluatedAt: Date.now(),
          policyFingerprint: GOVERNANCE_MIDDLEWARE_NAME,
        }),
      ).catch(warnCompliance);
    }
  }

  async function recordModelUsage(ctx: TurnContext, response: ModelResponse): Promise<void> {
    if (response.usage === undefined) return;
    const usage = normalizeUsage(response.usage, response.metadata);
    const costUsd = cost.calculate(response.model, usage.inputTokens, usage.outputTokens);
    await controller.record({
      kind: "token_usage",
      count: usage.inputTokens + usage.outputTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd,
    });
    const snap = await controller.snapshot();
    alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
    onUsage?.({ model: response.model, usage, costUsd });

    // Fail-fast: if this call pushed us past a setpoint, deny the in-flight
    // response instead of waiting for the next request. Containment > advisory.
    const postCheck = await controller.checkAll();
    if (!postCheck.ok) {
      throw KoiRuntimeError.from(
        "RATE_LIMIT",
        `Governance setpoint exceeded after call: ${postCheck.variable}`,
        {
          retryable: postCheck.retryable,
          context: {
            agentId: ctx.session.agentId,
            sessionId: ctx.session.sessionId,
            kind: "model_call",
            variable: postCheck.variable,
          },
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
      try {
        const snap = await controller.snapshot();
        alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
      } catch (e) {
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
      for await (const chunk of next(request)) {
        yield chunk;
        if (chunk.kind === "done") {
          await recordModelUsage(ctx, chunk.response);
        }
      }
    },

    async wrapToolCall(ctx: TurnContext, request, next) {
      await gate(ctx, "tool_call", { toolId: request.toolId, input: request.input });
      return next(request);
    },
  };
}
