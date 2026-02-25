/**
 * SLSA v1.0 serializer — maps Koi-native ForgeProvenance to SLSA predicate.
 *
 * Koi uses its own vocabulary internally; this serializer produces
 * SLSA-compatible JSON for external consumption and audit trails.
 */

import type { ForgeProvenance } from "@koi/core";

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
