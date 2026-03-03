/**
 * Bundle serialization — JSON encode/decode for `.koibundle` files.
 *
 * Serialize: JSON.stringify with 2-space indent for inspectability.
 * Deserialize: JSON.parse + field-by-field validation + brick validation.
 */

import type { AgentBundle, KoiError, Result } from "@koi/core";
import { BUNDLE_FORMAT_VERSION, bundleId, validation } from "@koi/core";
import { validateBrickArtifact } from "@koi/validation";

/** Serialize an AgentBundle to a pretty-printed JSON string. */
export function serializeBundle(bundle: AgentBundle): string {
  return JSON.stringify(bundle, null, 2);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Deserialize a JSON string into a validated AgentBundle. */
export function deserializeBundle(json: string): Result<AgentBundle, KoiError> {
  if (json.length === 0) {
    return { ok: false, error: validation("Bundle JSON must not be empty") };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e: unknown) {
    const message = e instanceof SyntaxError ? e.message : "unknown parse error";
    return { ok: false, error: validation(`Invalid JSON: ${message}`) };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: validation("Bundle must be a JSON object") };
  }

  const data = raw as Record<string, unknown>;

  // Validate version
  if (data.version !== BUNDLE_FORMAT_VERSION) {
    return {
      ok: false,
      error: validation(
        `Unsupported bundle version "${String(data.version)}", expected "${BUNDLE_FORMAT_VERSION}"`,
      ),
    };
  }

  // Validate required string fields
  if (!isNonEmptyString(data.id)) {
    return { ok: false, error: validation("Missing or empty 'id' field") };
  }
  if (!isNonEmptyString(data.name)) {
    return { ok: false, error: validation("Missing or empty 'name' field") };
  }
  if (typeof data.description !== "string") {
    return { ok: false, error: validation("Missing 'description' field") };
  }
  if (!isNonEmptyString(data.manifestYaml)) {
    return { ok: false, error: validation("Missing or empty 'manifestYaml' field") };
  }
  if (!isNonEmptyString(data.contentHash)) {
    return { ok: false, error: validation("Missing or empty 'contentHash' field") };
  }

  // Validate createdAt
  if (typeof data.createdAt !== "number") {
    return { ok: false, error: validation("Missing or non-number 'createdAt' field") };
  }

  // Validate bricks array
  if (!Array.isArray(data.bricks)) {
    return { ok: false, error: validation("Missing or non-array 'bricks' field") };
  }

  // Deep validate each brick
  const validatedBricks = [];
  for (let i = 0; i < data.bricks.length; i++) {
    const brickResult = validateBrickArtifact(data.bricks[i], `bundle.bricks[${String(i)}]`);
    if (!brickResult.ok) {
      return {
        ok: false,
        error: validation(`Invalid brick at index ${String(i)}: ${brickResult.error.message}`),
      };
    }
    validatedBricks.push(brickResult.value);
  }

  // Validate metadata if present
  if (
    data.metadata !== undefined &&
    (typeof data.metadata !== "object" || data.metadata === null || Array.isArray(data.metadata))
  ) {
    return { ok: false, error: validation("'metadata' must be a plain object if present") };
  }

  // After all guards pass, reconstruct with branded constructors
  const bundle: AgentBundle = {
    version: BUNDLE_FORMAT_VERSION,
    id: bundleId(data.id as string),
    name: data.name as string,
    description: data.description as string,
    manifestYaml: data.manifestYaml as string,
    bricks: validatedBricks,
    contentHash: data.contentHash as string,
    createdAt: data.createdAt as number,
    ...(data.metadata !== undefined
      ? { metadata: data.metadata as Readonly<Record<string, unknown>> }
      : {}),
  };

  return { ok: true, value: bundle };
}
