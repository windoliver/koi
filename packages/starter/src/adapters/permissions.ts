/**
 * Manifest adapter for @koi/middleware-permissions.
 *
 * Reads manifest.middleware[].options (JSON-serializable values only) and
 * instantiates createPermissionsMiddleware. The PermissionEngine and optional
 * ApprovalHandler cannot be expressed in JSON, so they are supplied via
 * PermissionsCallbacks. The engine defaults to createPatternPermissionEngine().
 *
 * Rules normalization: allow/deny/ask default to [] if omitted so users can
 * write minimal manifests (e.g. `rules: { allow: ["*"] }`) without listing
 * empty arrays for deny and ask.
 */

import type { JsonObject, KoiMiddleware, MiddlewareConfig } from "@koi/core";
import type { ApprovalHandler, PermissionEngine } from "@koi/middleware-permissions";
import {
  createPatternPermissionEngine,
  createPermissionsMiddleware,
  validatePermissionsConfig,
} from "@koi/middleware-permissions";
import type { RuntimeOpts } from "../registry.js";

/**
 * Runtime callbacks for @koi/middleware-permissions — provided via
 * createDefaultRegistry(callbacks) since they are JS objects that cannot
 * be expressed in JSON manifests.
 */
export interface PermissionsCallbacks {
  /** Permission decision engine. Defaults to createPatternPermissionEngine(). */
  readonly engine?: PermissionEngine;
  /** HITL approval handler. Required if any 'ask' rules are defined. */
  readonly approvalHandler?: ApprovalHandler;
}

/**
 * Instantiates @koi/middleware-permissions from a manifest MiddlewareConfig.
 * Throws on invalid options so misconfigured manifests fail fast at setup time.
 */
export function createPermissionsAdapter(
  config: MiddlewareConfig,
  _opts?: RuntimeOpts,
  callbacks?: PermissionsCallbacks,
): KoiMiddleware {
  const options = config.options ?? {};

  // Normalize rules so users can omit empty deny/ask in manifest YAML.
  // Validator requires all three arrays; we default missing ones to [].
  function isJsonObject(v: unknown): v is JsonObject {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  }

  const rawRules: unknown = options.rules;
  const rulesObj: JsonObject | null = isJsonObject(rawRules) ? rawRules : null;

  const normalizedRules = {
    allow: rulesObj !== null && Array.isArray(rulesObj.allow) ? rulesObj.allow : [],
    deny: rulesObj !== null && Array.isArray(rulesObj.deny) ? rulesObj.deny : [],
    ask: rulesObj !== null && Array.isArray(rulesObj.ask) ? rulesObj.ask : [],
  };

  const rawConfig: unknown = {
    ...options,
    rules: normalizedRules,
    // Engine defaults to pattern engine; callers can override via callbacks.
    engine: callbacks?.engine ?? createPatternPermissionEngine(),
    ...(callbacks?.approvalHandler !== undefined
      ? { approvalHandler: callbacks.approvalHandler }
      : {}),
  };

  const result = validatePermissionsConfig(rawConfig);
  if (!result.ok) {
    throw new Error(`[starter] permissions: invalid manifest options: ${result.error.message}`, {
      cause: result.error,
    });
  }

  return createPermissionsMiddleware(result.value);
}
