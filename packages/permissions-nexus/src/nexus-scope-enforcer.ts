/**
 * Nexus scope enforcer — adapter from ScopeAccessRequest to PermissionQuery.
 *
 * Delegates to a PermissionBackend (typically the NexusPermissionBackend)
 * and composes with createEnforcedFileSystem() from @koi/scope.
 */

import type { PermissionBackend, ScopeAccessRequest, ScopeEnforcer } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NexusScopeEnforcerConfig {
  /** The PermissionBackend to delegate to. */
  readonly backend: PermissionBackend;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNexusScopeEnforcer(config: NexusScopeEnforcerConfig): ScopeEnforcer {
  const checkAccess = async (request: ScopeAccessRequest): Promise<boolean> => {
    const query = {
      principal: (request.context?.agentId as string | undefined) ?? "anonymous",
      action: request.operation,
      resource: request.resource,
    };

    const decision = await config.backend.check(query);
    return decision.effect === "allow";
  };

  const backendDispose = config.backend.dispose;

  return {
    checkAccess,
    ...(backendDispose !== undefined ? { dispose: backendDispose } : {}),
  };
}
