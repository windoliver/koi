/**
 * Pure-function core for @koi/forge-tools: deterministic identity hash,
 * caller resolution from the tool execution context, and KoiError factories.
 */

import type {
  BrickArtifact,
  BrickId,
  BrickKind,
  ForgeScope,
  JsonObject,
  KoiError,
} from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { getExecutionContext } from "@koi/execution-context";
import { computeBrickId } from "@koi/hash";

// ---------------------------------------------------------------------------
// Identity hash
// ---------------------------------------------------------------------------

export interface IdentityInputs {
  readonly kind: BrickKind;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly scope: ForgeScope;
  readonly ownerAgentId: string;
  readonly content: JsonObject;
}

/**
 * Deterministic identity for a forge brick. Same canonical inputs → same id.
 * Per-publisher partitioning: `ownerAgentId` is part of the hash so two agents
 * synthesizing the same logical brick get distinct ids.
 */
export function computeIdentityBrickId(inputs: IdentityInputs): BrickId {
  const canonical = canonicalize({
    name: inputs.name,
    description: inputs.description,
    version: inputs.version,
    scope: inputs.scope,
    ownerAgentId: inputs.ownerAgentId,
    content: inputs.content,
  });
  return computeBrickId(inputs.kind, canonical);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON encoding with object keys sorted lexicographically. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/**
 * Common immutable BrickArtifactBase fields that participate in identity.
 * Spread alongside kind-specific content so two artifacts that differ only
 * in `files` / `requires` / `configSchema` / `composition` cannot collapse
 * onto the same id.
 */
function baseImmutables(brick: BrickArtifact): JsonObject {
  return {
    ...(brick.files !== undefined ? { files: brick.files } : {}),
    ...(brick.requires !== undefined ? { requires: brick.requires } : {}),
    ...(brick.configSchema !== undefined ? { configSchema: brick.configSchema } : {}),
    ...(brick.composition !== undefined ? { composition: brick.composition } : {}),
  };
}

/**
 * Extract the kind-specific identity content from a persisted BrickArtifact,
 * mirroring exactly what the synthesizer passed to `computeIdentityBrickId`,
 * extended with all immutable BrickArtifactBase fields so distinct content
 * cannot alias under one id.
 *
 * Throws for kinds whose identity content is not defined here. The store must
 * reject these rather than silently bypass content-address validation.
 */
export function extractIdentityContent(brick: BrickArtifact): JsonObject {
  const base = baseImmutables(brick);
  if (brick.kind === "tool") {
    return {
      ...base,
      implementation: brick.implementation,
      inputSchema: brick.inputSchema,
      ...(brick.outputSchema !== undefined ? { outputSchema: brick.outputSchema } : {}),
      ...(brick.testCases !== undefined ? { testCases: brick.testCases } : {}),
      ...(brick.counterexamples !== undefined ? { counterexamples: brick.counterexamples } : {}),
    };
  }
  if (brick.kind === "middleware" || brick.kind === "channel") {
    return {
      ...base,
      implementation: brick.implementation,
      ...(brick.testCases !== undefined ? { testCases: brick.testCases } : {}),
      ...(brick.counterexamples !== undefined ? { counterexamples: brick.counterexamples } : {}),
    };
  }
  if (brick.kind === "skill") {
    return { ...base, content: brick.content };
  }
  if (brick.kind === "agent") {
    return { ...base, manifestYaml: brick.manifestYaml };
  }
  if (brick.kind === "composite") {
    return {
      ...base,
      steps: brick.steps,
      exposedInput: brick.exposedInput,
      exposedOutput: brick.exposedOutput,
      outputKind: brick.outputKind,
    };
  }
  throw new Error(
    `forge-tools: unsupported brick kind for content-addressed storage: ${brick.kind}`,
  );
}

/**
 * Recompute the canonical identity BrickId from a persisted artifact's
 * identity-bearing fields plus its owning agent (read from provenance).
 *
 * Throws on unsupported kinds or when `provenance.metadata.agentId` is
 * missing/empty. Callers (the store) must convert the throw into a
 * typed Result error.
 */
export function recomputeBrickIdFromArtifact(brick: BrickArtifact): BrickId {
  const content = extractIdentityContent(brick);
  const ownerAgentId = brick.provenance.metadata.agentId;
  if (typeof ownerAgentId !== "string" || ownerAgentId.length === 0) {
    throw new Error("forge-tools: provenance.metadata.agentId missing or empty");
  }
  return computeIdentityBrickId({
    kind: brick.kind,
    name: brick.name,
    description: brick.description,
    version: brick.version,
    scope: brick.scope,
    ownerAgentId,
    content,
  });
}

// ---------------------------------------------------------------------------
// Input quotas (byte caps applied before hashing/persisting)
// ---------------------------------------------------------------------------

/** Hard byte limits for forge synthesis inputs to prevent unbounded payloads. */
export const FORGE_INPUT_LIMITS = {
  /** Max bytes for `name`. */
  name: 256,
  /** Max bytes for `description`. */
  description: 4096,
  /** Max bytes for `version`. */
  version: 64,
  /** Max bytes for `implementation` (function-body string). */
  implementation: 65_536,
  /** Max bytes for canonical-encoded `inputSchema` / `outputSchema`. */
  schema: 16_384,
} as const;

/**
 * Validate a string field against its byte limit (UTF-8). Returns a KoiError
 * suitable for synthesizer return on failure, or `undefined` on success.
 */
export function validateFieldSize(
  field: string,
  value: string,
  limit: number,
): KoiError | undefined {
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > limit) {
    return invalidInput(`forge-tools: ${field} exceeds ${limit}-byte limit (got ${bytes})`, {
      field,
      bytes,
      limit,
    });
  }
  return undefined;
}

