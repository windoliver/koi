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
import { isBrickId } from "@koi/hash";

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
const ALLOWED_EVOLUTION_KINDS = new Set<EvolutionKind>(["fix", "derived", "captured"]);

/** Bound on object/array nesting we will traverse — defends against stack-blowing inputs. */
export const MAX_PROVENANCE_DEPTH = 32;

export function createForgeProvenance(options: CreateProvenanceOptions): ForgeProvenance {
  validateScalars(options);
  if (options.finishedAt < options.startedAt) {
    throw new Error("createForgeProvenance: finishedAt < startedAt");
  }
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
  // Root must be a plain object — null, arrays, and primitives are rejected
  // before any clone/hasOwn step so malformed caller input cannot persist
  // into provenance records (and Object.hasOwn cannot throw on null below).
  if (
    options.externalParameters === null ||
    typeof options.externalParameters !== "object" ||
    Array.isArray(options.externalParameters) ||
    !isPlainObjectRoot(options.externalParameters)
  ) {
    throw new Error(
      "createForgeProvenance: externalParameters must be a plain object (not null, array, or primitive)",
    );
  }
  // Provenance is immutable, audit-visible metadata; restrict structured
  // inputs to JSON-plain values so we can guarantee a deep freeze. Map/Set/
  // Date instances survive `Object.freeze` with mutable APIs intact, so we
  // reject them at the boundary rather than silently letting callers mutate
  // trust-bearing metadata after construction. The walker is iterative and
  // depth-bounded so deeply-nested untyped inputs fail with a typed error
  // rather than blowing the stack.
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
  const hasParent = options.parentBrickId !== undefined;
  const hasEvolutionKind = options.evolutionKind !== undefined;
  if (hasParent !== hasEvolutionKind) {
    throw new Error(
      "createForgeProvenance: parentBrickId and evolutionKind must be both set or both omitted",
    );
  }
  if (hasEvolutionKind && !ALLOWED_EVOLUTION_KINDS.has(options.evolutionKind as EvolutionKind)) {
    throw new Error(
      `createForgeProvenance: invalid evolutionKind "${String(options.evolutionKind)}"`,
    );
  }

  if (
    options.demandId !== undefined &&
    Object.hasOwn(options.externalParameters, "demandId") &&
    options.externalParameters.demandId !== options.demandId
  ) {
    throw new Error("createForgeProvenance: demandId conflicts with externalParameters.demandId");
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

function isPlainObjectRoot(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireNonEmptyString(name: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`createForgeProvenance: ${name} must be a non-empty string`);
  }
}

function requireFiniteNumber(name: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`createForgeProvenance: ${name} must be a finite number`);
  }
}

function validateScalars(o: CreateProvenanceOptions): void {
  requireNonEmptyString("forgedBy", o.forgedBy);
  requireNonEmptyString("sessionId", o.sessionId);
  requireNonEmptyString("agentId", o.agentId);
  requireNonEmptyString("invocationId", o.invocationId);
  requireNonEmptyString("contentHash", o.contentHash);
  requireNonEmptyString("buildType", o.buildType);
  requireNonEmptyString("builderId", o.builderId);
  requireFiniteNumber("startedAt", o.startedAt);
  requireFiniteNumber("finishedAt", o.finishedAt);
  if (o.depth !== undefined) {
    if (typeof o.depth !== "number" || !Number.isFinite(o.depth) || o.depth < 0) {
      throw new Error("createForgeProvenance: depth must be a non-negative finite number");
    }
  }
  if (o.parentBrickId !== undefined) {
    requireNonEmptyString("parentBrickId", o.parentBrickId);
    if (!isBrickId(o.parentBrickId)) {
      throw new Error(
        "createForgeProvenance: parentBrickId must be a canonical BrickId (sha256:<64-hex>)",
      );
    }
  }
  if (o.demandId !== undefined) requireNonEmptyString("demandId", o.demandId);
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

interface FreezeFrame {
  readonly node: unknown;
  readonly depth: number;
}

function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>();
  const stack: FreezeFrame[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const node = frame.node;
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    if (frame.depth > MAX_PROVENANCE_DEPTH) {
      throw new Error(`createForgeProvenance: nested object depth exceeds ${MAX_PROVENANCE_DEPTH}`);
    }
    seen.add(node);
    if (!Object.isFrozen(node)) Object.freeze(node);
    for (const v of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: v, depth: frame.depth + 1 });
    }
  }
  return value;
}

interface PlainFrame {
  readonly node: unknown;
  readonly path: string;
  readonly depth: number;
}

/**
 * Return a path to the first non-plain (Map/Set/Date/Function/etc.) value
 * found in `value`, or undefined if every nested value is JSON-plain.
 * Iterative + depth-bounded so deeply-nested input fails with a typed error
 * rather than `RangeError`.
 */
function findNonPlainValue(value: unknown): string | undefined {
  const seen = new WeakSet<object>();
  const stack: PlainFrame[] = [{ node: value, path: "$", depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, path, depth } = frame;
    if (node === null) continue;
    const t = typeof node;
    if (t === "string" || t === "number" || t === "boolean") continue;
    if (t !== "object") return `${path} is ${t}`;
    if (seen.has(node as object)) continue;
    seen.add(node as object);
    if (depth > MAX_PROVENANCE_DEPTH) {
      return `${path} exceeds max nesting depth ${MAX_PROVENANCE_DEPTH}`;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        stack.push({ node: node[i], path: `${path}[${i}]`, depth: depth + 1 });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(node);
    if (proto !== null && proto !== Object.prototype) {
      return `${path} is a non-plain object (${proto.constructor?.name ?? "unknown"})`;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      stack.push({ node: v, path: `${path}.${k}`, depth: depth + 1 });
    }
  }
  return undefined;
}
