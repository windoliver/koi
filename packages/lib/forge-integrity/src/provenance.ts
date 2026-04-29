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

const ALLOWED_CLASSIFICATIONS = new Set<DataClassification>(["public", "internal", "secret"]);
const ALLOWED_MARKERS = new Set<ContentMarker>(["credentials", "pii", "phi", "payment"]);

export function createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance {
  if (options.finishedAt < options.startedAt) {
    throw new Error("createForgeProvenance: finishedAt < startedAt");
  }
  // Runtime validation of trust-bearing fields. TypeScript guards the typed
  // call sites; the runtime checks defend the JS / version-skew boundary so
  // policy/audit consumers can rely on shape invariants.
  if (!ALLOWED_CLASSIFICATIONS.has(options.classification)) {
    throw new Error(
      `createForgeProvenance: classification must be one of ${[...ALLOWED_CLASSIFICATIONS].join(", ")}`,
    );
  }
  if (!Array.isArray(options.contentMarkers)) {
    throw new Error("createForgeProvenance: contentMarkers must be an array");
  }
  for (const m of options.contentMarkers) {
    if (!ALLOWED_MARKERS.has(m)) {
      throw new Error(`createForgeProvenance: invalid contentMarker "${String(m)}"`);
    }
  }
  validateVerification(options.verification);
  // Provenance is immutable, audit-visible metadata; restrict structured
  // inputs to JSON-plain values so we can guarantee a deep freeze. Map/Set/
  // Date instances survive `Object.freeze` with mutable APIs intact, so we
  // reject them at the boundary rather than silently letting callers mutate
  // trust-bearing metadata after construction.
  const externalsViolation = findNonPlainValue(options.externalParameters);
  if (externalsViolation !== undefined) {
    throw new Error(
      `createForgeProvenance: externalParameters must be JSON-plain — ${externalsViolation}`,
    );
  }
  const verificationViolation = findNonPlainValue(options.verification);
  if (verificationViolation !== undefined) {
    throw new Error(
      `createForgeProvenance: verification must be JSON-plain — ${verificationViolation}`,
    );
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

function validateVerification(v: ForgeVerificationSummary): void {
  if (v === null || typeof v !== "object") {
    throw new Error("createForgeProvenance: verification must be an object");
  }
  if (typeof v.passed !== "boolean") {
    throw new Error("createForgeProvenance: verification.passed must be boolean");
  }
  if (typeof v.sandbox !== "boolean") {
    throw new Error("createForgeProvenance: verification.sandbox must be boolean");
  }
  if (typeof v.totalDurationMs !== "number" || !Number.isFinite(v.totalDurationMs)) {
    throw new Error("createForgeProvenance: verification.totalDurationMs must be finite number");
  }
  if (!Array.isArray(v.stageResults)) {
    throw new Error("createForgeProvenance: verification.stageResults must be an array");
  }
  for (const s of v.stageResults) {
    if (s === null || typeof s !== "object") {
      throw new Error("createForgeProvenance: verification.stageResults[*] must be an object");
    }
    if (typeof s.stage !== "string" || s.stage.length === 0) {
      throw new Error("createForgeProvenance: stageResults[*].stage must be non-empty string");
    }
    if (typeof s.passed !== "boolean") {
      throw new Error("createForgeProvenance: stageResults[*].passed must be boolean");
    }
    if (typeof s.durationMs !== "number" || !Number.isFinite(s.durationMs)) {
      throw new Error("createForgeProvenance: stageResults[*].durationMs must be finite number");
    }
  }
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

/**
 * Return a path to the first non-plain (Map/Set/Date/Function/etc.) value
 * found in `value`, or undefined if every nested value is JSON-plain
 * (string/number/boolean/null/array/plain-object). Used to reject inputs
 * that would survive Object.freeze with mutable APIs.
 */
function findNonPlainValue(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string): string | undefined => {
    if (node === null) return undefined;
    const t = typeof node;
    if (t === "string" || t === "number" || t === "boolean") return undefined;
    if (t !== "object") return `${path} is ${t}`;
    if (seen.has(node as object)) return undefined;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const sub = walk(node[i], `${path}[${i}]`);
        if (sub !== undefined) return sub;
      }
      return undefined;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== null && proto !== Object.prototype) {
      return `${path} is a non-plain object (${proto.constructor?.name ?? "unknown"})`;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const sub = walk(v, `${path}.${k}`);
      if (sub !== undefined) return sub;
    }
    return undefined;
  };
  return walk(value, "$");
}
