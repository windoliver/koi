/**
 * Approval bridge for ACP session/request_permission (decision 1A).
 *
 * Maps ACP permission requests to Koi's ApprovalHandler interface,
 * mirroring the pattern from @koi/engine-claude/approval-bridge.
 *
 * Fail-closed: if the handler throws, the permission is cancelled.
 */

import type { PermissionOption, SessionRequestPermissionParams } from "@koi/acp-protocol";
import type { ApprovalDecision, ApprovalHandler } from "@koi/core";

// ---------------------------------------------------------------------------
// Permission resolution
// ---------------------------------------------------------------------------

/** Find the first "allow" option in the agent's provided options list. */
function findAllowOption(options: readonly PermissionOption[] | undefined): string | undefined {
  if (options === undefined || options.length === 0) return undefined;
  for (const opt of options) {
    if (opt.kind === "allow_once" || opt.kind === "allow_always") {
      return opt.optionId;
    }
  }
  return undefined;
}

/** Find the first "reject" option in the agent's provided options list. */
function findRejectOption(options: readonly PermissionOption[] | undefined): string | undefined {
  if (options === undefined || options.length === 0) return undefined;
  for (const opt of options) {
    if (opt.kind === "reject_once" || opt.kind === "reject_always") {
      return opt.optionId;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

/**
 * Result of the approval bridge — an ACP-shaped outcome to send back to agent.
 */
export type ApprovalBridgeResult =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/**
 * Resolve an ACP session/request_permission to an ApprovalBridgeResult.
 *
 * If no approval handler is configured, defaults to allowing (headless mode).
 * Fail-closed: handler errors → cancelled outcome.
 */
export async function resolvePermission(
  params: SessionRequestPermissionParams,
  handler: ApprovalHandler | undefined,
): Promise<ApprovalBridgeResult> {
  if (handler === undefined) {
    // Headless default: allow if there's an allow option, otherwise cancel
    const allowOptId = findAllowOption(params.options);
    if (allowOptId !== undefined) {
      return { outcome: "selected", optionId: allowOptId };
    }
    return { outcome: "cancelled" };
  }

  const request = {
    toolId: params.toolCall.toolCallId,
    input: (params.toolCall.rawInput ?? {}) as Record<string, unknown>,
    reason: params.toolCall.title,
  };

  let decision: ApprovalDecision;
  try {
    decision = await handler(request);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[engine-acp] Approval handler error for "${params.toolCall.title}": ${msg}`);
    return { outcome: "cancelled" };
  }

  switch (decision.kind) {
    case "allow": {
      const optionId = findAllowOption(params.options);
      if (optionId !== undefined) {
        return { outcome: "selected", optionId };
      }
      // No allow option available — default to cancelled
      return { outcome: "cancelled" };
    }

    case "deny": {
      const optionId = findRejectOption(params.options);
      if (optionId !== undefined) {
        return { outcome: "selected", optionId };
      }
      return { outcome: "cancelled" };
    }

    case "modify": {
      // ACP doesn't support input modification — treat as allow
      const optionId = findAllowOption(params.options);
      if (optionId !== undefined) {
        return { outcome: "selected", optionId };
      }
      return { outcome: "cancelled" };
    }

    default: {
      const _exhaustive: never = decision;
      console.warn("[engine-acp] Unknown approval decision kind:", _exhaustive);
      return { outcome: "cancelled" };
    }
  }
}
