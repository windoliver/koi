/**
 * Main synthesis entry point.
 *
 * Runs `prompt → generate → parse → verify`. On parse-fail OR verify-fail,
 * builds a refinement prompt that carries the prior code and failure reason,
 * then re-enters the loop. Terminates after `maxAttempts` cycles or on the
 * first verified parse — whichever comes first.
 *
 * No I/O: both `generate` and `verify` are caller-injected callbacks.
 */

import type { ForgeVerificationSummary, ToolDescriptor } from "@koi/core";
import { parseSynthesisOutput } from "./parser.js";
import { buildRefinementPrompt } from "./prompts/refinement.js";
import { buildSynthesisPrompt } from "./prompts/synthesis.js";
import {
  DEFAULT_SYNTHESIS_CONFIG,
  FORGED_BY,
  type SynthesisConfig,
  type SynthesisInput,
  type SynthesisResult,
  type VerifyResult,
} from "./types.js";

export type SynthesisInitConfig = Partial<SynthesisConfig> &
  Pick<SynthesisConfig, "generate" | "verify">;

export async function synthesize(
  input: SynthesisInput,
  config: SynthesisInitConfig,
): Promise<SynthesisResult> {
  const requestedAttempts = config.maxAttempts ?? DEFAULT_SYNTHESIS_CONFIG.maxAttempts;
  if (requestedAttempts < 1) {
    return { ok: false, reason: "maxAttempts must be >= 1", attempts: 0 };
  }
  const clock = config.clock ?? DEFAULT_SYNTHESIS_CONFIG.clock;
  const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_SYNTHESIS_CONFIG.attemptTimeoutMs;
  const adapterHonorsAbort =
    config.adapterHonorsAbort ?? DEFAULT_SYNTHESIS_CONFIG.adapterHonorsAbort;
  const signal = config.signal;
  // Without a hard-cancel guarantee from the adapter, a timed-out attempt
  // may still be running when the next one starts, duplicating any side
  // effects (sandboxed exec, network calls). Force single-shot in that
  // case — the caller can opt in to retries by setting adapterHonorsAbort.
  const maxAttempts = adapterHonorsAbort ? requestedAttempts : 1;

  let priorCode = "";
  let priorReason = "";
  let lastReason = "no attempts ran";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      return { ok: false, reason: "Synthesis aborted by caller", attempts: attempt - 1 };
    }
    const prompt =
      attempt === 1
        ? buildSynthesisPrompt({
            candidate: input.candidate,
            targetToolName: input.targetToolName,
            targetToolSchema: input.targetToolSchema,
          })
        : buildRefinementPrompt({
            candidate: input.candidate,
            targetToolName: input.targetToolName,
            targetToolSchema: input.targetToolSchema,
            priorCode,
            priorReason,
            attempt,
          });

    const attemptController = new AbortController();
    const detach = linkSignal(signal, attemptController);
    try {
      const generated = await safeGenerate(
        config.generate,
        prompt,
        attemptTimeoutMs,
        attemptController,
      );
      if (!generated.ok) {
        lastReason = generated.reason;
        priorReason = generated.reason;
        priorCode = "";
        if (generated.aborted) {
          return { ok: false, reason: generated.reason, attempts: attempt };
        }
        continue;
      }

      const parsed = parseSynthesisOutput(generated.value, input.targetToolName);
      if (!parsed.ok) {
        lastReason = parsed.reason;
        priorReason = parsed.reason;
        priorCode = generated.value;
        continue;
      }

      const schemaCheck = checkSchemaMatch(
        parsed.value.descriptor.inputSchema,
        input.targetToolSchema,
      );
      if (!schemaCheck.ok) {
        lastReason = schemaCheck.reason;
        priorReason = schemaCheck.reason;
        priorCode = parsed.value.code;
        continue;
      }

      const verified = await safeVerify(
        config.verify,
        parsed.value.code,
        parsed.value.descriptor,
        attemptTimeoutMs,
        attemptController,
      );
      if (!verified.ok) {
        lastReason = verified.reason;
        priorReason = verified.reason;
        priorCode = parsed.value.code;
        if (verified.aborted) {
          return { ok: false, reason: verified.reason, attempts: attempt };
        }
        continue;
      }

      return {
        ok: true,
        value: {
          code: parsed.value.code,
          descriptor: parsed.value.descriptor,
          attempts: attempt,
          forgedBy: FORGED_BY,
          synthesizedAt: clock(),
          verification: verified.summary,
        },
      };
    } finally {
      // Cancel the attempt so any still-running callback observes the abort
      // (well-behaved adapters stop their work) and detach the linkSignal
      // listener so it does not leak across iterations.
      attemptController.abort();
      detach();
    }
  }

  return { ok: false, reason: lastReason, attempts: maxAttempts };
}

/**
 * Wire an external `signal` to a per-attempt `AbortController` so that
 * timeout, parent-cancel, or outer-loop completion all abort the same
 * controller — and the callbacks see one cancellation event regardless of
 * which side fired. Returns a detach function that the caller invokes when
 * the attempt resolves successfully (avoids dangling listeners).
 */
function linkSignal(external: AbortSignal | undefined, attempt: AbortController): () => void {
  if (!external) return () => undefined;
  if (external.aborted) {
    attempt.abort();
    return () => undefined;
  }
  const onAbort = (): void => attempt.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}

type GuardedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly aborted?: boolean };

