/**
 * Configuration and handle types for the guided-retry middleware.
 */

import type { BacktrackConstraint, KoiMiddleware } from "@koi/core";

/** Configuration for creating a guided-retry middleware instance. */
export interface GuidedRetryConfig {
  /** Initial constraint to set at creation time (optional). */
  readonly initialConstraint?: BacktrackConstraint;
}

/** Handle returned by the factory — exposes the middleware and constraint management. */
export interface GuidedRetryHandle {
  /** The KoiMiddleware instance to register in the middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Sets a new constraint (replaces any existing one). */
  readonly setConstraint: (constraint: BacktrackConstraint) => void;
  /** Clears any active constraint. */
  readonly clearConstraint: () => void;
  /** Returns true if a constraint is currently active. */
  readonly hasConstraint: () => boolean;
}
