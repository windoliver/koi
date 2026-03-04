/**
 * Delegation middleware — KoiMiddleware implementation that verifies
 * delegation grants on every tool call.
 *
 * If a tool call includes a delegation context (via ctx.metadata.delegationId),
 * the middleware verifies the grant. If verification fails, the tool call
 * is blocked and a PERMISSION error is returned.
 *
 * Tool calls without delegation context pass through (agent using own perms).
 *
 * When a CapabilityVerifier is configured, grants with sessionId are routed
 * through it for Ed25519/HMAC verification + session-scoped revocation.
 * Grants without sessionId fall back to the legacy verifyGrant() path.
 */

import type {
  CapabilityVerifier,
  DelegationGrant,
  DelegationId,
  KoiMiddleware,
  RevocationRegistry,
  ScopeChecker,
  SessionId,
  ToolRequest,
  ToolResponse,
} from "@koi/core";
import { delegationId } from "@koi/core";
import { mapGrantToCapabilityToken } from "./map-grant-to-token.js";
import { verifyGrant } from "./verify.js";

export interface DelegationMiddlewareConfig {
  readonly secret: string;
  readonly registry: RevocationRegistry;
  readonly grantStore: ReadonlyMap<DelegationId, DelegationGrant>;
  /** Optional pluggable scope checker. Defaults to built-in glob matcher. */
  readonly scopeChecker?: ScopeChecker;
  /** Pluggable capability verifier for session-scoped token verification. */
  readonly verifier?: CapabilityVerifier;
  /** Active session IDs for session-scoped revocation. */
  readonly activeSessionIds?: ReadonlySet<SessionId> | (() => ReadonlySet<SessionId>);
}

/**
 * Creates a KoiMiddleware that verifies delegation grants on tool calls.
 *
 * On every wrapToolCall:
 * 1. Extracts delegationId from ctx.metadata
 * 2. If absent → passes through (agent using own permissions)
 * 3. Looks up grant in grantStore
 * 4. If verifier configured + grant has sessionId → capability verifier path
 * 5. Otherwise → legacy verifyGrant() path
 * 6. On deny → returns ToolResponse with PERMISSION error
 * 7. On success → calls next(request)
 */
export function createDelegationMiddleware(config: DelegationMiddlewareConfig): KoiMiddleware {
  return {
    name: "koi:delegation",
    describeCapabilities: (ctx) => {
      const rawDelegationId = ctx.metadata.delegationId;
      if (typeof rawDelegationId !== "string") return undefined;
      return {
        label: "delegation",
        description: `Delegation grant verification active (grant ${rawDelegationId})`,
      };
    },
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

      // Capability verifier path (when configured + grant has sessionId)
      if (config.verifier !== undefined) {
        const token = mapGrantToCapabilityToken(grant);
        if (token !== undefined) {
          const sessionIds =
            typeof config.activeSessionIds === "function"
              ? config.activeSessionIds()
              : (config.activeSessionIds ?? new Set([token.scope.sessionId]));
          const result = await config.verifier.verify(token, {
            toolId: request.toolId,
            now: Date.now(),
            activeSessionIds: sessionIds,
          });
          if (!result.ok) {
            return makeDeniedResponse(request, result.reason, rawDelegationId);
          }
          return next(request);
        }
      }

      // Legacy path (fallback: no verifier, or grant without sessionId)
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
  rawDelegationId: string,
): ToolResponse {
  return {
    output: null,
    metadata: {
      error: {
        code: "PERMISSION",
        message: `Delegation denied: ${reason} (delegationId=${rawDelegationId}, tool=${request.toolId})`,
        retryable: false,
        reason,
      },
    },
  };
}
