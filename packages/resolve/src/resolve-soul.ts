/**
 * Soul/user section resolver.
 *
 * Resolves soul/user manifest sections into a KoiMiddleware via the
 * "@koi/soul" descriptor in the registry.
 */

import type { KoiError, KoiMiddleware, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import { resolveOne } from "./resolve-one.js";
import type { ResolutionContext, ResolveRegistry } from "./types.js";

/** The manifest sections relevant to soul resolution. */
interface SoulManifestSlice {
  readonly soul?: unknown;
  readonly user?: unknown;
}

/**
 * Resolves soul/user configuration into a middleware instance.
 *
 * - If neither soul nor user is present: returns undefined (no middleware needed)
 * - Constructs options from manifest soul/user sections
 * - Looks up "@koi/soul" in the registry
 * - Factory receives options + context (context.manifestDir used as basePath)
 */
export async function resolveSoul(
  manifest: SoulManifestSlice,
  registry: ResolveRegistry,
  context: ResolutionContext,
): Promise<Result<KoiMiddleware | undefined, KoiError>> {
  // No soul/user config → nothing to resolve
  if (manifest.soul === undefined && manifest.user === undefined) {
    return { ok: true, value: undefined };
  }

  // Check if soul descriptor is registered
  if (!registry.has("middleware", "@koi/soul")) {
    return {
      ok: false,
      error: {
        code: "NOT_FOUND",
        message:
          'Manifest defines soul/user configuration but "@koi/soul" is not registered. ' +
          "Ensure the soul middleware descriptor is included in the registry.",
        retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
      },
    };
  }

  // Construct options — the factory will inject basePath from context
  const options: Record<string, unknown> = {
    ...(manifest.soul !== undefined ? { soul: manifest.soul } : {}),
    ...(manifest.user !== undefined ? { user: manifest.user } : {}),
  };

  return resolveOne<KoiMiddleware>("middleware", { name: "@koi/soul", options }, registry, context);
}
