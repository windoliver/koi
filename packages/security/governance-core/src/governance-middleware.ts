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

export function createGovernanceMiddleware(config: GovernanceMiddlewareConfig): KoiMiddleware {
  const { backend, controller, cost, onAlert, onViolation, onUsage } = config;
  const alertTracker = createAlertTracker({
    thresholds: config.alertThresholds ?? DEFAULT_ALERT_THRESHOLDS,
  });

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
            requestId: `${request.agentId}:${kind}:${request.timestamp}`,
            request,
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
          requestId: `${request.agentId}:${kind}:${request.timestamp}`,
          request,
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
      const snap = await controller.snapshot();
      alertTracker.checkAndFire(ctx.session.sessionId, snap, onAlert);
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

    async *wrapModelStream(_ctx, request, next) {
      yield* next(request);
    },

    async wrapToolCall(_ctx, request, next) {
      return next(request);
    },
  };
}
