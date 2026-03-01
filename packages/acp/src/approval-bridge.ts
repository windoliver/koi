/**
 * Reverse approval bridge: Koi ApprovalHandler → ACP session/request_permission.
 *
 * When Koi middleware requires tool approval, this bridge sends a
 * session/request_permission request to the IDE and waits for a response.
 * Fail-closed: on timeout or error, returns deny.
 */

import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@koi/core";
import type { RequestTracker } from "./request-tracker.js";
import { DEFAULT_TIMEOUTS } from "./types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an ApprovalHandler that delegates to the IDE via ACP.
 *
 * The handler sends `session/request_permission` to the IDE and interprets
 * the response as an ApprovalDecision.
 */
export function createApprovalHandler(
  tracker: RequestTracker,
  getSessionId: () => string | undefined,
  permissionTimeoutMs?: number,
): ApprovalHandler {
  const timeoutMs = permissionTimeoutMs ?? DEFAULT_TIMEOUTS.permissionMs;

  const handler: ApprovalHandler = async (request: ApprovalRequest): Promise<ApprovalDecision> => {
    const sessionId = getSessionId();
    if (sessionId === undefined) {
      return { kind: "deny", reason: "No active ACP session" };
    }

    const params = {
      sessionId,
      toolCall: {
        toolCallId: request.toolId,
        title: request.reason,
        kind: "other" as const,
        status: "pending" as const,
        ...(request.input !== undefined ? { rawInput: request.input } : {}),
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
      ],
    };

    try {
      const result = await tracker.sendRequest("session/request_permission", params, timeoutMs);

      // Parse IDE response
      const r = result as
        | {
            readonly outcome?: string;
            readonly optionId?: string;
          }
        | undefined;

      if (r?.outcome === "selected") {
        if (r.optionId === "allow") {
          return { kind: "allow" };
        }
        return { kind: "deny", reason: "IDE denied permission" };
      }

      // cancelled or unknown outcome → deny
      return { kind: "deny", reason: "IDE cancelled permission request" };
    } catch (error: unknown) {
      // Fail-closed: timeout or error → deny
      const msg = error instanceof Error ? error.message : String(error);
      return { kind: "deny", reason: `Permission request failed: ${msg}` };
    }
  };

  return handler;
}
