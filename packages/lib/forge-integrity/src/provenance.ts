/**
 * Build a `ForgeProvenance` record from minimal pipeline inputs.
 *
 * The helper never invents trust- or policy-bearing metadata: `verification`,
 * `classification`, and `contentMarkers` are all REQUIRED so a caller cannot
 * silently downgrade a secret/internal artifact into the public bucket or
 * stamp an unverified draft as `passed: true`.
 *
 * All structured inputs are deep-frozen via a defensive structured clone so
 * callers cannot mutate trust/policy metadata after the provenance has been
 * constructed.
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
  /** Required — callers must declare data sensitivity explicitly. */
  readonly classification: DataClassification;
  /** Required — pass an empty array only when the producer has audited content. */
  readonly contentMarkers: readonly ContentMarker[];
  readonly depth?: number | undefined;
  readonly demandId?: string | undefined;
  readonly parentBrickId?: BrickId | undefined;
  readonly evolutionKind?: EvolutionKind | undefined;
}

export function createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance {
  if (options.finishedAt < options.startedAt) {
    throw new Error("createForgeProvenance: finishedAt < startedAt");
  }

  const externalParameters: Readonly<Record<string, unknown>> = deepFreeze(
    options.demandId !== undefined
      ? { ...structuredClone(options.externalParameters), demandId: options.demandId }
      : structuredClone(options.externalParameters),
  );

  const verification = deepFreeze(structuredClone(options.verification));
  const contentMarkers = Object.freeze([...options.contentMarkers]);

  const provenance: ForgeProvenance = {
    source: Object.freeze({
      origin: "forged",
      forgedBy: options.forgedBy,
      sessionId: options.sessionId,
    }),
    buildDefinition: Object.freeze({
      buildType: options.buildType,
      externalParameters,
    }),
    builder: Object.freeze({ id: options.builderId }),
    metadata: Object.freeze({
      invocationId: options.invocationId,
      startedAt: options.startedAt,
      finishedAt: options.finishedAt,
      sessionId: options.sessionId,
      agentId: options.agentId,
      depth: options.depth ?? 0,
    }),
    verification,
    classification: options.classification,
    contentMarkers,
    contentHash: options.contentHash,
    ...(options.parentBrickId !== undefined ? { parentBrickId: options.parentBrickId } : {}),
    ...(options.evolutionKind !== undefined ? { evolutionKind: options.evolutionKind } : {}),
  };
  return Object.freeze(provenance);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v);
  }
  return Object.freeze(value);
}
