/**
 * PermissionBackend — pluggable authorization contract (L0).
 *
 * Supports sync (in-memory pattern matching) and async (OPA, OpenFGA, Cedar,
 * HTTP ReBAC) backends behind the same interface.
 */

import type { JsonObject } from "./common.js";

export interface PermissionQuery {
  readonly principal: string;
  readonly action: string;
  readonly resource: string;
  readonly context?: JsonObject;
}

export type PermissionDecision =
  | { readonly effect: "allow" }
  | { readonly effect: "deny"; readonly reason: string }
  | { readonly effect: "ask"; readonly reason: string };

export interface PermissionBackend {
  readonly check: (query: PermissionQuery) => PermissionDecision | Promise<PermissionDecision>;
  readonly checkBatch?: (
    queries: readonly PermissionQuery[],
  ) => readonly PermissionDecision[] | Promise<readonly PermissionDecision[]>;
  readonly dispose?: () => void | Promise<void>;
}
