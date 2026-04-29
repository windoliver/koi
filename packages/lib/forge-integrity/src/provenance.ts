/**
 * Build a `ForgeProvenance` record from minimal pipeline inputs.
 *
 * Records who created the brick, when, and from what demand. Verification
 * state (`passed`, `sandbox`, stage results) is REQUIRED from the caller —
 * this helper never manufactures optimistic verification metadata. A draft
 * or unsandboxed artifact must be reflected truthfully in its provenance so
 * downstream policy/trust code is not misled.
 */

import type {
  BrickId,
  ContentMarker,
  DataClassification,
  EvolutionKind,
  ForgeProvenance,
  ForgeVerificationSummary,
} from "@koi/core";

export interface CreateProvenanceOptions {
  readonly forgedBy: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly invocationId: string;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly contentHash: string;
  readonly buildType: string;
  readonly externalParameters: Readonly<Record<string, unknown>>;
  readonly builderId: string;
  readonly verification: ForgeVerificationSummary;
  readonly depth?: number | undefined;
  readonly classification?: DataClassification | undefined;
  readonly contentMarkers?: readonly ContentMarker[] | undefined;
  readonly demandId?: string | undefined;
  readonly parentBrickId?: BrickId | undefined;
  readonly evolutionKind?: EvolutionKind | undefined;
}

export function createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance {
  if (options.finishedAt < options.startedAt) {
    throw new Error("createForgeProvenance: finishedAt < startedAt");
  }

  const externalParameters: Readonly<Record<string, unknown>> =
    options.demandId !== undefined
      ? { ...options.externalParameters, demandId: options.demandId }
      : options.externalParameters;

  return {
    source: {
      origin: "forged",
      forgedBy: options.forgedBy,
      sessionId: options.sessionId,
    },
    buildDefinition: {
      buildType: options.buildType,
      externalParameters,
    },
    builder: { id: options.builderId },
    metadata: {
      invocationId: options.invocationId,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      sessionId: options.sessionId,
      agentId: options.agentId,
      depth: options.depth ?? 0,
    },
    verification: options.verification,
    classification: options.classification ?? "public",
    contentMarkers: options.contentMarkers ?? [],
    contentHash: options.contentHash,
    ...(options.parentBrickId !== undefined ? { parentBrickId: options.parentBrickId } : {}),
    ...(options.evolutionKind !== undefined ? { evolutionKind: options.evolutionKind } : {}),
  };
}
