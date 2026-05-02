/**
 * Capability declarations and backend lifecycle types for SandboxAdapter selection.
 *
 * Used by the sandbox router (`@koi/sandbox-router`) to filter and rank
 * adapters when fulfilling a `SandboxProfile.required` requirement set.
 */

/** Discrete capability flags an adapter may support. */
export type AdapterCapability =
  | "exec"
  | "copy-files"
  | "spawn"
  | "persistence"
  | "network"
  | "filesystem-rw"
  | "gpu";

/**
 * Static capability declaration on a SandboxAdapter.
 *
 * `priority` is the selection tiebreaker — lower values are preferred when two
 * adapters both satisfy a profile's requirements. Suggested ranges:
 *   0-9   local in-process / OS subprocess
 *   10-19 containerized (Docker)
 *   20-29 remote (SSH)
 *   30-39 cloud-hosted ephemeral sandbox
 */
export interface AdapterCapabilities {
  readonly supports: ReadonlySet<AdapterCapability>;
  readonly priority: number;
}

/**
 * Backend-level lifecycle state. Distinct from instance-level
 * `SandboxInstanceState` (which is `active | detached | destroyed`).
 *
 *   created    — constructed but `init()` has not been awaited yet
 *   ready      — operating normally; eligible for selection
 *   degraded   — recent consecutive failures; selectable but lower priority
 *                than ready peers; reverts to `ready` on next success
 *   terminated — `shutdown()` returned, OR `init()` failed permanently
 */
export type BackendState = "created" | "ready" | "degraded" | "terminated";

/** Read-only summary an adapter exposes to the router and to callers. */
export interface BackendDescriptor {
  readonly name: string;
  /** Semver of the adapter package. Used in selection-decision audit metadata. */
  readonly version: string;
  readonly state: BackendState;
  readonly capabilities: AdapterCapabilities;
}

/** Capability requirements declared on a `SandboxProfile`. */
export interface CapabilityRequirements {
  readonly required: ReadonlySet<AdapterCapability>;
  /** Optional: capabilities that disqualify an adapter even if all required are met. */
  readonly forbidden?: ReadonlySet<AdapterCapability>;
}
