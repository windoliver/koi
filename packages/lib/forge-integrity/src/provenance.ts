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
  // Lineage invariant: parentBrickId and evolutionKind must be both-or-neither.
  // A `fix`/`derived`/`captured` evolution makes no sense without a parent;
  // a parent without an evolution kind has no auditable derivation reason.
  const hasParent = options.parentBrickId !== undefined;
  const hasEvolutionKind = options.evolutionKind !== undefined;
  if (hasParent !== hasEvolutionKind) {
    throw new Error(
      "createForgeProvenance: parentBrickId and evolutionKind must be both set or both omitted",
    );
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
  const seen = new WeakSet<object>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (!Object.isFrozen(node)) Object.freeze(node);
    for (const v of Object.values(node as Record<string, unknown>)) walk(v);
  };
  walk(value);
  return value;
}
