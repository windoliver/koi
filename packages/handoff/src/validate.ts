/**
 * Validation functions for handoff envelope input and artifact references.
 */

import type { ArtifactRef, JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Prepare input validation
// ---------------------------------------------------------------------------

export interface PrepareInput {
  readonly to: string;
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
  const to = args.to;
  if (typeof to !== "string" || to.length === 0) {
    return { ok: false, message: "'to' is required and must be a non-empty string" };
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
      completed,
      next,
      results:
        typeof args.results === "object" && args.results !== null
          ? (args.results as JsonObject)
          : undefined,
      artifacts: Array.isArray(args.artifacts)
        ? (args.artifacts as readonly ArtifactRef[])
        : undefined,
      decisions: Array.isArray(args.decisions)
        ? (args.decisions as PrepareInput["decisions"])
        : undefined,
      warnings: Array.isArray(args.warnings) ? (args.warnings as readonly string[]) : undefined,
      delegation: args.delegation,
      metadata:
        typeof args.metadata === "object" && args.metadata !== null
          ? (args.metadata as JsonObject)
          : undefined,
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
