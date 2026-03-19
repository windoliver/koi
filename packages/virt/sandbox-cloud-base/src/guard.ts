/**
 * Instance guard factory — prevents method calls after detach/destroy.
 *
 * Cloud sandbox instances are stateful remote resources. Once detached or
 * destroyed, subsequent operations must fail immediately with a clear error.
 *
 * Tri-state lifecycle: active → detached → destroyed
 *   - active: all operations allowed
 *   - detached: all operations throw (instance paused but alive)
 *   - destroyed: all operations throw (instance gone)
 */

import type { SandboxInstanceState } from "@koi/core";

export interface InstanceGuard {
  /** Throws if not active. Call at the top of every instance method. */
  readonly check: (method: string) => void;
  /** Transition active → detached. No-op if already detached or destroyed. */
  readonly markDetached: () => void;
  /** Transition to destroyed. Always succeeds (idempotent). */
  readonly markDestroyed: () => void;
  /** Whether destroy has been called. */
  readonly isDestroyed: () => boolean;
  /** Current lifecycle state. */
  readonly state: () => SandboxInstanceState;
}

/** @deprecated Use {@link InstanceGuard} instead. */
export type DestroyGuard = InstanceGuard;

/**
 * Create an instance guard for a sandbox instance.
 *
 * @param name - Adapter name (e.g., "e2b", "vercel") for error messages
 */
export function createInstanceGuard(name: string): InstanceGuard {
  // let: mutable tri-state lifecycle tracking
  let current: SandboxInstanceState = "active";

  return {
    check: (method: string): void => {
      if (current === "detached") {
        throw new Error(`${name}: cannot call ${method}() after detach()`);
      }
      if (current === "destroyed") {
        throw new Error(`${name}: cannot call ${method}() after destroy()`);
      }
    },
    markDetached: (): void => {
      if (current === "active") {
        current = "detached";
      }
    },
    markDestroyed: (): void => {
      current = "destroyed";
    },
    isDestroyed: (): boolean => current === "destroyed",
    state: (): SandboxInstanceState => current,
  };
}

/** @deprecated Use {@link createInstanceGuard} instead. */
export const createDestroyGuard: (name: string) => InstanceGuard = createInstanceGuard;
