/**
 * resolveManifestMiddleware — instantiates middleware declared in a manifest.
 *
 * Skips unknown names (no registry entry) silently. Callers are responsible
 * for validating that all required middleware are present before createKoi().
 *
 * Async because some middleware factories (e.g. createSoulMiddleware) are async.
 */

import type { AgentManifest, KoiMiddleware } from "@koi/core";
import type { MiddlewareRegistry, RuntimeOpts } from "./registry.js";

/**
 * Instantiate all middleware declared in manifest.middleware[] using the registry.
 * Unknown middleware names are silently skipped; instantiation order matches manifest order.
 *
 * Pass the result to `createKoi({ middleware: resolvedMiddleware })`.
 */
export async function resolveManifestMiddleware(
  manifest: AgentManifest,
  registry: MiddlewareRegistry,
  opts?: RuntimeOpts,
): Promise<readonly KoiMiddleware[]> {
  if (!manifest.middleware?.length) return [];

  const result: KoiMiddleware[] = [];
  for (const mwConfig of manifest.middleware) {
    const factory = registry.get(mwConfig.name);
    if (factory !== undefined) {
      result.push(await factory(mwConfig, opts));
    }
  }
  return result;
}
