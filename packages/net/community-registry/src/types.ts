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
// Integrity verification hooks — mandatory publish-time checks
// ---------------------------------------------------------------------------

/** Result of content-hash integrity verification. */
export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly kind: string;
}

/** Verifies that a brick's content hash matches its ID. */
export type IntegrityVerifier = (brick: BrickArtifact) => IntegrityCheckResult;

/** Verifies a brick's attestation signature. Returns true if valid. */
export type AttestationVerifier = (brick: BrickArtifact) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface CommunityRegistryConfig {
  readonly registry: BrickRegistryBackend;
  /** Valid publish tokens. If empty/undefined, all publish requests are rejected. */
  readonly authTokens?: ReadonlySet<string>;
  /** Optional security gate invoked before publishing (skill-scanner + NL injection scan). */
  readonly securityGate?: SecurityGate;
  /** Optional content integrity verifier — checks that brick ID matches content hash. */
  readonly verifyIntegrity?: IntegrityVerifier;
  /** Optional attestation verifier — checks cryptographic signature on provenance. */
  readonly verifyAttestation?: AttestationVerifier;
}

// ---------------------------------------------------------------------------
// Batch-check types
// ---------------------------------------------------------------------------

export interface BatchCheckRequest {
  readonly hashes: readonly string[];
}

/** Response matching the client's BatchCheckResult type. */
export interface BatchCheckResponse {
  readonly existing: readonly string[];
  readonly missing: readonly string[];
}
