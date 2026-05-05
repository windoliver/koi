/**
 * Boundary-safe wrappers around the caller-injected `generate` and
 * `verify` callbacks. Each wraps `guardAttempt` (timeout + abort), maps
 * the generic guarded failure into a structured `SynthesisFailureKind`,
 * and validates verifier output through `coerceVerifyResult`.
 */

import type { ToolDescriptor } from "@koi/core";
import { type GuardedResult, guardAttempt } from "./guarded-attempt.js";
import type { SynthesisConfig, SynthesisFailureKind, VerifyResult } from "./types.js";
import { coerceVerifyResult } from "./verify-coerce.js";

export async function safeGenerate(
  generate: SynthesisConfig["generate"],
  prompt: string,
  timeoutMs: number,
  attempt: AbortController,
  adapterHonorsAbort: boolean,
): Promise<GuardedResult<string>> {
  const guarded = await guardAttempt(
    (signal) => Promise.resolve(generate(prompt, signal)),
    timeoutMs,
    attempt,
    "LLM generation",
    adapterHonorsAbort,
  );
  if (!guarded.ok) {
    const kind: SynthesisFailureKind = guarded.aborted
      ? "generate_aborted"
      : /timed out/.test(guarded.reason)
        ? "generate_timeout"
        : "generate_exception";
    return { ...guarded, failureKind: kind };
  }
  if (typeof guarded.value !== "string") {
    return {
      ok: false,
      reason: `LLM generation returned non-string (typeof ${typeof guarded.value})`,
      failureKind: "generate_exception",
    };
  }
  return { ok: true, value: guarded.value };
}

export type SafeVerifyResult = VerifyResult & {
  readonly aborted?: boolean;
  readonly tainted?: boolean;
  readonly failureKind?: SynthesisFailureKind;
};

export async function safeVerify(
  verify: SynthesisConfig["verify"],
  code: string,
  descriptor: ToolDescriptor,
  timeoutMs: number,
  attempt: AbortController,
  adapterHonorsAbort: boolean,
): Promise<SafeVerifyResult> {
  const guarded = await guardAttempt(
    (signal) => Promise.resolve(verify(code, descriptor, signal)),
    timeoutMs,
    attempt,
    "Verifier",
    adapterHonorsAbort,
  );
  if (!guarded.ok) {
    const kind: SynthesisFailureKind = guarded.aborted
      ? "verify_aborted"
      : /timed out/.test(guarded.reason)
        ? "verify_timeout"
        : "verify_exception";
    return { ...guarded, failureKind: kind };
  }
  // Wrap coercion in try/catch: a hostile verifier may return an object
  // with throwing getters or other accessors that explode on property
  // reads. Convert any such throw into a typed failure rather than let
  // it escape past the typed-result contract.
  try {
    const coerced = coerceVerifyResult(guarded.value);
    if (!coerced.ok) {
      const kind: SynthesisFailureKind =
        coerced.cause === "rejected" ? "verify_rejected" : "verify_malformed";
      return { ok: false, reason: coerced.reason, tainted: true, failureKind: kind };
    }
    return coerced;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `Verifier returned hostile object: ${message}`,
      tainted: true,
      failureKind: "verify_exception",
    };
  }
}
