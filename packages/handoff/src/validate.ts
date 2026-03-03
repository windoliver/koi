/**
 * Validation functions for handoff envelope input and artifact references.
 */

import type { ArtifactRef, JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Type guards (replace `as` casts per banned-constructs rules)
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isArtifactRefArray(value: unknown): value is readonly ArtifactRef[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.kind === "string" &&
      typeof item.uri === "string",
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isDecisionArray(value: unknown): value is PrepareInput["decisions"] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      typeof item.agentId === "string" &&
      typeof item.action === "string" &&
      typeof item.reasoning === "string" &&
      typeof item.timestamp === "number",
  );
}

// ---------------------------------------------------------------------------
// Prepare input validation
// ---------------------------------------------------------------------------

export interface PrepareInput {
  readonly to?: string | undefined;
  readonly capability?: string | undefined;
  readonly completed: string;
  readonly next: string;
  readonly results?: JsonObject | undefined;
  readonly artifacts?: readonly ArtifactRef[] | undefined;
  readonly decisions?:
    | readonly {
        readonly agentId: string;
        readonly action: string;
        readonly reasoning: string;
        readonly timestamp: number;
        readonly toolCallId?: string | undefined;
      }[]
    | undefined;
  readonly warnings?: readonly string[] | undefined;
  readonly delegation?: unknown | undefined;
  readonly metadata?: JsonObject | undefined;
}

export type ValidatePrepareResult =
  | { readonly ok: true; readonly value: PrepareInput }
  | { readonly ok: false; readonly message: string };

/** Validate and extract prepare_handoff tool input. */
export function validatePrepareInput(args: JsonObject): ValidatePrepareResult {
  const to = typeof args.to === "string" && args.to.length > 0 ? args.to : undefined;
  const capability =
    typeof args.capability === "string" && args.capability.length > 0 ? args.capability : undefined;

  // XOR: exactly one of `to` or `capability` must be provided
  if (to !== undefined && capability !== undefined) {
    return { ok: false, message: "Provide exactly one of 'to' or 'capability', not both" };
  }
  if (to === undefined && capability === undefined) {
    return { ok: false, message: "Provide exactly one of 'to' or 'capability'" };
  }

  const completed = args.completed;
  if (typeof completed !== "string" || completed.length === 0) {
    return { ok: false, message: "'completed' is required and must be a non-empty string" };
  }

  const next = args.next;
  if (typeof next !== "string" || next.length === 0) {
    return { ok: false, message: "'next' is required and must be a non-empty string" };
  }

  return {
    ok: true,
    value: {
      to,
      capability,
      completed,
      next,
      results: isJsonObject(args.results) ? args.results : undefined,
      artifacts: isArtifactRefArray(args.artifacts) ? args.artifacts : undefined,
      decisions: isDecisionArray(args.decisions) ? args.decisions : undefined,
      warnings: isStringArray(args.warnings) ? args.warnings : undefined,
      delegation: args.delegation,
      metadata: isJsonObject(args.metadata) ? args.metadata : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Accept input validation
// ---------------------------------------------------------------------------

export type ValidateAcceptResult =
  | { readonly ok: true; readonly handoffId: string }
  | { readonly ok: false; readonly message: string };

/** Validate accept_handoff tool input. */
export function validateAcceptInput(args: JsonObject): ValidateAcceptResult {
  const handoffId = args.handoff_id;
  if (typeof handoffId !== "string" || handoffId.length === 0) {
    return { ok: false, message: "'handoff_id' is required and must be a non-empty string" };
  }
  return { ok: true, handoffId };
}

// ---------------------------------------------------------------------------
// Artifact validation
// ---------------------------------------------------------------------------

const SUPPORTED_SCHEMES = ["file://"] as const;

/**
 * Validate artifact references. Returns warnings for unsupported or
 * inaccessible URIs — does not hard-fail (Decision #14).
 */
export function validateArtifactRefs(refs: readonly ArtifactRef[]): readonly string[] {
  const warnings: string[] = [];

  for (const ref of refs) {
    if (typeof ref.uri !== "string" || ref.uri.length === 0) {
      warnings.push(`Artifact "${ref.id}" has empty or missing URI`);
      continue;
    }

    const hasSupported = SUPPORTED_SCHEMES.some((scheme) => ref.uri.startsWith(scheme));
    if (!hasSupported) {
      warnings.push(
        `Artifact "${ref.id}" uses unsupported URI scheme: ${ref.uri.split(":")[0] ?? "unknown"}. Supported: ${SUPPORTED_SCHEMES.join(", ")}`,
      );
    }
  }

  return warnings;
}
