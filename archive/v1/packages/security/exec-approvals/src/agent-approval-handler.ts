/**
 * Child-side agent approval handler factory.
 *
 * When a child agent's exec-approvals middleware hits an "ask" rule,
 * this handler routes the request to the parent agent via MailboxComponent
 * instead of prompting a human directly.
 *
 * Flow: child ask → send IPC to parent → wait for response → map to ProgressiveDecision
 * Fallback: on timeout, malformed response, or send failure → delegate to fallback (HITL).
 */

import type { AgentId, MailboxComponent } from "@koi/core";
import { waitForResponse } from "@koi/delegation";
import { KoiRuntimeError } from "@koi/errors";

import { DEFAULT_APPROVAL_TIMEOUT_MS } from "./config.js";
import type { ExecApprovalIpcPayload } from "./ipc-types.js";
import { EXEC_APPROVAL_REQUEST_TYPE, validateExecApprovalIpcResponse } from "./ipc-types.js";
import type { ExecApprovalRequest, ProgressiveDecision } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AgentApprovalHandlerConfig {
  readonly parentId: AgentId;
  readonly childAgentId: AgentId;
  readonly mailbox: MailboxComponent;
  /** Timeout for waiting on parent response. Defaults to 30s. */
  readonly timeoutMs?: number | undefined;
  /** Fallback when IPC fails (timeout, malformed, send error). Typically HITL prompt. */
  readonly fallback?: ((req: ExecApprovalRequest) => Promise<ProgressiveDecision>) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an onAsk handler that routes approval requests to a parent agent.
 *
 * Returns a function matching the `onAsk` signature in ExecApprovalsConfig.
 * On any IPC failure, falls back to the provided fallback handler (HITL).
 * If no fallback is configured, throws a KoiRuntimeError.
 */
export function createAgentApprovalHandler(
  config: AgentApprovalHandlerConfig,
): (req: ExecApprovalRequest) => Promise<ProgressiveDecision> {
  const {
    parentId,
    childAgentId,
    mailbox,
    timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    fallback,
  } = config;

  return async (req: ExecApprovalRequest): Promise<ProgressiveDecision> => {
    // Build IPC payload
    const payload: ExecApprovalIpcPayload = {
      toolId: req.toolId,
      input: req.input,
      matchedPattern: req.matchedPattern,
      childAgentId: childAgentId as string,
      riskAnalysis:
        req.riskAnalysis !== undefined
          ? { riskLevel: req.riskAnalysis.riskLevel, rationale: req.riskAnalysis.rationale }
          : undefined,
    };

    // Send request to parent
    const sendResult = await mailbox
      .send({
        from: childAgentId,
        to: parentId,
        kind: "request",
        type: EXEC_APPROVAL_REQUEST_TYPE,
        payload: payload as unknown as Record<string, unknown>,
        ttlSeconds: Math.ceil(timeoutMs / 1000),
      })
      .catch((e: unknown) => ({
        ok: false as const,
        error: {
          code: "EXTERNAL" as const,
          message: e instanceof Error ? e.message : "mailbox.send() failed",
          retryable: false,
        },
      }));

    if (!sendResult.ok) {
      return invokeFallback(fallback, req, `Send failed: ${sendResult.error.message}`);
    }

    const correlationId = sendResult.value.id;

    // Wait for matching response via delegation's waitForResponse
    const response = await waitForResponse({
      mailbox,
      correlationId,
      timeoutMs,
    });

    if (!response.ok) {
      return invokeFallback(fallback, req, response.reason);
    }

    // Validate response payload
    const validated = validateExecApprovalIpcResponse(response.message.payload);

    if (!validated.ok) {
      return invokeFallback(fallback, req, `Malformed response: ${validated.error.message}`);
    }

    const decision = validated.value.decision;

    // Parent says "ask" → escalate to fallback (HITL)
    if (decision.kind === "ask") {
      return invokeFallback(fallback, req, "Parent escalated to HITL");
    }

    // Map validated response to ProgressiveDecision
    return mapDecision(decision);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapDecision(
  decision: Readonly<{
    kind: string;
    pattern?: string | undefined;
    reason?: string | undefined;
  }>,
): ProgressiveDecision {
  switch (decision.kind) {
    case "allow_once":
      return { kind: "allow_once" };
    case "allow_session":
      return { kind: "allow_session", pattern: decision.pattern ?? "*" };
    case "allow_always":
      return { kind: "allow_always", pattern: decision.pattern ?? "*" };
    case "deny_once":
      return { kind: "deny_once", reason: decision.reason ?? "Denied by parent agent" };
    case "deny_always":
      return {
        kind: "deny_always",
        pattern: decision.pattern ?? "*",
        reason: decision.reason ?? "Denied by parent agent",
      };
    default:
      return { kind: "deny_once", reason: `Unknown decision kind: ${decision.kind}` };
  }
}

async function invokeFallback(
  fallback: ((req: ExecApprovalRequest) => Promise<ProgressiveDecision>) | undefined,
  req: ExecApprovalRequest,
  reason: string,
): Promise<ProgressiveDecision> {
  if (fallback !== undefined) {
    return fallback(req);
  }
  throw KoiRuntimeError.from("EXTERNAL", `Agent approval routing failed: ${reason}`, {
    context: { toolId: req.toolId },
  });
}
