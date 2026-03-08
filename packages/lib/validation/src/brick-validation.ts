/**
 * Lightweight type guard for BrickArtifact loaded from storage.
 *
 * Validates discriminant fields and kind-specific properties
 * without external dependencies. Returns Result<BrickArtifact, KoiError>.
 */

import type { BrickArtifact, KoiError, Result } from "@koi/core";
import { ALL_BRICK_KINDS, internal } from "@koi/core";

const VALID_KINDS = new Set<string>(ALL_BRICK_KINDS);
const VALID_SCOPES = new Set(["agent", "zone", "global"]);
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
  if (
    typeof data.policy !== "object" ||
    data.policy === null ||
    typeof (data.policy as Record<string, unknown>).sandbox !== "boolean"
  )
    return fail(`invalid policy '${String(data.policy)}'`, source);
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
  if (data.files !== undefined) {
    if (!isRecord(data.files)) {
      return fail("'files' must be an object if present", source);
    }
    for (const [key, value] of Object.entries(data.files)) {
      if (typeof value !== "string") {
        return fail(`'files["${key}"]' must be a string, got ${typeof value}`, source);
      }
    }
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
      if (data.outputSchema !== undefined && !isRecord(data.outputSchema))
        return fail("tool 'outputSchema' must be an object if present", source);
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
    case "composite":
      if (!Array.isArray(data.steps)) return fail("composite missing 'steps' array", source);
      for (let i = 0; i < data.steps.length; i++) {
        const step = data.steps[i];
        if (!isRecord(step)) return fail(`composite steps[${String(i)}] is not an object`, source);
        if (!isNonEmptyString((step as Record<string, unknown>).brickId))
          return fail(`composite steps[${String(i)}] missing 'brickId'`, source);
      }
      if (!isRecord(data.exposedInput))
        return fail("composite missing 'exposedInput' object", source);
      if (!isRecord(data.exposedOutput))
        return fail("composite missing 'exposedOutput' object", source);
      if (!isNonEmptyString(data.outputKind)) return fail("composite missing 'outputKind'", source);
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
