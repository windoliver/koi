/**
 * Approval audit + trajectory-step helpers for the permissions middleware.
 *
 * Extracted from middleware.ts to keep file sizes under 800 lines.
 * Accepts all closure dependencies as explicit factory parameters.
 */

import type { AuditEntry, AuditSink } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { TurnContext } from "@koi/core/middleware";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { swallowError } from "@koi/errors";

const PKG = "@koi/middleware-permissions";

/** Validated approval decision — structural type matching validateApprovalDecision return. */
export type ValidatedApproval =
  | { readonly kind: "allow" }
  | { readonly kind: "always-allow"; readonly scope: "session" | "always" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "modify"; readonly updatedInput: Record<string, unknown> };

export interface ApprovalAuditDeps {
  readonly clock: () => number;
  readonly approvalSink: (sessionId: string, step: RichTrajectoryStep) => void;
}

export function createApprovalAudit(deps: ApprovalAuditDeps): {
  readonly auditApprovalOutcome: (
    ctx: TurnContext,
    resource: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    durationMs: number,
    sink: AuditSink,
    coalesced?: boolean,
    remembered?: boolean,
  ) => void;
  readonly emitApprovalStep: (
    ctx: TurnContext,
    toolId: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    startMs: number,
    coalesced?: boolean,
  ) => void;
} {
  const { clock, approvalSink } = deps;

  function auditApprovalOutcome(
    ctx: TurnContext,
    resource: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    durationMs: number,
    sink: AuditSink,
    coalesced = false,
    remembered = false,
  ): void {
    // "remembered" = fast-path replay (persistent or session grant matched).
    // "granted" / "denied" = user responded to a prompt.
    const permissionEvent = remembered
      ? "remembered"
      : approval.kind === "deny"
        ? "denied"
        : "granted";
    const meta: Record<string, unknown> = {
      permissionCheck: true,
      permissionEvent,
      phase: "approval_outcome",
      resource,
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
      ...(coalesced ? { coalesced: true } : {}),
    };
    if (approval.kind === "deny") {
      meta.denyReason = approval.reason;
    }
    if (approval.kind === "modify") {
      // Log key names only — raw inputs may contain secrets or sensitive data.
      // Full payload capture requires a dedicated secure-audit mode.
      meta.originalInputKeys = Object.keys(originalInput).sort();
      meta.modifiedInputKeys = Object.keys(approval.updatedInput).sort();
      meta.inputModified = true;
    }
    if (approval.kind === "always-allow") {
      meta.scope = approval.scope;
    }
    const entry: AuditEntry = {
      schema_version: 2,
      timestamp: clock(),
      sessionId: ctx.session.sessionId as string,
      agentId: ctx.session.agentId,
      turnIndex: ctx.turnIndex,
      kind: "permission_decision",
      durationMs,
      metadata: meta as JsonObject,
    };
    void sink.log(entry).catch((e: unknown) => {
      swallowError(e, { package: PKG, operation: "audit-approval" });
    });
  }

  function emitApprovalStep(
    ctx: TurnContext,
    toolId: string,
    approval: ValidatedApproval,
    originalInput: JsonObject,
    startMs: number,
    coalesced = false,
  ): void {
    const meta: Record<string, unknown> = {
      approvalDecision: approval.kind,
      userId: ctx.session.userId ?? "__anonymous__",
      // Per-stream identifier so a runtime fan-out relay can route this
      // step back to the originating stream's trajectory rather than
      // broadcasting to every concurrent stream that happens to share
      // a `RuntimeConfig.sessionId`. `runId` is allocated per stream
      // even under stable-sessionId mode.
      runId: ctx.session.runId as string,
      ...(coalesced ? { coalesced: true } : {}),
    };
    if (approval.kind === "modify") {
      meta.inputModified = true;
      meta.originalInputKeys = Object.keys(originalInput).sort();
      meta.modifiedInputKeys = Object.keys(approval.updatedInput).sort();
    }
    if (approval.kind === "deny") {
      meta.denyReason = approval.reason;
    }
    if (approval.kind === "always-allow") {
      meta.scope = approval.scope;
    }
    const step: RichTrajectoryStep = {
      stepIndex: -1,
      timestamp: startMs,
      source: "user",
      kind: "tool_call",
      identifier: toolId,
      outcome: approval.kind === "deny" ? "failure" : "success",
      durationMs: clock() - startMs,
      metadata: meta as JsonObject,
    };
    try {
      approvalSink(ctx.session.sessionId as string, step);
    } catch (e: unknown) {
      swallowError(e, { package: PKG, operation: "approval-step" });
    }
  }

  return { auditApprovalOutcome, emitApprovalStep };
}
