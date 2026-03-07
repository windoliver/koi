/**
 * Fake PermissionBackend for testing — configurable per-resource decisions.
 */

import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "@koi/core/permission-backend";

export interface FakePermissionBackendOptions {
  readonly async?: boolean;
}

export interface FakePermissionBackend extends PermissionBackend {
  readonly calls: readonly PermissionQuery[];
}

/**
 * Creates a fake PermissionBackend that returns pre-configured decisions
 * keyed by resource name. Unknown resources default to deny.
 *
 * Set `options.async` to wrap decisions in `Promise.resolve()`.
 */
export function createFakePermissionBackend(
  decisions: ReadonlyMap<string, PermissionDecision>,
  options?: FakePermissionBackendOptions,
): FakePermissionBackend {
  const calls: PermissionQuery[] = [];
  const defaultDecision: PermissionDecision = { effect: "deny", reason: "no rule" };

  const check = (query: PermissionQuery): PermissionDecision | Promise<PermissionDecision> => {
    calls.push(query);
    const decision = decisions.get(query.resource) ?? defaultDecision;
    return options?.async ? Promise.resolve(decision) : decision;
  };

  return { check, calls };
}
