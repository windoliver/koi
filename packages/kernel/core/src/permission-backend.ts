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
  | {
      readonly effect: "deny";
      readonly reason: string;
      /**
       * How the middleware should handle this deny.
       * - `"hard"` (default when omitted): terminate the tool call with a
       *   `KoiRuntimeError({ code: "PERMISSION" })`. This is the pre-#1650
       *   behavior and remains the fail-safe default for any backend that
       *   does not explicitly opt into soft-deny.
       * - `"soft"`: the middleware returns a synthetic `ToolResponse` so the
       *   agent loop can continue. The model reads the error message and
       *   adapts. Subject to a per-turn retry cap to bound runaway loops.
       *
       * Backends that don't know about this feature omit the field — the
       * middleware defaults to `"hard"`.
       */
      readonly disposition?: "hard" | "soft";
    }
  | { readonly effect: "ask"; readonly reason: string };

export interface PermissionBackend {
  readonly check: (query: PermissionQuery) => PermissionDecision | Promise<PermissionDecision>;
  readonly checkBatch?: (
    queries: readonly PermissionQuery[],
  ) => readonly PermissionDecision[] | Promise<readonly PermissionDecision[]>;
  readonly dispose?: () => void | Promise<void>;
}
