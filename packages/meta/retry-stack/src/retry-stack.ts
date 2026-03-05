/**
 * Main factory for the retry-stack meta-package.
 *
 * Creates and composes semantic-retry, guided-retry, and (optionally) fs-rollback
 * middleware into a coherent bundle with delegating handles.
 *
 * Middleware priority ordering:
 *   fs-rollback (350) → semantic-retry (420) → guided-retry (425)
 */

import type { KoiMiddleware } from "@koi/core";
import { createFsRollbackMiddleware } from "@koi/middleware-fs-rollback";
import { createGuidedRetryMiddleware } from "@koi/middleware-guided-retry";
import { createSemanticRetryMiddleware } from "@koi/middleware-semantic-retry";
import { resolveRetryStackConfig } from "./config-resolution.js";
import type { RetryStackBundle, RetryStackConfig } from "./types.js";

/** Creates a retry-stack bundle from the given configuration. */
export function createRetryStack(config: RetryStackConfig): RetryStackBundle {
  const resolved = resolveRetryStackConfig(config);

  // Create L2 handles
  const semanticRetryHandle = createSemanticRetryMiddleware(resolved.semanticRetry);
  const guidedRetryHandle = createGuidedRetryMiddleware(resolved.guidedRetry ?? {});
  const fsRollbackHandle =
    resolved.fsRollback !== undefined ? createFsRollbackMiddleware(resolved.fsRollback) : undefined;

  // Assemble middleware array in priority order (filter undefined)
  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    fsRollbackHandle?.middleware, // priority 350
    semanticRetryHandle.middleware, // priority 420
    guidedRetryHandle.middleware, // priority 425
  ];
  const middleware = candidates.filter((mw): mw is KoiMiddleware => mw !== undefined);

  return {
    middleware,
    semanticRetry: semanticRetryHandle,
    guidedRetry: guidedRetryHandle,
    fsRollback: fsRollbackHandle,
    config: {
      preset: resolved.preset,
      middlewareCount: middleware.length,
      fsRollbackEnabled: fsRollbackHandle !== undefined,
    },
    reset: (): void => {
      semanticRetryHandle.reset();
      guidedRetryHandle.clearConstraint();
    },
  };
}
