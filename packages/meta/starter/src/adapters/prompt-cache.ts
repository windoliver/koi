/**
 * Manifest adapter for @koi/middleware-prompt-cache.
 *
 * Reads manifest.middleware[].options and instantiates createPromptCacheMiddleware.
 * All options are JSON-serializable.
 */

import type { KoiMiddleware, MiddlewareConfig } from "@koi/core";
import { createPromptCacheMiddleware, type PromptCacheConfig } from "@koi/middleware-prompt-cache";

export function createPromptCacheAdapter(config: MiddlewareConfig): KoiMiddleware {
  const options = (config.options ?? {}) as Partial<PromptCacheConfig>;
  return createPromptCacheMiddleware(options);
}
