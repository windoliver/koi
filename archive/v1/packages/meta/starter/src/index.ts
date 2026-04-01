/**
 * @koi/starter — Manifest-driven agent setup (Layer 3)
 *
 * Phase 1 (Issue #360): Bridges the gap between manifest declarations and runtime
 * instantiation. Reads manifest.middleware[] and auto-wires registered middleware
 * without requiring manual factory calls.
 *
 * Zero-friction usage (all limitations fixed):
 *
 *   // koi.yaml:
 *   //   middleware:
 *   //     - name: agent-monitor
 *   //       options:
 *   //         thresholds:
 *   //           maxToolCallsPerTurn: 15
 *   //         destructiveToolIds: ["delete"]
 *
 *   const runtime = await createConfiguredKoi({
 *     manifest,   // carries the middleware declarations above
 *     adapter,
 *     callbacks: {
 *       "agent-monitor": { onAnomaly: myHandler, onMetrics: myMetrics },
 *     },
 *     // agentDepth auto-computed from parentPid — no manual passing needed
 *   });
 *
 * Advanced usage (custom registry or mixed manual + manifest middleware):
 *
 *   const registry = createDefaultRegistry(callbacks);
 *   const resolved = resolveManifestMiddleware(manifest, registry, { agentDepth });
 *   const runtime = await createKoi({ manifest, adapter, middleware: resolved });
 */

export type { AgentMonitorCallbacks } from "./adapters/agent-monitor.js";
export {
  createLocalBackends,
  type LocalBackends,
  type LocalBackendsConfig,
} from "./adapters/local-backends.js";
export type { PermissionsCallbacks } from "./adapters/permissions.js";
export type { BuiltinCallbacks } from "./builtin-registry.js";
export { createDefaultRegistry } from "./builtin-registry.js";
export { type ConfiguredKoiOptions, createConfiguredKoi } from "./configured-koi.js";
export {
  createMiddlewareRegistry,
  type MiddlewareFactory,
  type MiddlewareRegistry,
  type RuntimeOpts,
} from "./registry.js";
export { resolveManifestMiddleware } from "./resolve.js";
export { resolveManifestScope, type ScopeBackends } from "./scope-resolver.js";
