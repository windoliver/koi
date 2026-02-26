/**
 * createDefaultRegistry — built-in middleware registry for @koi/starter.
 *
 * Accepts optional BuiltinCallbacks so callers can supply JS callbacks and
 * runtime objects (onAnomaly, engine, approvalHandler, etc.) that cannot be
 * expressed in JSON manifests. The callbacks are baked into the factory
 * closures — callers never need to touch the middleware factories directly.
 *
 * Registered names:
 *  - "agent-monitor" (also "monitor" alias) — @koi/agent-monitor
 *  - "soul"                                 — @koi/middleware-soul
 *  - "permissions"                          — @koi/middleware-permissions
 */

import type { AgentMonitorCallbacks } from "./adapters/agent-monitor.js";
import { createAgentMonitorAdapter } from "./adapters/agent-monitor.js";
import type { PermissionsCallbacks } from "./adapters/permissions.js";
import { createPermissionsAdapter } from "./adapters/permissions.js";
import { createSoulAdapter } from "./adapters/soul.js";
import type { MiddlewareFactory } from "./registry.js";
import { createMiddlewareRegistry, type MiddlewareRegistry } from "./registry.js";

/**
 * Typed callbacks for all built-in middleware, keyed by middleware name.
 * Pass to createDefaultRegistry() to wire callbacks from code while keeping
 * all structural configuration (thresholds, tool lists, rules) in the manifest.
 */
export interface BuiltinCallbacks {
  readonly "agent-monitor"?: AgentMonitorCallbacks;
  /** Alias for "agent-monitor" — matches the doctor rule's short name. */
  readonly monitor?: AgentMonitorCallbacks;
  /** Runtime callbacks for @koi/middleware-permissions (engine, approvalHandler). */
  readonly permissions?: PermissionsCallbacks;
}

export function createDefaultRegistry(callbacks?: BuiltinCallbacks): MiddlewareRegistry {
  // Both "agent-monitor" and "monitor" use the same callbacks (alias).
  const agentMonitorCbs = callbacks?.["agent-monitor"] ?? callbacks?.monitor;

  // Bake callbacks into factory closures so MiddlewareFactory signature stays generic.
  const agentMonitorFactory: MiddlewareFactory = (config, opts) =>
    createAgentMonitorAdapter(config, opts, agentMonitorCbs);

  const permissionsCbs = callbacks?.permissions;
  const permissionsFactory: MiddlewareFactory = (config, opts) =>
    createPermissionsAdapter(config, opts, permissionsCbs);

  const entries = new Map<string, MiddlewareFactory>([
    ["agent-monitor", agentMonitorFactory],
    ["monitor", agentMonitorFactory],
    ["soul", createSoulAdapter],
    ["permissions", permissionsFactory],
  ]);

  return createMiddlewareRegistry(entries);
}
