/**
 * Manifest adapter for @koi/soul.
 *
 * Reads manifest.middleware[].options (JSON-serializable values only) and
 * instantiates createSoulMiddleware. All soul/user/identity options are
 * JSON-serializable; no callbacks are needed.
 *
 * Required manifest option: basePath (string) — base directory for resolving
 * relative soul/user/identity file paths.
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";
import { createSoulMiddleware, validateSoulConfig } from "@koi/soul";

/**
 * Instantiates @koi/soul from a manifest MiddlewareConfig.
 * Throws on invalid options so misconfigured manifests fail fast at setup time.
 *
 * Async because createSoulMiddleware resolves content from the filesystem.
 */
export async function createSoulAdapter(config: MiddlewareConfig): Promise<KoiMiddleware> {
  const rawConfig: unknown = config.options ?? {};

  const result = validateSoulConfig(rawConfig);
  if (!result.ok) {
    throw new Error(`[starter] soul: invalid manifest options: ${result.error.message}`, {
      cause: result.error,
    });
  }

  return createSoulMiddleware(result.value);
}
