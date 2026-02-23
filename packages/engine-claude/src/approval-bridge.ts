/**
 * Approval bridge — maps Koi ApprovalHandler to SDK canUseTool callback.
 *
 * Fail-closed: if the handler throws, the tool call is denied.
 * Emits HITL custom events via an optional callback for UI signaling.
 */

import type { ApprovalHandler, ApprovalRequest } from "@koi/core";
import type { SdkCanUseTool, SdkPermissionResult } from "./types.js";
import { HITL_EVENTS } from "./types.js";

/**
 * Event emitter callback shape for HITL bridge signaling.
 */
export interface HitlEventEmitter {
  readonly emit: (event: { readonly type: string; readonly data: unknown }) => void;
}

/**
 * Create a `canUseTool` callback that bridges to a Koi ApprovalHandler.
 *
 * @param handler - Koi approval handler (async, returns ApprovalDecision)
 * @param emitter - Optional event emitter for HITL custom events
 * @returns SDK-compatible canUseTool callback
 */
export function createApprovalBridge(
  handler: ApprovalHandler,
  emitter?: HitlEventEmitter,
): SdkCanUseTool {
  return async (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
  ): Promise<SdkPermissionResult> => {
    const request: ApprovalRequest = {
      toolId: toolName,
      input,
      reason: `Tool "${toolName}" requires approval`,
    };

    // Signal: approval request sent
    emitter?.emit({
      type: HITL_EVENTS.REQUEST,
      data: {
        kind: "tool_approval",
        toolName,
        input,
      },
    });

    try {
      const decision = await handler(request);

      // Signal: approval response received
      emitter?.emit({
        type: HITL_EVENTS.RESPONSE_RECEIVED,
        data: { toolName, decision: decision.kind },
      });

      switch (decision.kind) {
        case "allow":
          return { behavior: "allow" };

        case "deny":
          return { behavior: "deny", message: decision.reason };

        case "modify":
          return {
            behavior: "allow",
            updatedInput: decision.updatedInput,
          };

        default:
          // Exhaustive guard — deny unknown decision kinds
          return { behavior: "deny", message: "Unknown approval decision" };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      // Signal: approval handler error (fail-closed)
      emitter?.emit({
        type: HITL_EVENTS.ERROR,
        data: { toolName, error: message },
      });

      return { behavior: "deny", message: `Approval handler error: ${message}` };
    }
  };
}
