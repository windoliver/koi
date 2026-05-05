/**
 * Trust-boundary validation for `SynthesisInput`. Snapshots, size-caps,
 * and freezes every caller-supplied field before the synthesis loop
 * begins. All caller-side hostility (throwing getters, oversized strings,
 * non-plain prototypes, BigInt, NaN/Infinity, cycles) terminates here so
 * the loop body can read frozen, validated values without re-defending.
 */

import type { ForgeCandidate } from "@koi/forge-types";
import { deepFreeze, ensureJsonPlain, snapshotJsonPlain } from "./json-plain.js";
import type { SynthesisInput, SynthesisResult } from "./types.js";

/** Hard cap on the JSON-serialized targetToolSchema before prompt build. */
export const MAX_SCHEMA_BYTES: number = 32 * 1024;

/** Hard cap on individual candidate prompt-bound string fields. */
export const MAX_CANDIDATE_FIELD_BYTES: number = 4 * 1024;

type Failure = Extract<SynthesisResult, { ok: false }>;
type Validated =
  | { readonly ok: true; readonly value: SynthesisInput }
  | { readonly ok: false; readonly failure: Failure };

export function validateAndSnapshotInput(input: SynthesisInput): Validated {
  const schema = validateSchema(input.targetToolSchema);
  if (!schema.ok) return schema;
  const candidate = snapshotCandidate(input.candidate);
  if (!candidate.ok) {
    return { ok: false, failure: invalid(candidate.reason) };
  }
  const cap = capCandidateFields(candidate.value);
  if (!cap.ok) return cap;
  const name = validateTargetToolName(input);
  if (!name.ok) return name;
  return {
    ok: true,
    value: {
      candidate: candidate.value,
      targetToolName: name.value,
      targetToolSchema: schema.value,
    },
  };
}

function validateSchema(
  schema: SynthesisInput["targetToolSchema"],
):
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly failure: Failure } {
  const snap = snapshotJsonPlain(schema, "targetToolSchema");
  if (!snap.ok) return { ok: false, failure: invalid(snap.reason) };
  if (snap.value === null || typeof snap.value !== "object" || Array.isArray(snap.value)) {
    return { ok: false, failure: invalid("targetToolSchema must be a JSON object") };
  }
  const frozen = deepFreeze(snap.value as Record<string, unknown>) as Readonly<
    Record<string, unknown>
  >;
  // Compute size against the trusted snapshot, not the original input,
  // so getters are not invoked again.
  const serialized = JSON.stringify(frozen);
  if (serialized.length > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      failure: invalid(
        `targetToolSchema exceeds ${MAX_SCHEMA_BYTES} bytes (got ${serialized.length})`,
      ),
    };
  }
  return { ok: true, value: frozen };
}

function capCandidateFields(
  candidate: ForgeCandidate,
): { readonly ok: true } | { readonly ok: false; readonly failure: Failure } {
  for (const [key, value] of [
    ["name", candidate.name],
    ["description", candidate.description],
    ["id", candidate.id],
    ["kind", candidate.kind],
    ["proposedScope", candidate.proposedScope],
  ] as const) {
    if (value.length > MAX_CANDIDATE_FIELD_BYTES) {
      return {
        ok: false,
        failure: invalid(
          `candidate.${key} exceeds ${MAX_CANDIDATE_FIELD_BYTES} bytes (got ${value.length})`,
        ),
      };
    }
  }
  return { ok: true };
}

function validateTargetToolName(
  input: SynthesisInput,
):
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly failure: Failure } {
  let name: string;
  try {
    name = input.targetToolName;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, failure: invalid(`targetToolName getter threw: ${message}`) };
  }
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, failure: invalid("targetToolName must be a non-empty string") };
  }
  if (name.length > MAX_CANDIDATE_FIELD_BYTES) {
    return {
      ok: false,
      failure: invalid(
        `targetToolName exceeds ${MAX_CANDIDATE_FIELD_BYTES} bytes (got ${name.length})`,
      ),
    };
  }
  return { ok: true, value: name };
}

/**
 * Read prompt-relevant candidate fields behind a try/catch and validate
 * each one is JSON-plain. Returns a frozen snapshot so prompt construction
 * never re-reads a hostile value.
 */
function snapshotCandidate(
  candidate: ForgeCandidate,
):
  | { readonly ok: true; readonly value: ForgeCandidate }
  | { readonly ok: false; readonly reason: string } {
  let snap: ForgeCandidate;
  try {
    snap = {
      id: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      description: candidate.description,
      priority: candidate.priority,
      proposedScope: candidate.proposedScope,
      createdAt: candidate.createdAt,
    } as ForgeCandidate;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `candidate field access threw: ${message}` };
  }
  for (const [key, value] of [
    ["id", snap.id],
    ["kind", snap.kind],
    ["name", snap.name],
    ["description", snap.description],
    ["proposedScope", snap.proposedScope],
  ] as const) {
    if (typeof value !== "string") {
      return { ok: false, reason: `candidate.${key} must be a string` };
    }
  }
  const plain = ensureJsonPlain(snap, "candidate");
  if (!plain.ok) return plain;
  return { ok: true, value: Object.freeze(snap) };
}

function invalid(reason: string): Failure {
  return { ok: false, reason, attempts: 0, kind: "input_invalid" };
}
