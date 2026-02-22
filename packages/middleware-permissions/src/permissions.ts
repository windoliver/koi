/**
 * Permissions middleware factory — tool-level access control + HITL approval.
 */

import type { KoiError } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  KoiMiddleware,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type { PermissionsMiddlewareConfig } from "./config.js";

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

export function createPermissionsMiddleware(config: PermissionsMiddlewareConfig): KoiMiddleware {
  const {
    engine,
    rules,
    approvalHandler,
    approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
    defaultDeny = true,
  } = config;

  return {
    name: "permissions",
    priority: 100,

    async wrapToolCall(
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const decision = engine.check(request.toolId, request.input, rules);

      if (decision.allowed === true) {
        return next(request);
      }

      if (decision.allowed === false) {
        const error: KoiError = {
          code: "PERMISSION",
          message: decision.reason,
          retryable: RETRYABLE_DEFAULTS.PERMISSION,
          context: { toolId: request.toolId },
        };
        throw error;
      }

      // decision.allowed === "ask"
      if (!approvalHandler) {
        const error: KoiError = {
          code: "PERMISSION",
          message: `No approval handler configured for tool "${request.toolId}"`,
          retryable: RETRYABLE_DEFAULTS.PERMISSION,
          context: { toolId: request.toolId },
        };
        throw error;
      }

      const approved = await Promise.race([
        approvalHandler.requestApproval(request.toolId, request.input, decision.reason),
        new Promise<boolean>((_, reject) => {
          setTimeout(() => {
            const timeoutError: KoiError = {
              code: "TIMEOUT",
              message: `Approval timed out after ${approvalTimeoutMs}ms for tool "${request.toolId}"`,
              retryable: RETRYABLE_DEFAULTS.TIMEOUT,
              context: { toolId: request.toolId, timeoutMs: approvalTimeoutMs },
            };
            reject(timeoutError);
          }, approvalTimeoutMs);
        }),
      ]);

      if (approved) {
        return next(request);
      }

      const error: KoiError = {
        code: "PERMISSION",
        message: `Approval denied for tool "${request.toolId}"`,
        retryable: RETRYABLE_DEFAULTS.PERMISSION,
        context: { toolId: request.toolId },
      };
      throw error;
    },
  };
}
