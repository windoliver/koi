/**
 * Provenance types — SLSA-inspired attestation metadata for forged bricks.
 *
 * Every forged brick gets a structured record of how it was created,
 * what pipeline verified it, and what data classifications apply.
 * Koi-native vocabulary; SLSA serialization lives in L2 (@koi/forge).
 */

import type { BrickSource } from "./brick-snapshot.js";

// ---------------------------------------------------------------------------
// Data classification
// ---------------------------------------------------------------------------

/** Sensitivity level for brick content. */
export type DataClassification = "public" | "internal" | "secret";

/** Content markers for specific data categories. */
export type ContentMarker = "credentials" | "pii" | "phi" | "payment";

// ---------------------------------------------------------------------------
// Signing backend contract
// ---------------------------------------------------------------------------

/** Pluggable signing backend — HMAC-SHA256 default, Ed25519/KMS possible. */
export interface SigningBackend {
  readonly algorithm: string;
  readonly sign: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
  readonly verify: (data: Uint8Array, signature: Uint8Array) => boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Build definition (what inputs + config produced this brick)
// ---------------------------------------------------------------------------

export interface ForgeBuildDefinition {
  readonly buildType: string;
  readonly externalParameters: Readonly<Record<string, unknown>>;
  readonly internalParameters?: Readonly<Record<string, unknown>>;
  readonly resolvedDependencies?: readonly ForgeResourceRef[];
}

// ---------------------------------------------------------------------------
// Resource reference (dependency/byproduct pointer)
// ---------------------------------------------------------------------------

export interface ForgeResourceRef {
  readonly uri: string;
  readonly digest?: Readonly<Record<string, string>>;
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Builder identity (who ran the forge pipeline)
// ---------------------------------------------------------------------------

export interface ForgeBuilder {
  readonly id: string;
  readonly version?: string;
  readonly nodeId?: string;
}

// ---------------------------------------------------------------------------
// Run metadata (when + how long)
// ---------------------------------------------------------------------------

export interface ForgeRunMetadata {
  readonly invocationId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly sessionId: string;
  readonly agentId: string;
  readonly depth: number;
}

// ---------------------------------------------------------------------------
// Verification summary (compact digest of 4-stage pipeline)
// ---------------------------------------------------------------------------

export interface ForgeVerificationSummary {
  readonly passed: boolean;
  readonly sandbox: boolean;
  readonly totalDurationMs: number;
  readonly stageResults: readonly ForgeStageDigest[];
}

export interface ForgeStageDigest {
  readonly stage: string;
  readonly passed: boolean;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// Attestation signature
// ---------------------------------------------------------------------------

export interface ForgeAttestationSignature {
  readonly algorithm: string;
  readonly signature: string;
  readonly keyId?: string;
}

// ---------------------------------------------------------------------------
// ForgeProvenance (top-level — replaces createdBy/createdAt)
// ---------------------------------------------------------------------------

export interface ForgeProvenance {
  readonly source: BrickSource;
  readonly buildDefinition: ForgeBuildDefinition;
  readonly builder: ForgeBuilder;
  readonly metadata: ForgeRunMetadata;
  readonly verification: ForgeVerificationSummary;
  readonly classification: DataClassification;
  readonly contentMarkers: readonly ContentMarker[];
  readonly contentHash: string;
  readonly attestation?: ForgeAttestationSignature;
}

// ---------------------------------------------------------------------------
// In-toto Statement v1 envelope
// ---------------------------------------------------------------------------

/** Subject of an in-toto Statement — identifies the artifact by name + digest. */
export interface InTotoSubject {
  readonly name: string;
  readonly digest: Readonly<Record<string, string>>;
}

/** In-toto Statement v1 envelope wrapping a typed predicate. */
export interface InTotoStatementV1<T> {
  readonly _type: "https://in-toto.io/Statement/v1";
  readonly subject: readonly InTotoSubject[];
  readonly predicateType: string;
  readonly predicate: T;
}
