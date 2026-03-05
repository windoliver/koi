/**
 * SLSA v1.0 serializer — maps Koi-native ForgeProvenance to SLSA predicate.
 *
 * Koi uses its own vocabulary internally; this serializer produces
 * SLSA-compatible JSON for external consumption and audit trails.
 */

import type { BrickId, ForgeProvenance, InTotoStatementV1 } from "@koi/core";

// ---------------------------------------------------------------------------
// SLSA v1.0 predicate types (subset relevant to Koi)
// ---------------------------------------------------------------------------

export interface SlsaBuildDefinition {
  readonly buildType: string;
  readonly externalParameters: Readonly<Record<string, unknown>>;
  readonly internalParameters?: Readonly<Record<string, unknown>>;
  readonly resolvedDependencies?: readonly SlsaResourceDescriptor[];
}

export interface SlsaResourceDescriptor {
  readonly uri: string;
  readonly digest?: Readonly<Record<string, string>>;
  readonly name?: string;
}

export interface SlsaBuilder {
  readonly id: string;
  readonly version?: Readonly<Record<string, string>>;
}

export interface SlsaBuildMetadata {
  readonly invocationId: string;
  readonly startedOn?: string;
  readonly finishedOn?: string;
}

export interface SlsaRunDetails {
  readonly builder: SlsaBuilder;
  readonly metadata?: SlsaBuildMetadata;
}

export interface SlsaProvenanceV1 {
  readonly buildDefinition: SlsaBuildDefinition;
  readonly runDetails: SlsaRunDetails;
}

/** Koi vendor extensions appended to the SLSA predicate. */
export interface SlsaKoiExtensions {
  readonly koi_classification: string;
  readonly koi_contentMarkers: readonly string[];
  readonly koi_verification: {
    readonly passed: boolean;
    readonly sandbox: string;
    readonly totalDurationMs: number;
  };
}

/** SLSA predicate with Koi vendor extensions. */
export type SlsaProvenanceV1WithExtensions = SlsaProvenanceV1 & SlsaKoiExtensions;

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map Koi ForgeProvenance to SLSA v1.0 predicate structure.
 */
export function mapProvenanceToSlsa(provenance: ForgeProvenance): SlsaProvenanceV1 {
  const buildDefinition: SlsaBuildDefinition = {
    buildType: provenance.buildDefinition.buildType,
    externalParameters: provenance.buildDefinition.externalParameters,
    ...(provenance.buildDefinition.internalParameters !== undefined
      ? { internalParameters: provenance.buildDefinition.internalParameters }
      : {}),
    ...(provenance.buildDefinition.resolvedDependencies !== undefined
      ? {
          resolvedDependencies: provenance.buildDefinition.resolvedDependencies.map((dep) => ({
            uri: dep.uri,
            ...(dep.digest !== undefined ? { digest: dep.digest } : {}),
            ...(dep.name !== undefined ? { name: dep.name } : {}),
          })),
        }
      : {}),
  };

  const builder: SlsaBuilder = {
    id: provenance.builder.id,
    ...(provenance.builder.version !== undefined
      ? { version: { "koi.forge": provenance.builder.version } }
      : {}),
  };

  const metadata: SlsaBuildMetadata = {
    invocationId: provenance.metadata.invocationId,
    startedOn: new Date(provenance.metadata.startedAt).toISOString(),
    finishedOn: new Date(provenance.metadata.finishedAt).toISOString(),
  };

  return {
    buildDefinition,
    runDetails: {
      builder,
      metadata,
    },
  };
}

// ---------------------------------------------------------------------------
// Statement envelope — wraps predicate in in-toto Statement v1
// ---------------------------------------------------------------------------

const SLSA_PROVENANCE_V1_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

/**
 * Wrap Koi ForgeProvenance in a full in-toto Statement v1 envelope.
 *
 * The subject is the brick identified by its content-addressed BrickId.
 * Includes Koi vendor extensions (classification, content markers, verification summary).
 */
export function mapProvenanceToStatement(
  provenance: ForgeProvenance,
  brickId: BrickId,
): InTotoStatementV1<SlsaProvenanceV1WithExtensions> {
  const predicate = mapProvenanceToSlsa(provenance);

  const extensions: SlsaKoiExtensions = {
    koi_classification: provenance.classification,
    koi_contentMarkers: provenance.contentMarkers,
    koi_verification: {
      passed: provenance.verification.passed,
      sandbox: String(provenance.verification.sandbox),
      totalDurationMs: provenance.verification.totalDurationMs,
    },
  };

  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: brickId,
        digest: { sha256: brickId.replace("sha256:", "") },
      },
    ],
    predicateType: SLSA_PROVENANCE_V1_PREDICATE_TYPE,
    predicate: { ...predicate, ...extensions },
  };
}
