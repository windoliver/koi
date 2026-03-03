/**
 * Supervision tree types — Erlang/OTP-style hierarchical fault recovery.
 *
 * Agents declare supervision strategies in their manifests. When a supervised
 * child terminates abnormally, the supervisor restarts it (spawns a new agent).
 * Restart intensity budgets prevent restart storms; exhausted budgets escalate
 * by terminating the supervisor itself.
 *
 * Exception: DEFAULT_SUPERVISION_CONFIG is a pure readonly data constant
 * derived from L0 type definitions, codifying architecture-doc invariants.
 */

// ---------------------------------------------------------------------------
// Supervision strategy (discriminated union)
// ---------------------------------------------------------------------------

/**
 * How the supervisor reacts when a child terminates.
 * - one_for_one: restart only the failed child
 * - one_for_all: terminate all children, then restart all in declaration order
 * - rest_for_one: terminate children declared after the failed one, restart them
 */
export type SupervisionStrategy =
  | { readonly kind: "one_for_one" }
  | { readonly kind: "one_for_all" }
  | { readonly kind: "rest_for_one" };

// ---------------------------------------------------------------------------
// Restart type (Erlang model)
// ---------------------------------------------------------------------------

/**
 * How a child should be restarted on termination.
 * - permanent: always restart, regardless of termination reason
 * - transient: restart only on abnormal termination (error, stale)
 * - temporary: never restart
 */
export type RestartType = "permanent" | "transient" | "temporary";

// ---------------------------------------------------------------------------
// Child spec — declares a child within a supervision tree
// ---------------------------------------------------------------------------

export interface ChildSpec {
  readonly name: string;
  readonly restart: RestartType;
  /** Shutdown timeout in ms before force-terminating. Default: 5000. */
  readonly shutdownTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Supervision config — full supervision tree declaration
// ---------------------------------------------------------------------------

export interface SupervisionConfig {
  readonly strategy: SupervisionStrategy;
  /** Maximum restarts within the window before escalating. Default: 5. */
  readonly maxRestarts: number;
  /** Sliding window duration in ms for restart counting. Default: 60_000. */
  readonly maxRestartWindowMs: number;
  readonly children: readonly ChildSpec[];
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_SUPERVISION_CONFIG: SupervisionConfig = {
  strategy: { kind: "one_for_one" },
  maxRestarts: 5,
  maxRestartWindowMs: 60_000,
  children: [],
};
