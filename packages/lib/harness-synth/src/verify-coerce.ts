/**
 * Verifier-result coercion at the trust boundary. Validates the shape
 * returned by an injected verifier without crashing on hostile getters,
 * non-deterministic re-reads, or version-skewed shapes; produces a
 * snapshot-based ForgeVerificationSummary that downstream provenance
 * can safely ingest.
 */

import type { ForgeVerificationSummary, ToolDescriptor } from "@koi/core";
import { deepFreeze, snapshotJsonPlain } from "./json-plain.js";

/**
 * Internal discriminated result of `coerceVerifyResult`. The synthesis
 * loop maps `cause` to `verify_rejected` (genuine code failure) vs
 * `verify_malformed` (verifier-side bug) in `SynthesisResult.kind`.
 */
export type CoercedVerifyResult =
  | { readonly ok: true; readonly summary: ForgeVerificationSummary }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly cause: "rejected" | "malformed";
    };

/**
 * Deep-clone via JSON round-trip and recursively freeze. Used to isolate
 * the parsed descriptor across the verify boundary so a buggy / hostile
 * verifier cannot mutate fields after schema/name invariants passed.
 * JSON round-trip is safe because descriptor.inputSchema is already
 * validated as JSON-plain upstream.
 */
export function freezeDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  const cloned = JSON.parse(JSON.stringify(descriptor)) as ToolDescriptor;
  return deepFreeze(cloned);
}

/**
 * Validate the shape of a value returned by an injected verifier. A
 * version-skewed or buggy adapter that resolves to `undefined`, `null`,
 * or an object missing the discriminator must not crash the synthesis
 * loop — the boundary's whole point is to keep this typed.
 */
export function coerceVerifyResult(value: unknown): CoercedVerifyResult {
  if (value === null || typeof value !== "object") {
    return {
      ok: false,
      reason: `Verifier returned non-object (typeof ${typeof value})`,
      cause: "malformed",
    };
  }
  const obj = value as Record<string, unknown>;
  if (obj.ok === true) return coerceOkTrue(obj);
  if (obj.ok === false) {
    const reason = typeof obj.reason === "string" ? obj.reason : "(no reason supplied)";
    return { ok: false, reason, cause: "rejected" };
  }
  return {
    ok: false,
    reason: "Verifier returned malformed result (missing or non-boolean `ok`)",
    cause: "malformed",
  };
}

function coerceOkTrue(obj: Record<string, unknown>): CoercedVerifyResult {
  if (obj.summary === undefined) {
    // ok:true without a summary leaves downstream provenance / audit
    // with no per-stage evidence for the winning attempt. Require it
    // so a misconfigured verifier cannot silently drop verification
    // evidence while artifacts still ship as verified.
    return {
      ok: false,
      reason: "Verifier returned ok:true without ForgeVerificationSummary",
      cause: "malformed",
    };
  }
  const summary = coerceVerificationSummary(obj.summary);
  if (!summary.ok) {
    return {
      ok: false,
      reason: `Verifier returned ok:true with malformed summary: ${summary.reason}`,
      cause: "malformed",
    };
  }
  if (!summary.value.passed) {
    // Cross-field invariant: ok:true cannot coexist with passed:false. A
    // verifier whose discriminator and evidence disagree is buggy; we
    // fail closed so callers don't promote artifacts whose own evidence
    // says verification failed.
    return {
      ok: false,
      reason: "Verifier returned ok:true with summary.passed:false",
      cause: "malformed",
    };
  }
  return { ok: true, summary: summary.value };
}

/**
 * Validate `ForgeVerificationSummary` shape so downstream forge integrity
 * (`createForgeProvenance`) receives evidence with the contractual fields.
 * Single-read snapshot first — a hostile verifier with non-deterministic
 * getters could otherwise pass invariants on read 1 and ship different
 * data via the snapshot on read 2.
 */
export function coerceVerificationSummary(
  value: unknown,
):
  | { readonly ok: true; readonly value: ForgeVerificationSummary }
  | { readonly ok: false; readonly reason: string } {
  const snap = snapshotJsonPlain(value, "summary");
  if (!snap.ok) return { ok: false, reason: snap.reason };
  const snapshot = snap.value;
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return { ok: false, reason: "summary must be a JSON object" };
  }
  const obj = snapshot as Record<string, unknown>;
  const shape = validateSummaryShape(obj);
  if (!shape.ok) return shape;
  const cross = validateCrossFieldInvariants(obj);
  if (!cross.ok) return cross;
  return { ok: true, value: deepFreeze(snapshot as ForgeVerificationSummary) };
}

function validateSummaryShape(
  obj: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  if (typeof obj.passed !== "boolean")
    return { ok: false, reason: "summary.passed must be boolean" };
  if (typeof obj.sandbox !== "boolean")
    return { ok: false, reason: "summary.sandbox must be boolean" };
  if (typeof obj.totalDurationMs !== "number" || !Number.isFinite(obj.totalDurationMs)) {
    return { ok: false, reason: "summary.totalDurationMs must be a finite number" };
  }
  if (!Array.isArray(obj.stageResults)) {
    return { ok: false, reason: "summary.stageResults must be an array" };
  }
  for (let i = 0; i < obj.stageResults.length; i += 1) {
    const stage = obj.stageResults[i];
    if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
      return { ok: false, reason: `summary.stageResults[${i}] must be an object` };
    }
    const s = stage as Record<string, unknown>;
    if (typeof s.stage !== "string" || s.stage.length === 0) {
      return { ok: false, reason: `summary.stageResults[${i}].stage must be a non-empty string` };
    }
    if (typeof s.passed !== "boolean") {
      return { ok: false, reason: `summary.stageResults[${i}].passed must be boolean` };
    }
    if (typeof s.durationMs !== "number" || !Number.isFinite(s.durationMs)) {
      return { ok: false, reason: `summary.stageResults[${i}].durationMs must be a finite number` };
    }
  }
  return { ok: true };
}

function validateCrossFieldInvariants(
  obj: Record<string, unknown>,
): { ok: true } | { ok: false; reason: string } {
  // A passed:true verdict with zero stage evidence is contractually
  // empty — downstream forge audit / provenance has nothing to record
  // for the winning attempt. Fail closed: a verifier that publishes
  // success without per-stage evidence is either misconfigured or
  // skipping verification entirely, and either way the artifact must
  // not ship as verified.
  if (obj.passed !== true) return { ok: true };
  const stageResults = obj.stageResults as ReadonlyArray<Record<string, unknown>>;
  if (stageResults.length === 0) {
    return {
      ok: false,
      reason: "summary.passed:true requires at least one stageResults entry",
    };
  }
  for (let i = 0; i < stageResults.length; i += 1) {
    const s = stageResults[i] as Record<string, unknown>;
    if (s.passed !== true) {
      return {
        ok: false,
        reason: `summary.passed:true conflicts with summary.stageResults[${i}].passed:false`,
      };
    }
  }
  return { ok: true };
}