async function safeGenerate(
  generate: SynthesisConfig["generate"],
  prompt: string,
  timeoutMs: number,
  attempt: AbortController,
): Promise<GuardedResult<string>> {
  const guarded = await guardAttempt(
    (signal) => Promise.resolve(generate(prompt, signal)),
    timeoutMs,
    attempt,
    "LLM generation",
  );
  if (!guarded.ok) return guarded;
  if (typeof guarded.value !== "string") {
    return {
      ok: false,
      reason: `LLM generation returned non-string (typeof ${typeof guarded.value})`,
    };
  }
  return { ok: true, value: guarded.value };
}

/**
 * Compare the synthesized descriptor's input schema against the requested
 * target schema. Performs structural equality on JSON-serializable values
 * (key-order independent for objects). Treats this as a hard invariant: if
 * the caller supplied a target schema, the artifact must match it exactly,
 * otherwise downstream callers receive the wrong input contract.
 */
function checkSchemaMatch(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>,
): { ok: true } | { ok: false; reason: string } {
  if (jsonEqual(actual, expected)) return { ok: true };
  return {
    ok: false,
    reason: "Synthesized descriptor.inputSchema does not match targetToolSchema",
  };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj).sort();
  const bKeys = Object.keys(bObj).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    const k = aKeys[i] as string;
    if (!jsonEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

async function safeVerify(
  verify: SynthesisConfig["verify"],
  code: string,
  descriptor: ToolDescriptor,
  timeoutMs: number,
  attempt: AbortController,
): Promise<VerifyResult & { readonly aborted?: boolean }> {
  const guarded = await guardAttempt(
    (signal) => Promise.resolve(verify(code, descriptor, signal)),
    timeoutMs,
    attempt,
    "Verifier",
  );
  if (!guarded.ok) return guarded;
  return coerceVerifyResult(guarded.value);
}

/**
 * Race a callback against a timeout and the per-attempt `AbortController`.
 * On timeout, the controller is aborted so a well-behaved callback can stop
 * its work and we never start a new attempt while the prior one runs. The
 * external (caller) signal is wired to the attempt controller upstream
 * (`linkSignal`), so the callback observes a single cancellation event
 * regardless of which side fired.
 *
 * `aborted: true` on the failure variant tells the loop to stop iterating;
 * timeouts return `aborted: undefined` so the loop continues to the next
 * attempt up to `maxAttempts`.
 */
function guardAttempt<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  attempt: AbortController,
  label: string,
): Promise<GuardedResult<T>> {
  return new Promise<GuardedResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: GuardedResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      attempt.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        timedOut = true;
        attempt.abort(); // signal the callback so it can stop its work
        finish({ ok: false, reason: `${label} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }

    const onAbort = (): void => {
      // Only treat external-driven aborts as cancellation. A timeout we fired
      // is reported separately above so the loop can continue retrying.
      if (timedOut) return;
      finish({ ok: false, reason: `${label} aborted by caller`, aborted: true });
    };
    if (attempt.signal.aborted) {
      onAbort();
      return;
    }
    attempt.signal.addEventListener("abort", onAbort, { once: true });

    try {
      run(attempt.signal).then(
        (value) => finish({ ok: true, value }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          finish({ ok: false, reason: `${label} failed: ${message}` });
        },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      finish({ ok: false, reason: `${label} failed: ${message}` });
    }
  });
}

/**
 * Validate `ForgeVerificationSummary` shape so downstream forge integrity
 * (`createForgeProvenance`) receives evidence with the contractual fields.
 * A malformed summary surfaces as a verifier failure here rather than as a
 * delayed error during publication, after the artifact has already been
 * treated as verified.
 */
function coerceVerificationSummary(
  value: unknown,
):
  | { readonly ok: true; readonly value: ForgeVerificationSummary }
  | { readonly ok: false; readonly reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "summary must be a JSON object" };
  }
  const obj = value as Record<string, unknown>;
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
  return { ok: true, value: value as ForgeVerificationSummary };
}

/**
 * Validate the shape of a value returned by an injected verifier. A
 * version-skewed or buggy adapter that resolves to `undefined`, `null`, or
 * an object missing the discriminator must not crash the synthesis loop —
 * the boundary's whole point is to keep this typed.
 */
function coerceVerifyResult(value: unknown): VerifyResult {
  if (value === null || typeof value !== "object") {
    return {
      ok: false,
      reason: `Verifier returned non-object (typeof ${typeof value})`,
    };
  }
  const obj = value as Record<string, unknown>;
  if (obj.ok === true) {
    if (obj.summary === undefined) return { ok: true };
    const summary = coerceVerificationSummary(obj.summary);
    if (!summary.ok) {
      return {
        ok: false,
        reason: `Verifier returned ok:true with malformed summary: ${summary.reason}`,
      };
    }
    if (!summary.value.passed) {
      // Cross-field invariant: ok:true cannot coexist with passed:false. A
      // verifier whose discriminator and evidence disagree is buggy; we fail
      // closed so callers don't promote artifacts whose own evidence says
      // verification failed.
      return {
        ok: false,
        reason: "Verifier returned ok:true with summary.passed:false",
      };
    }
    return { ok: true, summary: summary.value };
  }
  if (obj.ok === false) {
    const reason = typeof obj.reason === "string" ? obj.reason : "(no reason supplied)";
    return { ok: false, reason };
  }
  return {
    ok: false,
    reason: "Verifier returned malformed result (missing or non-boolean `ok`)",
  };
}
