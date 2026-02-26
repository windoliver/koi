/**
 * Lightweight type guard for BrickArtifact loaded from storage.
 *
 * Validates discriminant fields and kind-specific properties
 * without external dependencies. Returns Result<BrickArtifact, KoiError>.
 */

import type { BrickArtifact, KoiError, Result } from "@koi/core";
import { internal } from "@koi/core";

const VALID_KINDS = new Set(["tool", "skill", "agent", "middleware", "channel"]);
const VALID_SCOPES = new Set(["agent", "zone", "global"]);
const VALID_TRUST_TIERS = new Set(["sandbox", "verified", "promoted"]);
const VALID_LIFECYCLES = new Set([
  "draft",
  "verifying",
  "active",
  "failed",
  "deprecated",
  "quarantined",
]);

/** Return a typed error result. `never` value makes it assignable to any Result<T, KoiError>. */
function fail(reason: string, source: string): Result<never, KoiError> {
  return { ok: false, error: internal(`Invalid brick in ${source}: ${reason}`) };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate base fields shared by all brick kinds. */
function validateBase(data: Record<string, unknown>, source: string): Result<void, KoiError> {
  if (!isNonEmptyString(data.id)) return fail("missing or empty 'id'", source);
  if (!isNonEmptyString(data.kind)) return fail("missing or empty 'kind'", source);
  if (!VALID_KINDS.has(data.kind as string))
    return fail(`unknown kind '${String(data.kind)}'`, source);
  if (!isNonEmptyString(data.name)) return fail("missing or empty 'name'", source);
  if (typeof data.description !== "string") return fail("missing 'description'", source);
  if (!VALID_SCOPES.has(data.scope as string))
    return fail(`invalid scope '${String(data.scope)}'`, source);
  if (!VALID_TRUST_TIERS.has(data.trustTier as string))
    return fail(`invalid trustTier '${String(data.trustTier)}'`, source);
  if (!VALID_LIFECYCLES.has(data.lifecycle as string))
    return fail(`invalid lifecycle '${String(data.lifecycle)}'`, source);
  if (!isRecord(data.provenance)) return fail("missing or non-object 'provenance'", source);
  if (!isNonEmptyString(data.version)) return fail("missing or empty 'version'", source);
  if (!Array.isArray(data.tags)) return fail("missing or non-array 'tags'", source);
  if (typeof data.usageCount !== "number")
    return fail("missing or non-number 'usageCount'", source);
  return { ok: true, value: undefined };
}

/** Validate optional universal fields (files, requires). */
function validateUniversalOptionals(
  data: Record<string, unknown>,
  source: string,
): Result<void, KoiError> {
  if (data.files !== undefined && !isRecord(data.files)) {
    return fail("'files' must be an object if present", source);
  }
  if (data.requires !== undefined && !isRecord(data.requires)) {
    return fail("'requires' must be an object if present", source);
  }
  return { ok: true, value: undefined };
}

/** Validate kind-specific fields. */
function validateKindFields(data: Record<string, unknown>, source: string): Result<void, KoiError> {
  switch (data.kind) {
    case "tool":
      if (typeof data.implementation !== "string")
        return fail("tool missing 'implementation'", source);
      if (!isRecord(data.inputSchema)) return fail("tool missing 'inputSchema' object", source);
      break;
    case "skill":
      if (typeof data.content !== "string") return fail("skill missing 'content'", source);
      break;
    case "agent":
      if (typeof data.manifestYaml !== "string")
        return fail("agent missing 'manifestYaml'", source);
      break;
    case "middleware":
    case "channel":
      if (typeof data.implementation !== "string")
        return fail(`${String(data.kind)} missing 'implementation'`, source);
      break;
    default:
      break;
  }
  return { ok: true, value: undefined };
}

/**
 * Validate parsed JSON data as a BrickArtifact.
 * Returns the validated artifact or an INTERNAL error describing the issue.
 *
 * @param data - Parsed JSON to validate
 * @param source - Backend-agnostic context for error messages (file path, DB row id, etc.)
 */
export function validateBrickArtifact(
  data: unknown,
  source: string,
): Result<BrickArtifact, KoiError> {
  if (!isRecord(data)) {
    return fail("not an object", source);
  }

  const baseResult = validateBase(data, source);
  if (!baseResult.ok) return baseResult;

  const kindResult = validateKindFields(data, source);
  if (!kindResult.ok) return kindResult;

  const universalResult = validateUniversalOptionals(data, source);
  if (!universalResult.ok) return universalResult;

  // After validation, safe to treat as BrickArtifact
  return { ok: true, value: data as unknown as BrickArtifact };
}
