/**
 * Permissions section resolver.
 *
 * Resolves manifest permissions config into a KoiMiddleware via the
 * "@koi/middleware-permissions" descriptor in the registry.
 */

import type { KoiError, KoiMiddleware, PermissionConfig, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolveRegistry } from "./types.js";

/**
 * Checks if a PermissionConfig has any rules defined.
 */
function hasRules(config: PermissionConfig | undefined): boolean {
  if (config === undefined) return false;
  const allowLen = config.allow?.length ?? 0;
  const denyLen = config.deny?.length ?? 0;
  const askLen = config.ask?.length ?? 0;
  return allowLen + denyLen + askLen > 0;
}

/**
 * Resolves permissions configuration into a middleware instance.
 *
 * - If no permissions defined: returns undefined
 * - If ask rules exist but no approvalHandler in context: VALIDATION error
 * - Constructs options from manifest permissions section
 * - Looks up "@koi/middleware-permissions" in the registry
 */
export async function resolvePermissions(
  permissions: PermissionConfig | undefined,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<KoiMiddleware | undefined, KoiError>> {
  if (permissions === undefined || !hasRules(permissions)) {
    return { ok: true, value: undefined };
  }

  // TypeScript narrows permissions to PermissionConfig after the undefined check above

  // Validate ask rules require an approvalHandler
  if ((permissions.ask?.length ?? 0) > 0 && context.approvalHandler === undefined) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "Manifest defines permissions.ask rules but no approvalHandler is available in the resolution context. " +
          "An approvalHandler is required for human-in-the-loop tool approval.",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Check if permissions descriptor is registered
  if (!registry.has("middleware", "@koi/middleware-permissions")) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message:
          'Manifest defines permissions but "@koi/middleware-permissions" is not registered. ' +
          "Ensure the permissions middleware descriptor is included in the registry.",
        retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      },
    };
  }

  // Construct options from manifest permissions section
  const options: Record<string, unknown> = {
    allow: permissions.allow ?? [],
    deny: permissions.deny ?? [],
    ask: permissions.ask ?? [],
  };

  return resolveOne<KoiMiddleware>(
    "middleware",
    { name: "@koi/middleware-permissions", options },
    registry,
    context,
  );
}