/**
 * Validate the canonical-encoded byte size of a JSON-shaped value (typically
 * an `inputSchema` or `outputSchema`). Reuses the canonicalization that the
 * identity hash uses so the size limit matches what is actually persisted
 * and hashed.
 */
export function validateSchemaSize(
  field: string,
  value: unknown,
  limit: number,
): KoiError | undefined {
  const encoded = canonicalize(value);
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > limit) {
    return invalidInput(
      `forge-tools: ${field} exceeds ${limit}-byte canonical-encoded limit (got ${bytes})`,
      { field, bytes, limit },
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Caller resolution
// ---------------------------------------------------------------------------

export interface CallerContext {
  readonly agentId: string;
}

/**
 * Reads the active tool execution context to determine the calling agent.
 * Throws if called outside any execution context (defensive — forge tools
 * must only run inside an L1 agent loop).
 */
export function resolveCaller(): CallerContext {
  const ctx = getExecutionContext();
  if (ctx === undefined) {
    throw new Error("NO_CONTEXT: forge tool invoked outside any execution context");
  }
  return { agentId: ctx.session.agentId };
}

// ---------------------------------------------------------------------------
// KoiError factories
//
// Code mapping (plan name → @koi/core KoiErrorCode):
//   INVALID_INPUT       → VALIDATION
//   NOT_FOUND           → NOT_FOUND
//   FORBIDDEN           → PERMISSION
//   CONFLICT            → CONFLICT
//   INVARIANT_VIOLATION → INTERNAL
// ---------------------------------------------------------------------------

export function invalidInput(message: string, context?: JsonObject): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
    ...(context !== undefined ? { context } : {}),
  };
}

export function notFound(resourceId: string, message: string): KoiError {
  return {
    code: "NOT_FOUND",
    message,
    retryable: RETRYABLE_DEFAULTS.NOT_FOUND,
    context: { resourceId },
  };
}

export function forbidden(message: string, context?: JsonObject): KoiError {
  return {
    code: "PERMISSION",
    message,
    retryable: RETRYABLE_DEFAULTS.PERMISSION,
    ...(context !== undefined ? { context } : {}),
  };
}

export function conflict(resourceId: string, message: string, context?: JsonObject): KoiError {
  return {
    code: "CONFLICT",
    message,
    retryable: RETRYABLE_DEFAULTS.CONFLICT,
    context: { resourceId, ...(context ?? {}) },
  };
}

export function invariantViolation(message: string, context?: JsonObject): KoiError {
  return {
    code: "INTERNAL",
    message,
    retryable: RETRYABLE_DEFAULTS.INTERNAL,
    ...(context !== undefined ? { context } : {}),
  };
}
