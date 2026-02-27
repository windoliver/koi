/**
 * Governance backend middleware factory — pluggable policy evaluation gate.
 *
 * Wraps every model call and tool call with a GovernanceBackend.evaluate()
 * call. Fail-closed: if evaluate() throws, the error propagates as a denial.
 * Never treats a throwing backend as permissive.
 */

import { agentId } from "@koi/core";
import type { GovernanceBackendEvent } from "@koi/core/governance-backend";
import type { KoiMiddleware } from "@koi/core/middleware";
import type { GovernanceBackendMiddlewareConfig } from "./config.js";

const MIDDLEWARE_NAME = "koi:governance-backend";
const MIDDLEWARE_PRIORITY = 150;

export function createGovernanceBackendMiddleware(
  config: GovernanceBackendMiddlewareConfig,
): KoiMiddleware {
  const { backend, onViolation } = config;

  async function gate(event: GovernanceBackendEvent): Promise<void> {
    // Fail-closed: if evaluate() throws, the error propagates as a denial.
    const verdict = await backend.evaluate(event);
    if (!verdict.ok) {
      onViolation?.(verdict, event);
      // Record attestation best-effort — does not block the violation throw.
      void Promise.resolve(
        backend.recordAttestation({
          agentId: event.agentId,
          ruleId: "governance-backend",
          verdict,
        }),
      ).catch((e: unknown) => {
        console.warn("[koi:governance-backend] Failed to record attestation", {
          agentId: event.agentId,
          cause: e,
        });
      });
      const msgs = verdict.violations.map((v) => v.message).join("; ");
      throw new Error(`Governance policy violation: ${msgs}`);
    }
  }

  return {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    wrapModelCall: async (ctx, request, next) => {
      await gate({
        kind: "model_call",
        agentId: agentId(ctx.session.agentId),
        payload: { model: request.model ?? "unknown" },
        timestamp: Date.now(),
      });
      return next(request);
    },

    wrapModelStream: async function* (ctx, request, next) {
      await gate({
        kind: "model_call",
        agentId: agentId(ctx.session.agentId),
        payload: { model: request.model ?? "unknown" },
        timestamp: Date.now(),
      });
      yield* next(request);
    },

    wrapToolCall: async (ctx, request, next) => {
      await gate({
        kind: "tool_call",
        agentId: agentId(ctx.session.agentId),
        payload: { toolId: request.toolId, input: request.input },
        timestamp: Date.now(),
      });
      return next(request);
    },

    onSessionEnd: async (_ctx) => {
      await backend.dispose?.();
    },
  };
}
