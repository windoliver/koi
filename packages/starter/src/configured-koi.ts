/**
 * createConfiguredKoi — manifest-driven convenience wrapper around createKoi.
 *
 * Closes both limitations of the base resolveManifestMiddleware API:
 *  1. agentDepth is auto-computed from parentPid (0 for root, parent.depth+1 for children).
 *  2. Typed callbacks (onAnomaly, onMetrics, etc.) are wired via BuiltinCallbacks —
 *     no need to touch createAgentMonitorMiddleware directly.
 *
 * Manually-provided middleware (options.middleware) is appended after manifest
 * middleware, so manifest entries run first (outermost in the chain).
 */

import type { CreateKoiOptions, KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import type { BuiltinCallbacks } from "./builtin-registry.js";
import { createDefaultRegistry } from "./builtin-registry.js";
import type { MiddlewareRegistry } from "./registry.js";
import { resolveManifestMiddleware } from "./resolve.js";

export interface ConfiguredKoiOptions extends CreateKoiOptions {
  /**
   * Middleware registry used for manifest middleware resolution.
   * Defaults to createDefaultRegistry(callbacks) when not provided.
   * Named `middlewareRegistry` to avoid conflict with CreateKoiOptions.registry (AgentRegistry).
   */
  readonly middlewareRegistry?: MiddlewareRegistry;
  /**
   * Typed JS callbacks for built-in middleware (onAnomaly, onMetrics, etc.).
   * Only used when middlewareRegistry is omitted — ignored if a custom registry is provided.
   */
  readonly callbacks?: BuiltinCallbacks;
}

/**
 * Assemble and start an agent with manifest-driven middleware auto-wiring.
 *
 * Equivalent to:
 *   const registry = createDefaultRegistry(callbacks);
 *   const resolved = resolveManifestMiddleware(manifest, registry, { agentDepth });
 *   return createKoi({ ...options, middleware: [...resolved, ...options.middleware] });
 *
 * where agentDepth is computed automatically from parentPid.
 */
export async function createConfiguredKoi(options: ConfiguredKoiOptions): Promise<KoiRuntime> {
  const { middlewareRegistry, callbacks, ...koiOptions } = options;

  // Auto-compute depth: root = 0, child = parent.depth + 1
  const agentDepth = options.parentPid !== undefined ? options.parentPid.depth + 1 : 0;

  const effectiveRegistry = middlewareRegistry ?? createDefaultRegistry(callbacks);
  const manifestMiddleware = await resolveManifestMiddleware(options.manifest, effectiveRegistry, {
    agentDepth,
  });

  return createKoi({
    ...koiOptions,
    // Manifest middleware runs first (outermost); manually-provided middleware appended.
    middleware: [...manifestMiddleware, ...(options.middleware ?? [])],
  });
}
