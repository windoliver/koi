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

import type { ToolDescriptor } from "@koi/core";
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
  const maxAttempts = config.maxAttempts ?? DEFAULT_SYNTHESIS_CONFIG.maxAttempts;
  if (maxAttempts < 1) {
    return { ok: false, reason: "maxAttempts must be >= 1", attempts: 0 };
  }
  const clock = config.clock ?? DEFAULT_SYNTHESIS_CONFIG.clock;
  const attemptTimeoutMs = config.attemptTimeoutMs ?? DEFAULT_SYNTHESIS_CONFIG.attemptTimeoutMs;
  const signal = config.signal;

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

    const generated = await safeGenerate(config.generate, prompt, attemptTimeoutMs, signal);
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

    if (input.targetToolSchema !== undefined) {
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
    }

    const verified = await safeVerify(
      config.verify,
      parsed.value.code,
      parsed.value.descriptor,
      attemptTimeoutMs,
      signal,
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
      },
    };
  }

  return { ok: false, reason: lastReason, attempts: maxAttempts };
}

type GuardedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string; readonly aborted?: boolean };

async function safeGenerate(
  generate: SynthesisConfig["generate"],
  prompt: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<GuardedResult<string>> {
  const guarded = await guardAttempt(
    () => Promise.resolve(generate(prompt)),
    timeoutMs,
    signal,
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
  signal: AbortSignal | undefined,
): Promise<VerifyResult & { readonly aborted?: boolean }> {
  const guarded = await guardAttempt(
    () => Promise.resolve(verify(code, descriptor)),
    timeoutMs,
    signal,
    "Verifier",
  );
  if (!guarded.ok) return guarded;
  return coerceVerifyResult(guarded.value);
}

/**
 * Race a callback against a timeout and an external `AbortSignal`. Whichever
 * settles first wins; the caller cannot stop the underlying work (the
 * callback signature has no signal arg today), but the loop is freed from a
 * hung dependency and reports a typed reason. `aborted: true` on the failure
 * variant tells the loop to stop iterating instead of retrying.
 */
function guardAttempt<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<GuardedResult<T>> {
  return new Promise<GuardedResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: GuardedResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener("abort", abortListener);
      resolve(result);
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        finish({ ok: false, reason: `${label} timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }

    let abortListener: (() => void) | null = null;
    if (signal) {
      if (signal.aborted) {
        finish({ ok: false, reason: `${label} aborted by caller`, aborted: true });
        return;
      }
      abortListener = (): void => {
        finish({ ok: false, reason: `${label} aborted by caller`, aborted: true });
      };
      signal.addEventListener("abort", abortListener, { once: true });
    }

    try {
      run().then(
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
  if (obj.ok === true) return { ok: true };
  if (obj.ok === false) {
    const reason = typeof obj.reason === "string" ? obj.reason : "(no reason supplied)";
    return { ok: false, reason };
  }
  return {
    ok: false,
    reason: "Verifier returned malformed result (missing or non-boolean `ok`)",
  };
}
