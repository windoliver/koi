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

import type { AgentManifest, ScopeEnforcer } from "@koi/core";
import type { CreateKoiOptions, KoiRuntime } from "@koi/engine";
import { createKoi } from "@koi/engine";
import type { LoadedManifest, ManifestScopeConfig } from "@koi/manifest";
import type { BuiltinCallbacks } from "./builtin-registry.js";
import { createDefaultRegistry } from "./builtin-registry.js";
import type { MiddlewareRegistry } from "./registry.js";
import { resolveManifestMiddleware } from "./resolve.js";
import type { ScopeBackends } from "./scope-resolver.js";
import { resolveManifestScope } from "./scope-resolver.js";

/** Narrows AgentManifest to LoadedManifest when a `scope` field is present. */
function extractScopeConfig(manifest: AgentManifest): ManifestScopeConfig | undefined {
  return "scope" in manifest ? (manifest as LoadedManifest).scope : undefined;
}

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
  /** Raw backends for manifest-driven scope auto-wiring. */
  readonly backends?: ScopeBackends;
  /** Optional pluggable enforcement backend (SQLite, Nexus ReBAC, etc.). */
  readonly enforcer?: ScopeEnforcer;
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
  const { middlewareRegistry, callbacks, backends, enforcer, ...koiOptions } = options;

  // Auto-compute depth: root = 0, child = parent.depth + 1
  const agentDepth = options.parentPid !== undefined ? options.parentPid.depth + 1 : 0;

  const effectiveRegistry = middlewareRegistry ?? createDefaultRegistry(callbacks);
  const manifestMiddleware = await resolveManifestMiddleware(options.manifest, effectiveRegistry, {
    agentDepth,
  });

  // Auto-wire scope from manifest: manifest.scope + raw backends → scoped providers
  // AgentManifest doesn't declare scope — use runtime narrowing via extractScopeConfig.
  const scopeConfig = extractScopeConfig(options.manifest);
  const scopedProviders =
    scopeConfig !== undefined && backends !== undefined
      ? resolveManifestScope(scopeConfig, backends, enforcer)
      : [];

  return createKoi({
    ...koiOptions,
    // Manifest middleware runs first (outermost); manually-provided middleware appended.
    middleware: [...manifestMiddleware, ...(options.middleware ?? [])],
    // Scoped providers run first (prepended), then user-provided providers.
    providers: [...scopedProviders, ...(options.providers ?? [])],
  });
}
