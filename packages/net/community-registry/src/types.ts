/**
 * Configuration types for the community registry HTTP server.
 */

import type { BrickArtifact, BrickRegistryBackend } from "@koi/core";

// ---------------------------------------------------------------------------
// Security gate — optional publish-time scan
// ---------------------------------------------------------------------------

export interface SecurityGateResult {
  readonly passed: boolean;
  readonly score: number;
  readonly findings?: readonly string[];
}

export interface SecurityGate {
  readonly check: (brick: BrickArtifact) => Promise<SecurityGateResult>;
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface CommunityRegistryConfig {
  readonly registry: BrickRegistryBackend;
  /** Valid publish tokens. If empty/undefined, all publish requests are rejected. */
  readonly authTokens?: ReadonlySet<string>;
  /** Optional security gate invoked before publishing. */
  readonly securityGate?: SecurityGate;
}

// ---------------------------------------------------------------------------
// Batch-check types
// ---------------------------------------------------------------------------

export interface BatchCheckRequest {
  readonly hashes: readonly string[];
}

export interface BatchCheckEntry {
  readonly hash: string;
  readonly available: boolean;
}

export interface BatchCheckResponse {
  readonly updates: readonly BatchCheckEntry[];
}
