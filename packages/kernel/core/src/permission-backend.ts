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

  /**
   * Signals that this backend marks fall-through denies distinctly from
   * explicit denies. Required to opt into dual-key policy evaluation
   * (e.g. bash prefix enrichment) where an unmarked deny on one key
   * must NOT override an explicit allow/ask on another. Mark denies
   * via either:
   *   - the `IS_DEFAULT_DENY` symbol exported by `@koi/middleware-permissions`
   *   - a public `default: true` (or `defaultDeny: true`) field on the
   *     deny decision
   *
   * Callers that need dual-key semantics (e.g. `resolveBashCommand`-enabled
   * permissions middleware) treat backends that leave this unset as
   * legacy: construction is fail-closed by default to prevent silent
   * policy downgrades. Operators can explicitly opt into single-key
   * fallback via a caller-specific option (e.g.
   * `allowLegacyBackendBashFallback` in `@koi/middleware-permissions`),
   * in which case dual-key features (like bash prefix rules) are NOT
   * enforced — only plain-tool rules apply.
   */
  readonly supportsDefaultDenyMarker?: boolean;
}
