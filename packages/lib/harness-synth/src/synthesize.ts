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
import type { ForgeCandidate } from "@koi/forge-types";
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
  Pick<SynthesisConfig, "generate" | "verify" | "adapterHonorsAbort">;

export async function synthesize(
  input: SynthesisInput,
  config: SynthesisInitConfig,
): Promise<SynthesisResult> {
  const requestedAttempts = config.maxAttempts ?? DEFAULT_SYNTHESIS_CONFIG.maxAttempts;
  if (requestedAttempts < 1) {
    return { ok: false, reason: "maxAttempts must be >= 1", attempts: 0 };
  }
  const clock = config.clock ?? DEFAULT_SYNTHESIS_CONFIG.clock;
  // adapterHonorsAbort is intentionally REQUIRED — callers must consciously
  // pick between strict (timeouts + caller cancellation honored end-to-end)
  // and best-effort (single-shot, timeouts disabled, mid-flight cancellation
  // ignored) modes. There is no safe default: a missing assertion on a
  // hanging adapter would otherwise pin the request indefinitely.
  const adapterHonorsAbort = config.adapterHonorsAbort;
  const signal = config.signal;
  const sanitizeVerifierReason =
    config.sanitizeVerifierReason ?? DEFAULT_SYNTHESIS_CONFIG.sanitizeVerifierReason;
  // Without a hard-cancel guarantee from the adapter, a timed-out attempt
  // may still be running when the next one starts, duplicating any side
  // effects (sandboxed exec, network calls). Force single-shot in that
  // case — the caller can opt in to retries by setting adapterHonorsAbort.
  const maxAttempts = adapterHonorsAbort ? requestedAttempts : 1;
  // Always enforce attemptTimeoutMs and external signal — even in best-effort
  // mode. Without a hard timer the loop can hang forever on a stuck adapter
  // (synthesize() never resolves), which is a worse availability failure than
  // the leaked-side-effects problem the timer was originally avoiding. In
  // best-effort mode the caller has explicitly accepted that a timed-out or
  // cancelled callback may keep running in the background — that is the cost
  // of using a non-abort-aware adapter — but the synthesize() call itself
  // resolves promptly so the request can be retried/abandoned at the caller.
  // We still force maxAttempts=1 so the loop never STARTS another attempt
  // while a prior one may be in flight.
  const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_SYNTHESIS_CONFIG.attemptTimeoutMs;
  // Validate attemptTimeoutMs explicitly. NaN slips past Number.isFinite()
  // checks downstream and would silently disable every deadline; 0 / negative
  // would fail every attempt instantly. Only positive finite numbers and
  // explicit Infinity (timeouts disabled by design) are accepted.
  if (
    typeof attemptTimeoutMs !== "number" ||
    Number.isNaN(attemptTimeoutMs) ||
    attemptTimeoutMs <= 0
  ) {
    return {
      ok: false,
      reason: "attemptTimeoutMs must be a positive finite number or Infinity",
      attempts: 0,
    };
  }

  // Validate that targetToolSchema is JSON-plain (no undefined / Infinity /
  // NaN / Date / class instances / cycles / BigInt / throwing getters).
  // A lossy JSON round-trip would silently rewrite the contract — instead
  // fail closed so the equality check downstream operates on the exact
  // value the caller supplied.
  const schemaCheck = ensureJsonPlain(input.targetToolSchema, "targetToolSchema");
  if (!schemaCheck.ok) {
    return { ok: false, reason: schemaCheck.reason, attempts: 0 };
  }
  // Defensively read the candidate fields we serialize into prompts. A
  // throwing getter, BigInt, or other non-JSON-safe value here would crash
  // buildSynthesisPrompt() and escape past the typed-result contract.
  // Snapshot into a frozen plain object up-front so prompt construction
  // never touches the original (potentially hostile) value again.
  const candidateSnapshot = snapshotCandidate(input.candidate);
  if (!candidateSnapshot.ok) {
    return { ok: false, reason: candidateSnapshot.reason, attempts: 0 };
  }
  const safeInput: SynthesisInput = { ...input, candidate: candidateSnapshot.value };

  let priorCode = "";
  let priorReason = "";
  let lastReason = "no attempts ran";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // Pre-flight abort check is only safe when no adapter work has started
    // yet OR the adapter honors abort. In best-effort mode we still respect
    // it before launching a new attempt (no work can be in flight here).
    if (signal?.aborted) {
      return { ok: false, reason: "Synthesis aborted by caller", attempts: attempt - 1 };
    }
    const prompt =
      attempt === 1
        ? buildSynthesisPrompt({
            candidate: safeInput.candidate,
            targetToolName: safeInput.targetToolName,
            targetToolSchema: safeInput.targetToolSchema,
          })
        : buildRefinementPrompt({
            candidate: safeInput.candidate,
            targetToolName: safeInput.targetToolName,
            targetToolSchema: safeInput.targetToolSchema,
            priorCode,
            priorReason,
            attempt,
          });

    const attemptController = new AbortController();
    // Always link the external signal so synthesize() resolves promptly when
    // the caller cancels — even in best-effort mode. A non-abort-aware
    // callback may keep running after we resolve; that is the documented
    // cost of `adapterHonorsAbort: false`. The alternative (ignoring the
    // signal) lets a stuck adapter pin the call indefinitely.
    const detach = linkSignal(signal, attemptController);
    // Single per-attempt deadline that covers generate + verify combined.
    // Without a shared budget, generate could consume attemptTimeoutMs and
    // then verify could consume it AGAIN, blowing through the documented
    // wall-clock cap by ~2x.
    const attemptStart = clock();
    const remainingMs = (): number => {
      if (!Number.isFinite(attemptTimeoutMs)) return attemptTimeoutMs;
      const used = clock() - attemptStart;
      return Math.max(0, attemptTimeoutMs - used);
    };
    try {
      const generated = await safeGenerate(
        config.generate,
        prompt,
        remainingMs(),
        attemptController,
      );
      if (!generated.ok) {
        lastReason = generated.reason;
        priorReason = redactReason(generated.reason);
        priorCode = "";
        if (generated.aborted) {
          return { ok: false, reason: generated.reason, attempts: attempt };
        }
        continue;
      }

      const parsed = parseSynthesisOutput(generated.value, safeInput.targetToolName);
      if (!parsed.ok) {
        lastReason = parsed.reason;
        priorReason = redactReason(parsed.reason);
        priorCode = generated.value;
        continue;
      }

      const schemaCheck = checkSchemaMatch(
        parsed.value.descriptor.inputSchema,
        safeInput.targetToolSchema,
      );
      if (!schemaCheck.ok) {
        lastReason = schemaCheck.reason;
        priorReason = redactReason(schemaCheck.reason);
        priorCode = parsed.value.code;
        continue;
      }

      const verified = await safeVerify(
        config.verify,
        parsed.value.code,
        parsed.value.descriptor,
        remainingMs(),
        attemptController,
      );
      if (!verified.ok) {
        lastReason = verified.reason;
        // Verifier reason crosses the trust boundary back into the LLM —
        // sanitize via caller-supplied hook (default replaces with a fixed
        // generic string), then apply redactReason as a defense-in-depth
        // length/control-char cap on whatever the sanitizer chose to emit.
        priorReason = redactReason(safeSanitize(sanitizeVerifierReason, verified.reason));
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
/**
 * Sanitize a failure reason before it is forwarded to the LLM in the
 * refinement prompt. Verifier callbacks are caller-injected and may return
 * arbitrary diagnostic text — sandbox stderr, stack traces, fixture values —
 * that the synthesis loop would otherwise retransmit verbatim to the model
 * provider on retry. We strip control characters (which model tokenizers
 * either drop or render as garbage anyway) and cap length so a single
 * verbose failure cannot blow out the next prompt's token budget. Callers
 * that want stricter redaction should sanitize inside their `verify`
 * implementation before returning the reason string.
 */
/**
 * Run a caller-supplied sanitizer without letting a buggy implementation
 * propagate exceptions or return non-string values past the trust boundary.
 * Failure here means we fall back to a fixed generic string rather than
 * forwarding the raw verifier reason — the whole point of the sanitizer is
 * to keep verifier text out of the model retry prompt.
 */
function safeSanitize(sanitize: (reason: string) => string, reason: string): string {
  try {
    const out = sanitize(reason);
    if (typeof out !== "string") return "verification failed (reason omitted)";
    return out;
  } catch {
    return "verification failed (reason omitted)";
  }
}

/**
 * Read the prompt-relevant candidate fields behind a try/catch and validate
 * each one is JSON-plain before they reach the prompt builders. Returns a
 * frozen snapshot so prompt construction never re-reads a hostile value.
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

function redactReason(reason: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping is the point
  const cleaned = reason.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
  const MAX = 240;
  if (cleaned.length <= MAX) return cleaned;
  return `${cleaned.slice(0, MAX)}… [truncated ${cleaned.length - MAX} chars]`;
}

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

/**
 * Walk a value and confirm it is composed only of JSON-plain primitives:
 * `null`, finite numbers, strings, booleans, arrays of plain values, and
 * plain object literals (own enumerable string keys). Rejects `undefined`,
 * `NaN`, `Infinity`, `BigInt`, functions, symbols, class instances, cycles,
 * and throwing getters. Used to enforce that public API inputs are exactly
 * the contract the caller supplied — no lossy normalization.
 */
function ensureJsonPlain(
  value: unknown,
  label: string,
): { ok: true } | { ok: false; reason: string } {
  const seen = new WeakSet<object>();
  return walk(value, label);

  function walk(v: unknown, path: string): { ok: true } | { ok: false; reason: string } {
    if (v === null) return { ok: true };
    const t = typeof v;
    if (t === "string" || t === "boolean") return { ok: true };
    if (t === "number") {
      if (!Number.isFinite(v)) {
        return { ok: false, reason: `${path} contains non-finite number` };
      }
      return { ok: true };
    }
    if (t === "bigint") return { ok: false, reason: `${path} contains bigint` };
    if (t === "function") return { ok: false, reason: `${path} contains function` };
    if (t === "symbol") return { ok: false, reason: `${path} contains symbol` };
    if (t === "undefined") return { ok: false, reason: `${path} contains undefined` };
    if (t !== "object") return { ok: false, reason: `${path} contains non-JSON value` };
    const obj = v as object;
    if (seen.has(obj)) return { ok: false, reason: `${path} contains a cycle` };
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i += 1) {
        const r = walk(obj[i], `${path}[${i}]`);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype) {
      return { ok: false, reason: `${path} is not a plain object literal` };
    }
    let keys: string[];
    try {
      keys = Object.keys(obj);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `${path} key access threw: ${message}` };
    }
    for (const k of keys) {
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[k];
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `${path}.${k} getter threw: ${message}` };
      }
      const r = walk(child, `${path}.${k}`);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
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
  // Wrap coercion in try/catch: a hostile verifier may return an object with
  // throwing getters or other accessors that explode on property reads. The
  // boundary's whole purpose is to keep buggy adapters from crashing the
  // loop, so we convert any such throw into a typed failure rather than let
  // it escape past the typed-result contract.
  try {
    return coerceVerifyResult(guarded.value);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Verifier returned hostile object: ${message}` };
  }
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

    // Fail closed when the budget is already exhausted. setTimeout(fn, 0)
    // would queue the timer behind the microtask that resolves run()'s
    // promise, so a stage entered with no budget left could still execute
    // and even succeed before the timer fires — defeating the wall-clock
    // cap and launching side effects past the attempt deadline.
    if (Number.isFinite(timeoutMs) && timeoutMs <= 0) {
      attempt.abort();
      resolve({ ok: false, reason: `${label} timed out after 0ms` });
      return;
    }
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
  // Validate JSON-plainness on every additional field so downstream
  // provenance (which rejects non-plain values) receives a safe payload,
  // but DO preserve verifier-supplied evidence — digests, attestation
  // ids, etc. — instead of silently dropping fields. A non-plain extra
  // is an error here, not a silent strip.
  const plainCheck = ensureJsonPlain(value, "summary");
  if (!plainCheck.ok) {
    return { ok: false, reason: plainCheck.reason };
  }
  for (let i = 0; i < obj.stageResults.length; i += 1) {
    const stagePlain = ensureJsonPlain(obj.stageResults[i], `summary.stageResults[${i}]`);
    if (!stagePlain.ok) {
      return { ok: false, reason: stagePlain.reason };
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
