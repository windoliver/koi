/**
 * Permission backend factory — assembles rule evaluator + mode resolver
 * into a concrete PermissionBackend implementation.
 */

import type { PermissionBackend, PermissionDecision, PermissionQuery } from "@koi/core";

import { resolveMode } from "./mode-resolver.js";
import type { PermissionConfig } from "./rule-types.js";

/**
 * Create a stateless `PermissionBackend` from a permission config.
 *
 * The returned backend evaluates queries against pre-loaded rules
 * using the configured permission mode.
 */
export function createPermissionBackend(config: PermissionConfig): PermissionBackend {
  const { mode, rules } = config;

  function check(query: PermissionQuery): PermissionDecision {
    return resolveMode(mode, query, rules);
  }

  function checkBatch(queries: readonly PermissionQuery[]): readonly PermissionDecision[] {
    return queries.map(check);
  }

  function dispose(): void {
    // Stateless — nothing to clean up.
  }

  return { check, checkBatch, dispose };
}
