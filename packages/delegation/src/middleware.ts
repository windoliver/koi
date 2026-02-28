/**
 * Delegation middleware — KoiMiddleware implementation that verifies
 * delegation grants on every tool call.
 *
 * If a tool call includes a delegation context (via ctx.metadata.delegationId),
 * the middleware verifies the grant. If verification fails, the tool call
 * is blocked and a PERMISSION error is returned.
 *
 * Tool calls without delegation context pass through (agent using own perms).
 */

import type {
  DelegationGrant,
  DelegationId,
  KoiMiddleware,
  RevocationRegistry,
  ScopeChecker,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { delegationId } from "@koi/core";
import { verifyGrant } from "./verify.js";

export interface DelegationMiddlewareConfig {
  readonly secret: string;
  readonly registry: RevocationRegistry;
  readonly grantStore: ReadonlyMap<DelegationId, DelegationGrant>;
  /** Optional pluggable scope checker. Defaults to built-in glob matcher. */
  readonly scopeChecker?: ScopeChecker;
}

/**
 * Creates a KoiMiddleware that verifies delegation grants on tool calls.
 *
 * On every wrapToolCall:
 * 1. Extracts delegationId from ctx.metadata
 * 2. If absent → passes through (agent using own permissions)
 * 3. Looks up grant in grantStore
 * 4. Runs full verifyGrant()
 * 5. On deny → returns ToolResponse with PERMISSION error
 * 6. On success → calls next(request)
 */
export function createDelegationMiddleware(config: DelegationMiddlewareConfig): KoiMiddleware {
  return {
    name: "koi:delegation",
    describeCapabilities: () => undefined,
    wrapToolCall: async (ctx, request, next) => {
      const rawDelegationId = ctx.metadata.delegationId;

      // No delegation context → pass through (own permissions)
      if (typeof rawDelegationId !== "string") {
        return next(request);
      }

      const grantId = delegationId(rawDelegationId);

      // Look up grant
      const grant = config.grantStore.get(grantId);
      if (grant === undefined) {
        return makeDeniedResponse(request, "unknown_grant", rawDelegationId);
      }

      // Full verification (with optional pluggable scope checker)
      const result = await verifyGrant(
        grant,
        request.toolId,
        config.registry,
        config.secret,
        undefined,
        config.scopeChecker,
      );

      if (!result.ok) {
        return makeDeniedResponse(request, result.reason, rawDelegationId);
      }

      return next(request);
    },
  };
}

function makeDeniedResponse(
  request: ToolRequest,
  reason: string,
  delegationId: string,
): ToolResponse {
  return {
    output: null,
    metadata: {
      error: {
        code: "PERMISSION",
        message: `Delegation denied: ${reason} (delegationId=${delegationId}, tool=${request.toolId})`,
        retryable: false,
        reason,
      },
    },
  };
}
