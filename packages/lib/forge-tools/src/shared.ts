/**
 * Pure-function core for @koi/forge-tools: deterministic identity hash,
 * caller resolution from the tool execution context, and KoiError factories.
 */

import type { BrickId, BrickKind, ForgeScope, JsonObject, KoiError } from "@koi/core";
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

/** Stable JSON encoding with object keys sorted lexicographically. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
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
